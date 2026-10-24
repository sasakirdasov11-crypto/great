const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const MAX_USERS = 12;
const ADMIN_USERNAME = 'great_228';

const DB_FILE = path.join(__dirname, 'users.json');
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users: {}, chats: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {}, chats: {} }; }
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}
let db = loadDB();

if (!db.users) db.users = {};
if (!db.chats) db.chats = {};

// Создаем админа, если его нет
if (!db.users[ADMIN_USERNAME]) {
  db.users[ADMIN_USERNAME] = { 
    username: ADMIN_USERNAME, role: 'admin', blocked: false, 
    createdAt: Date.now(), lastSeen: Date.now(), bio: 'Создатель GREAT', color: '#2aabee', dnd: false 
  };
  saveDB();
}

// Служебный чат "Избранное" (для каждого пользователя)
function getFavKey(username) { return 'fav::' + username; }

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const online = new Map();

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(data) { for (const ws of online.values()) send(ws, data); }
function userPublic(u) { 
  return { 
    username: u.username, role: u.role, blocked: !!u.blocked, 
    online: online.has(u.username) && !u.dnd, 
    onlineRaw: online.has(u.username),
    lastSeen: u.lastSeen || u.createdAt, bio: u.bio || '', color: u.color || '#2aabee', dnd: !!u.dnd 
  }; 
}
function chatKey(a, b) { return [a, b].sort().join('::'); }

