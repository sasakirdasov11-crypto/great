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

if (!db.users[ADMIN_USERNAME]) {
  db.users[ADMIN_USERNAME] = { username: ADMIN_USERNAME, role: 'admin', blocked: false, createdAt: Date.now() };
  saveDB();
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const online = new Map();

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(data) { for (const ws of online.values()) send(ws, data); }
function userPublic(u) { return { username: u.username, role: u.role, blocked: !!u.blocked, online: online.has(u.username) }; }
function chatKey(a, b) { return [a, b].sort().join('::'); }

wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      const name = String(msg.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (name.length < 3) return send(ws, { type: 'error', text: 'Минимум 3 символа' });
      let user = db.users[name];
      if (!user) {
        if (Object.keys(db.users).length >= MAX_USERS) return send(ws, { type: 'error', text: 'Лимит 12 пользователей' });
        user = { username: name, role: 'user', blocked: false, createdAt: Date.now() };
        db.users[name] = user; saveDB();
      }
      if (user.blocked) return send(ws, { type: 'error', text: 'Заблокирован админом' });
      me = name; online.set(name, ws);
      send(ws, { type: 'auth_ok', me: userPublic(user) });
      broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) });
      return;
    }

    if (!me) return;
    const meUser = db.users[me];

    if (msg.type === 'open_chat') {
      const other = String(msg.with || '').toLowerCase();
      if (!db.users[other]) return;
      const key = chatKey(me, other);
      if (!db.chats[key]) db.chats[key] = { participants: [me, other].sort(), messages: [] };
      send(ws, { type: 'chat_history', with: other, messages: db.chats[key].messages });
    }

    if (msg.type === 'send_message') {
      const other = String(msg.to || '').toLowerCase();
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!text || !db.users[other]) return;
      const key = chatKey(me, other);
      if (!db.chats[key]) db.chats[key] = { participants: [me, other].sort(), messages: [] };
      const message = { from: me, to: other, text, time: Date.now() };
      db.chats[key].messages.push(message); saveDB();
      if (online.has(other)) send(online.get(other), { type: 'new_message', message });
      send(ws, { type: 'new_message', message });
    }

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
        const pairs = Object.keys(db.chats).map(k => ({ key: k, participants: db.chats[k].participants, count: db.chats[k].messages.length, last: db.chats[k].messages.slice(-1)[0] || null }));
        send(ws, { type: 'admin_chats', chats: pairs });
      }
      if (msg.type === 'admin_read_chat') send(ws, { type: 'admin_chat_content', key: msg.key, messages: db.chats[msg.key]?.messages || [] });
    }
  });

  ws.on('close', () => {
    if (me) { online.delete(me); broadcast({ type: 'online_list', users: Object.values(db.users).map(userPublic) }); }
  });
});
server.listen(PORT, () => console.log('GREAT server started'));