const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'chatapp_jwt_secret_2026';
const PORT = process.env.PORT || 3001;

// ─── PostgreSQL 连接池 ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ─── 数据库工具函数 ──────────────────────────────────────────────
let dbConnected = false;

async function run(sql, params = []) {
  if (!dbConnected) throw new Error('数据库未连接');
  await pool.query(sql, params);
}

async function getOne(sql, params = []) {
  if (!dbConnected) return null;
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function getAll(sql, params = []) {
  if (!dbConnected) return [];
  const result = await pool.query(sql, params);
  return result.rows;
}

// ─── 初始化数据库 ────────────────────────────────────────────────
async function initDb() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
    )`,
    `CREATE TABLE IF NOT EXISTS private_messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text',
      read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW())
    )`,
  ];
  for (const sql of tables) {
    await pool.query(sql);
  }

  const defaults = [
    { id: 'general', name: '大厅',     desc: '欢迎来到聊天大厅！' },
    { id: 'tech',    name: '技术交流', desc: '讨论技术话题' },
    { id: 'random',  name: '闲聊水区', desc: '随便聊聊' },
  ];
  for (const r of defaults) {
    await pool.query(
      `INSERT INTO rooms(id, name, description, created_by)
       VALUES($1,$2,$3,'system')
       ON CONFLICT(id) DO NOTHING`,
      [r.id, r.name, r.desc]
    );
  }

  console.log('[db] PostgreSQL 数据库初始化完成 ✓');
}

// ─── Express 中间件 ─────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// 托管前端静态文件
const clientPath = path.join(__dirname, 'client');
app.use(express.static(clientPath));
app.get('/', (req, res) => res.sendFile(path.join(clientPath, 'index.html')));

// ─── 诊断路由（不需要数据库）────────────────────────────────────
app.get('/health', async (_req, res) => {
  const info = {
    status: 'ok',
    uptime: process.uptime(),
    env: {
      PORT: process.env.PORT,
      DATABASE_URL_EXISTS: !!process.env.DATABASE_URL,
      DATABASE_URL_PREFIX: process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 30) + '...' : 'NOT SET',
      JWT_SECRET_EXISTS: !!process.env.JWT_SECRET,
    },
    dbConnected,
    nodeVersion: process.version,
    memory: process.memoryUsage(),
  };

  // 尝试数据库连接
  if (process.env.DATABASE_URL) {
    try {
      const result = await pool.query('SELECT 1 as test');
      info.dbTest = { success: true, result: result.rows };
    } catch (e) {
      info.dbTest = { success: false, error: e.message };
    }
  }

  res.json(info);
});

// ─── JWT 鉴权中间件 ───────────────────────────────────────────
async function authMw(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
}

// ─── REST API ───────────────────────────────────────────────────

// 注册
app.post('/api/register', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: '数据库服务暂不可用，请稍后重试' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2~20 位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    const exists = await getOne('SELECT id FROM users WHERE username = $1', [username]);
    if (exists) return res.status(400).json({ error: '用户名已被占用' });

    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
    await run('INSERT INTO users(id, username, password, avatar) VALUES($1,$2,$3,$4)', [id, username, hashed, avatar]);

    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username, avatar } });
  } catch (e) {
    console.error('Register:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  if (!dbConnected) return res.status(503).json({ error: '数据库服务暂不可用，请稍后重试' });
  const { username, password } = req.body;
  try {
    const user = await getOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
  } catch (e) {
    console.error('Login:', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 频道列表
app.get('/api/rooms', async (_req, res) => {
  const rows = await getAll('SELECT id, name, description, created_at FROM rooms ORDER BY created_at ASC');
  res.json(rows);
});

// 用户列表
app.get('/api/users', authMw, async (_req, res) => {
  const rows = await getAll('SELECT id, username, avatar FROM users ORDER BY username ASC');
  res.json(rows);
});

// 私聊记录
app.get('/api/private/:userId', authMw, async (req, res) => {
  const me = req.user.id, other = req.params.userId;
  const rows = await getAll(
    `SELECT * FROM private_messages
     WHERE (from_id=$1 AND to_id=$2) OR (from_id=$3 AND to_id=$4)
     ORDER BY created_at ASC LIMIT 100`,
    [me, other, other, me]
  );
  res.json(rows);
});

// ─── Socket.io ──────────────────────────────────────────────────
const onlineUsers = new Map();

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.use(async (socket, next) => {
  const t = socket.handshake.auth.token;
  if (!t) return next(new Error('未登录'));
  try {
    const p = jwt.verify(t, JWT_SECRET);
    const u = await getOne('SELECT id, username, avatar FROM users WHERE id=$1', [p.id]);
    if (!u) return next(new Error('用户不存在'));
    socket.user = u;
    next();
  } catch {
    next(new Error('Token 无效'));
  }
});

io.on('connection', (s) => {
  const { id, username, avatar } = s.user;
  onlineUsers.set(s.id, { id, username, avatar });
  broadcastOnline();
  console.log(`[+] ${username} 在线`);

  s.on('join_room', async (rid) => {
    s.join(rid);
    const msgs = await getAll(
      'SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 50',
      [rid]
    );
    s.emit('room_history', { roomId: rid, messages: msgs.reverse() });
    s.to(rid).emit('system_message', { roomId: rid, text: `${username} 加入频道` });
  });

  s.on('leave_room', (rid) => s.leave(rid));

  s.on('send_message', async ({ roomId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = {
      id: uuidv4(), room_id: roomId, sender_id: id, sender_name: username,
      content: content.trim(), type,
      created_at: Math.floor(Date.now() / 1000)
    };
    await run(
      'INSERT INTO messages(id, room_id, sender_id, sender_name, content, type, created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [msg.id, msg.room_id, msg.sender_id, msg.sender_name, msg.content, msg.type, msg.created_at]
    );
    io.to(roomId).emit('new_message', msg);
  });

  s.on('send_private', async ({ toUserId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = {
      id: uuidv4(), from_id: id, to_id: toUserId,
      content: content.trim(), type,
      created_at: Math.floor(Date.now() / 1000)
    };
    await run(
      'INSERT INTO private_messages(id, from_id, to_id, content, type, created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [msg.id, msg.from_id, msg.to_id, msg.content, msg.type, msg.created_at]
    );
    const tgt = [...onlineUsers.entries()].find(([, u]) => u.id === toUserId);
    if (tgt) io.to(tgt[0]).emit('new_private', msg);
    s.emit('new_private', msg);
  });

  s.on('typing', ({ roomId, isTyping }) => {
    s.to(roomId).emit('user_typing', { userId: id, username, isTyping });
  });

  s.on('disconnect', () => {
    onlineUsers.delete(s.id);
    broadcastOnline();
    console.log(`[-] ${username} 离线`);
  });
});

function broadcastOnline() {
  io.emit('online_users', [...onlineUsers.values()].map(({ id, username, avatar }) => ({ id, username, avatar })));
}

// ─── 启动 ────────────────────────────────────────────────────────
(async () => {
  let retries = 0;
  const maxRetries = 10;

  while (retries < maxRetries) {
    try {
      console.log(`[db] 尝试连接 PostgreSQL (第 ${retries + 1} 次)...`);
      console.log(`[db] DATABASE_URL 是否存在: ${!!process.env.DATABASE_URL}`);
      if (process.env.DATABASE_URL) {
        console.log(`[db] DATABASE_URL 前缀: ${process.env.DATABASE_URL.substring(0, 40)}...`);
      }
      await pool.query('SELECT 1');
      console.log('[db] PostgreSQL 连接成功 ✓');

      await initDb();
      dbConnected = true;
      console.log('[db] 数据库初始化完成 ✓');
      break;
    } catch (e) {
      retries++;
      console.error(`[db] 连接失败 (${retries}/${maxRetries}):`, e.message);
      if (retries >= maxRetries) {
        console.error('[db] 已达到最大重试次数，数据库功能不可用');
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // 无论数据库是否连接成功，都启动 HTTP 服务器（避免 Railway 502）
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ ChatApp 启动: http://0.0.0.0:${PORT} (dbConnected=${dbConnected})`);
  });
})();