wss.on('connection', (ws) => {
  let me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- РЕГИСТРАЦИЯ / ВХОД ---
    if (msg.type === 'register') {
      const name = String(msg.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (name.length < 3) return send(ws, { type: 'error', text: 'Минимум 3 символа' });
      let user = db.users[name];
      if (!user) {
        if (Object.keys(db.users).length >= MAX_USERS) return send(ws, { type: 'error', text: 'Лимит 12 пользователей' });
        user = { username: name, role: 'user', blocked: false, createdAt: Date.now(), lastSeen: Date.now(), bio: '', color: '#2aabee', dnd: false };
        db.users[name] = user; saveDB();
      }
      if (user.blocked) return send(ws, { type: 'error', text: 'Вы заблокированы админом' });
      
      me = name; online.set(name, ws);
      db.users[name].lastSeen = Date.now(); saveDB();
      
      send(ws, { type: 'auth_ok', me: userPublic(user) });
      broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) });
      
      // Отправляем список чатов
      const myChats = [];
      Object.keys(db.chats).forEach(k => {
        if (db.chats[k].participants.includes(me)) myChats.push(k);
      });
      send(ws, { type: 'my_chats', chats: myChats.map(k => ({ key: k, messages: db.chats[k].messages })) });
      return;
    }

    if (!me) return;
    const meUser = db.users[me];
    db.users[me].lastSeen = Date.now();

    // --- НАСТРОЙКИ ПРОФИЛЯ ---
    if (msg.type === 'update_profile') {
      if (msg.bio !== undefined) db.users[me].bio = String(msg.bio).slice(0, 100);
      if (msg.color) db.users[me].color = String(msg.color).slice(0, 7);
      if (msg.dnd !== undefined) db.users[me].dnd = !!msg.dnd;
      saveDB();
      send(ws, { type: 'auth_ok', me: userPublic(db.users[me]) });
      broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) });
      return;
    }

    // --- ОТКРЫТИЕ ЧАТА И ПРОЧТЕНИЕ ---
    if (msg.type === 'open_chat') {
      const other = String(msg.with || '').toLowerCase();
      let key = (other === 'favorites') ? getFavKey(me) : chatKey(me, other);
      
      if (!db.chats[key]) db.chats[key] = { participants: (other === 'favorites') ? [me] : [me, other].sort(), messages: [] };
      
      let updated = false;
      db.chats[key].messages.forEach(m => {
        if (m.to === me && !m.read) { m.read = true; updated = true; }
      });
      if (updated) {
        saveDB();
        if (online.has(other)) send(online.get(other), { type: 'chat_history', with: me, messages: db.chats[key].messages });
      }
      send(ws, { type: 'chat_history', with: other, messages: db.chats[key].messages });
    }

    // --- ОТПРАВКА СООБЩЕНИЙ ---
    if (msg.type === 'send_message') {
      const other = String(msg.to || '').toLowerCase();
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!text) return;
      
      let key = (other === 'favorites') ? getFavKey(me) : chatKey(me, other);
      if (other !== 'favorites' && !db.users[other]) return;
      
      if (!db.chats[key]) db.chats[key] = { participants: (other === 'favorites') ? [me] : [me, other].sort(), messages: [] };
      
      const message = { 
        id: Date.now() + '' + Math.floor(Math.random()*1000), from: me, to: other, text, time: Date.now(),
        read: (other === 'favorites'), replyTo: msg.replyTo || null, reactions: {}
      };
      db.chats[key].messages.push(message); saveDB();
      
      if (online.has(other)) {
        send(online.get(other), { type: 'new_message', message });
        // Обновляем список чатов у получателя
        send(online.get(other), { type: 'update_chat_list', chatKey: key, lastMsg: message });
      }
      send(ws, { type: 'new_message', message });
      send(ws, { type: 'update_chat_list', chatKey: key, lastMsg: message });
    }

    // --- РЕАКЦИИ И УДАЛЕНИЕ ---
    if (msg.type === 'delete_message') {
      const other = String(msg.to || '').toLowerCase();
      let key = (other === 'favorites') ? getFavKey(me) : chatKey(me, other);
      if (!db.chats[key]) return;
      const idx = db.chats[key].messages.findIndex(m => m.id === msg.id);
      if (idx !== -1 && (db.chats[key].messages[idx].from === me || meUser.role === 'admin')) {
        db.chats[key].messages.splice(idx, 1); saveDB();
        send(ws, { type: 'chat_history', with: other, messages: db.chats[key].messages });
        if (online.has(other)) send(online.get(other), { type: 'chat_history', with: me, messages: db.chats[key].messages });
      }
    }

    if (msg.type === 'react_message') {
      const other = String(msg.to || '').toLowerCase();
      let key = (other === 'favorites') ? getFavKey(me) : chatKey(me, other);
      if (!db.chats[key]) return;
      const m = db.chats[key].messages.find(x => x.id === msg.id);
      if (!m) return;
      if (!m.reactions) m.reactions = {};
      m.reactions[me] = msg.emoji;
      saveDB();
      send(ws, { type: 'chat_history', with: other, messages: db.chats[key].messages });
      if (online.has(other)) send(online.get(other), { type: 'chat_history', with: me, messages: db.chats[key].messages });
    }

    if (msg.type === 'clear_chat') {
      const other = String(msg.to || '').toLowerCase();
      let key = (other === 'favorites') ? getFavKey(me) : chatKey(me, other);
      if (db.chats[key]) {
        db.chats[key].messages = []; saveDB();
        send(ws, { type: 'chat_history', with: other, messages: [] });
        if (online.has(other)) send(online.get(other), { type: 'chat_history', with: me, messages: [] });
      }
    }

    // --- СТАТУС "ПЕЧАТАЕТ" ---
    if (msg.type === 'typing') {
      const other = String(msg.to || '').toLowerCase();
      if (online.has(other)) send(online.get(other), { type: 'typing', from: me, to: other });
    }

    // --- АДМИН ---
    if (meUser.role === 'admin') {
      if (msg.type === 'admin_users') send(ws, { type: 'admin_users', users: Object.values(db.users).map(userPublic) });
      if (msg.type === 'admin_block') {
        const target = String(msg.username).toLowerCase();
        if (target === me || !db.users[target]) return;
        db.users[target].blocked = !!msg.blocked; saveDB();
        if (db.users[target].blocked && online.has(target)) { send(online.get(target), { type: 'error', text: 'Вы заблокированы' }); online.get(target).close(); }
        broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) });
        send(ws, { type: 'admin_users', users: Object.values(db.users).map(userPublic) });
      }
      if (msg.type === 'admin_delete') {
        const target = String(msg.username).toLowerCase();
        if (target === me || !db.users[target]) return;
        delete db.users[target]; saveDB();
        Object.keys(db.chats).forEach(k => { if (db.chats[k].participants.includes(target)) delete db.chats[k]; });
        if (online.has(target)) { send(online.get(target), { type: 'error', text: 'Аккаунт удалён' }); online.get(target).close(); }
        broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) });
        send(ws, { type: 'admin_users', users: Object.values(db.users).map(userPublic) });
      }
      if (msg.type === 'admin_chats') {
        const pairs = Object.keys(db.chats).map(k => {
          const p = db.chats[k].participants;
          return { key: k, participants: p.length === 1 ? [p[0], 'Избранное'] : p, count: db.chats[k].messages.length, last: db.chats[k].messages.slice(-1)[0] || null };
        });
        send(ws, { type: 'admin_chats', chats: pairs });
      }
      if (msg.type === 'admin_read_chat') send(ws, { type: 'admin_chat_content', key: msg.key, messages: db.chats[msg.key]?.messages || [] });
    }
  });

  ws.on('close', () => {
    if (me) { 
      db.users[me].lastSeen = Date.now(); saveDB(); online.delete(me); 
      broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) }); 
    }
  });
});
server.listen(PORT, () => console.log('GREAT v0.2.0 server started'));
