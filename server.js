require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);
app.use(session({
  secret: 'room42-secret-2026',
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 วัน — ไม่ต้อง login ใหม่
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// ─── FILES ───────────────────────────────────────────────
const USERS_FILE = './users.json';
const CHAT_FILE  = './chat.json';
const HW_FILE    = './homework.json';

function readJson(file, def) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def)); return def; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function getUsers() { return readJson(USERS_FILE, {}); }
function saveUsers(u) { writeJson(USERS_FILE, u); }
function getChat()  { return readJson(CHAT_FILE, []); }
function saveChat(c) { writeJson(CHAT_FILE, c); }
function getHW()    { return readJson(HW_FILE, []); }
function saveHW(h)  { writeJson(HW_FILE, h); }

// ─── SSE broadcast ───────────────────────────────────────
const sseChat = new Set();
const sseHW   = new Set();

function broadcast(clients, data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(res => { try { res.write(msg); } catch { clients.delete(res); } });
}

// ─── TIME ────────────────────────────────────────────────
function thaiNow() {
  const now = new Date();
  return {
    time: now.toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Bangkok' }),
    date: now.toLocaleDateString('th-TH', { day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Bangkok' }),
    iso:  now.toISOString()
  };
}

// ─── MIDDLEWARE ──────────────────────────────────────────
const auth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.status(401).json({ ok: false, msg: 'กรุณาเข้าสู่ระบบ' });
};

// ─── ROUTES ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ME — เช็ก session ยังอยู่ไหม
app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json({ ok: true, user: req.session.user });
  res.json({ ok: false });
});

// REGISTER
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName)
    return res.json({ ok: false, msg: 'กรอกให้ครบนะ' });
  if (username.length < 2) return res.json({ ok: false, msg: 'username อย่างน้อย 2 ตัว' });
  if (password.length < 4) return res.json({ ok: false, msg: 'รหัสผ่านอย่างน้อย 4 ตัว' });
  const users = getUsers();
  if (users[username]) return res.json({ ok: false, msg: 'ชื่อผู้ใช้นี้มีแล้ว' });
  users[username] = { password, displayName: displayName.trim(), createdAt: new Date().toISOString() };
  saveUsers(users);
  req.session.user = { username, displayName: displayName.trim() };
  res.json({ ok: true });
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  const u = users[username];
  if (!u || u.password !== password) return res.json({ ok: false, msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  req.session.user = { username, displayName: u.displayName };
  res.json({ ok: true });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── CHAT ─────────────────────────────────────────────────
app.get('/api/chat', auth, (req, res) => {
  res.json(getChat().slice(-100)); // ล่าสุด 100 ข้อความ
});

app.post('/api/chat', auth, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ ok: false });
  const t = thaiNow();
  const msg = {
    id: Date.now(),
    username: req.session.user.username,
    displayName: req.session.user.displayName,
    text: text.trim(),
    time: t.time,
    date: t.date,
    iso: t.iso
  };
  const chat = getChat();
  chat.push(msg);
  if (chat.length > 500) chat.splice(0, chat.length - 500);
  saveChat(chat);
  broadcast(sseChat, { type: 'msg', msg });
  res.json({ ok: true, msg });
});

app.delete('/api/chat/:id', auth, (req, res) => {
  const id = parseInt(req.params.id);
  let chat = getChat();
  const idx = chat.findIndex(m => m.id === id);
  if (idx === -1) return res.json({ ok: false });
  if (chat[idx].username !== req.session.user.username)
    return res.json({ ok: false, msg: 'ลบได้แค่ของตัวเองนะ' });
  chat.splice(idx, 1);
  saveChat(chat);
  broadcast(sseChat, { type: 'delete', id });
  res.json({ ok: true });
});

// SSE — chat
app.get('/api/chat/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"ping"}\n\n');
  sseChat.add(res);
  req.on('close', () => sseChat.delete(res));
});

// ─── HOMEWORK NOTES ───────────────────────────────────────
app.get('/api/hw', auth, (req, res) => {
  res.json(getHW().slice(-200));
});

app.post('/api/hw', auth, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ ok: false });
  const t = thaiNow();
  const note = {
    id: Date.now(),
    username: req.session.user.username,
    displayName: req.session.user.displayName,
    text: text.trim(),
    time: t.time,
    date: t.date,
    iso: t.iso
  };
  const hw = getHW();
  hw.push(note);
  if (hw.length > 1000) hw.splice(0, hw.length - 1000);
  saveHW(hw);
  broadcast(sseHW, { type: 'note', note });
  res.json({ ok: true, note });
});

app.delete('/api/hw/:id', auth, (req, res) => {
  const id = parseInt(req.params.id);
  let hw = getHW();
  const idx = hw.findIndex(n => n.id === id);
  if (idx === -1) return res.json({ ok: false });
  if (hw[idx].username !== req.session.user.username)
    return res.json({ ok: false, msg: 'ลบได้แค่ของตัวเองนะ' });
  hw.splice(idx, 1);
  saveHW(hw);
  broadcast(sseHW, { type: 'delete', id });
  res.json({ ok: true });
});

// SSE — homework
app.get('/api/hw/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: {"type":"ping"}\n\n');
  sseHW.add(res);
  req.on('close', () => sseHW.delete(res));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ ห้อง 4/2 running on port ' + PORT));
