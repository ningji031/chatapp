const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'chatapp_jwt_secret_2026';
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// 托管前端静态文件
const clientPath = path.join(__dirname, 'client');
app.use(express.static(clientPath));
app.get('/', (req, res) => res.sendFile(path.join(clientPath, 'index.html')));

// ─── sql.js 初始化 ──────────────────────────────────────────────
let db;
const dbPath = path.join(__dirname, 'chat.db');

(async () => {
  const SQL = await initSqlJs();
  try {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
  } catch {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS private_messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  // 创建默认聊天室
  const defaultRooms = [
    { id: 'general', name: '大厅',     desc: '欢迎来到聊天大厅！' },
    { id: 'tech',    name: '技术交流', desc: '讨论技术话题' },
    { id: 'random',  name: '闲聊水区', desc: '随便聊聊' }
  ];
  defaultRooms.forEach(r => {
    db.run(`INSERT OR IGNORE INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, 'system')`, [r.id, r.name, r.desc]);
  });

  saveDb();
})();

function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// Helper: 执行查询
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  const hasRow = stmt.step();
  const result = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// ─── HTTP 路由 ──────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2~20 位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    const existing = get('SELECT * FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: '用户名已被占用' });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
    run('INSERT INTO users (id, username, password, avatar) VALUES (?, ?, ?, ?)', [id, username, hashed, avatar]);
    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username, avatar } });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

// 健康检查（Railway 需要）
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/rooms', (req, res) => {
  res.json(all('SELECT id, name, description, created_at FROM rooms ORDER BY created_at ASC'));
});

app.get('/api/users', authMiddleware, (req, res) => {
  res.json(all('SELECT id, username, avatar FROM users ORDER BY username ASC'));
});

app.get('/api/private/:userId', authMiddleware, (req, res) => {
  const me = req.user.id;
  const other = req.params.userId;
  const msgs = all(
    'SELECT * FROM private_messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY created_at ASC LIMIT 100',
    [me, other, other, me]
  );
  res.json(msgs);
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
}

// ─── Socket.io ──────────────────────────────────────────────────
const onlineUsers = new Map();
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('未登录'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = get('SELECT id, username, avatar FROM users WHERE id = ?', [payload.id]);
    if (!user) return next(new Error('用户不存在'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Token 无效'));
  }
});

io.on('connection', (socket) => {
  const { id, username, avatar } = socket.user;
  onlineUsers.set(socket.id, { id, username, avatar });
  broadcastOnlineUsers();
  console.log(`[+] ${username} 上线`);

  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    const msgs = all('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 50', [roomId]).reverse();
    socket.emit('room_history', { roomId, messages: msgs });
    socket.to(roomId).emit('system_message', { roomId, text: `${username} 加入了频道`, time: Date.now() });
  });

  socket.on('leave_room', (roomId) => {
    socket.leave(roomId);
  });

  socket.on('send_message', ({ roomId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = {
      id: uuidv4(),
      room_id: roomId,
      sender_id: id,
      sender_name: username,
      content: content.trim(),
      type,
      created_at: Math.floor(Date.now() / 1000)
    };
    run('INSERT INTO messages (id, room_id, sender_id, sender_name, content, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [msg.id, msg.room_id, msg.sender_id, msg.sender_name, msg.content, msg.type, msg.created_at]);
    io.to(roomId).emit('new_message', msg);
  });

  socket.on('send_private', ({ toUserId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = {
      id: uuidv4(),
      from_id: id,
      to_id: toUserId,
      content: content.trim(),
      type,
      created_at: Math.floor(Date.now() / 1000)
    };
    run('INSERT INTO private_messages (id, from_id, to_id, content, type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [msg.id, msg.from_id, msg.to_id, msg.content, msg.type, msg.created_at]);
    const target = [...onlineUsers.entries()].find(([, u]) => u.id === toUserId);
    if (target) io.to(target[0]).emit('new_private', msg);
    socket.emit('new_private', msg);
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('user_typing', { userId: id, username, isTyping });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
    console.log(`[-] ${username} 下线`);
  });
});

function broadcastOnlineUsers() {
  const users = [...onlineUsers.values()].map(({ id, username, avatar }) => ({ id, username, avatar }));
  io.emit('online_users', users);
}

// ─── 启动 ────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ChatApp 启动: http://0.0.0.0:${PORT}`);
});
