const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'chatapp_jwt_secret_2026';
const PORT = process.env.PORT || 3001;

// ─── 数据库（可选）───────────────────────────────────────────────
let dbConnected = false;
let pool = null;
let pgModule = null;

try {
  pgModule = require('pg');
} catch (e) {
  console.log('[db] pg 模块未安装，数据库功能不可用');
}

if (pgModule && process.env.DATABASE_URL) {
  try {
    pool = new pgModule.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  } catch (e) {
    console.error('[db] Pool 创建失败:', e.message);
  }
}

async function dbQuery(sql, params = []) {
  if (!pool) throw new Error('数据库未配置');
  const result = await pool.query(sql, params);
  return result.rows;
}

async function dbRun(sql, params = []) {
  if (!pool) throw new Error('数据库未配置');
  await pool.query(sql, params);
}

async function initDb() {
  if (!pool) return;
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, avatar TEXT DEFAULT '', is_admin INTEGER DEFAULT 0, created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW()))`,
    `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '', created_by TEXT, created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW()))`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room_id TEXT, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, content TEXT NOT NULL, type TEXT DEFAULT 'text', created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW()))`,
    `CREATE TABLE IF NOT EXISTS private_messages (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, content TEXT NOT NULL, type TEXT DEFAULT 'text', read INTEGER DEFAULT 0, created_at INTEGER DEFAULT EXTRACT(EPOCH FROM NOW()))`,
  ];
  for (const sql of tables) await pool.query(sql);

  // 添加 is_admin 列（如果已存在会报错，忽略）
  try { await pool.query('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0'); } catch(e) {}

  const defaults = [
    { id: 'general', name: '大厅', desc: '欢迎来到聊天大厅！' },
    { id: 'tech', name: '技术交流', desc: '讨论技术话题' },
    { id: 'random', name: '闲聊水区', desc: '随便聊聊' },
  ];
  for (const r of defaults) {
    await pool.query(`INSERT INTO rooms(id,name,description,created_by) VALUES($1,$2,$3,'system') ON CONFLICT(id) DO NOTHING`, [r.id, r.name, r.desc]);
  }

  // 设置第一个用户为管理员（用户名：555）
  await pool.query('UPDATE users SET is_admin=1 WHERE username=$1', ['555']);

  console.log('[db] PostgreSQL 初始化完成 ✓');
}

// ─── 内存备用数据────────────────────────────────────────────────
const memUsers = new Map();
const memRooms = [
  { id: 'general', name: '大厅', description: '欢迎来到聊天大厅！' },
  { id: 'tech', name: '技术交流', description: '讨论技术话题' },
  { id: 'random', name: '闲聊水区', description: '随便聊聊' },
];
const memMessages = [];
const memPrivateMessages = [];
// 初始化内存测试账号（服务器重启后自动恢复）
(async () => {
  const bcrypt = require('bcryptjs');
  const testUsers = [
    { id: 'test_user1', username: 'test',  password: '123456' },
    { id: 'test_user2', username: 'alice', password: '123456' },
    { id: 'test_user3', username: 'bob',   password: '123456' },
  ];
  for (const u of testUsers) {
    if (!memUsers.has(u.id)) {
      const hashed = await bcrypt.hash(u.password, 10);
      const avatar = 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(u.username);
      memUsers.set(u.id, { id: u.id, username: u.username, password: hashed, avatar });
    }
  }
  console.log('[mem] 已初始化测试账号: test / alice / bob (密码均为 123456)');
})();


// ─── Express 中间件──────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// 禁止浏览器缓存 HTML 页面
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const clientPath = path.join(__dirname, 'client');
app.use(express.static(clientPath, { etag: false, lastModified: false }));
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(clientPath, 'index.html'));
});

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', dbConnected, port: PORT, dbUrlSet: !!process.env.DATABASE_URL });
});

// ─── JWT 鉴权────────────────────────────────────────────────────
function authMw(req, res, next) {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
}

// ─── REST API────────────────────────────────────────────────────

// 注册
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2~20 位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  
  try {
    if (dbConnected) {
      const exists = (await dbQuery('SELECT id FROM users WHERE username = $1', [username]))[0];
      if (exists) return res.status(400).json({ error: '用户名已被占用' });
      const hashed = await bcrypt.hash(password, 10);
      const id = require('uuid').v4();
      const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
      await dbRun('INSERT INTO users(id,username,password,avatar,is_admin) VALUES($1,$2,$3,$4,$5)', [id, username, hashed, avatar, 0]);
      const token = jwt.sign({ id, username, is_admin: 0 }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id, username, avatar, is_admin: 0 } });
    } else {
      // 内存模式
      for (const u of memUsers.values()) if (u.username === username) return res.status(400).json({ error: '用户名已被占用' });
      const id = 'user_' + Date.now();
      const hashed = await bcrypt.hash(password, 10);
      const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
      memUsers.set(id, { id, username, password: hashed, avatar, is_admin: 0 });
      const token = jwt.sign({ id, username, is_admin: 0 }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id, username, avatar, is_admin: 0 } });
    }
  } catch (e) {
    console.error('[Register]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    if (dbConnected) {
      const user = (await dbQuery('SELECT * FROM users WHERE username = $1', [username]))[0];
      if (!user) return res.status(401).json({ error: '用户名或密码错误' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
      const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, is_admin: user.is_admin || 0 } });
    } else {
      let user = null;
      for (const u of memUsers.values()) if (u.username === username) { user = u; break; }
      if (!user) return res.status(401).json({ error: '用户名或密码错误' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
      const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, is_admin: user.is_admin || 0 } });
    }
  } catch (e) {
    console.error('[Login]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 频道列表
app.get('/api/rooms', async (_req, res) => {
  if (dbConnected) {
    const rows = await dbQuery('SELECT id, name, description, created_at FROM rooms ORDER BY created_at ASC');
    res.json(rows);
  } else {
    res.json(memRooms);
  }
});

// 用户列表
app.get('/api/users', authMw, async (_req, res) => {
  if (dbConnected) {
    const rows = await dbQuery('SELECT id, username, avatar FROM users ORDER BY username ASC');
    res.json(rows);
  } else {
    res.json([...memUsers.values()].map(u => ({ id: u.id, username: u.username, avatar: u.avatar })));
  }
});

// 私聊记录
app.get('/api/private/:userId', authMw, async (req, res) => {
  const me = req.user.id, other = req.params.userId;
  if (dbConnected) {
    const rows = await dbQuery('SELECT * FROM private_messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$3 AND to_id=$4) ORDER BY created_at ASC LIMIT 100', [me, other, other, me]);
    res.json(rows);
  } else {
    res.json(memPrivateMessages.filter(m => (m.from_id === me && m.to_id === other) || (m.from_id === other && m.to_id === me)).slice(-100));
  }
});

// ─── 管理员鉴权────────────────────────────────────────
function adminMw(req, res, next) {
  authMw(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

// ─── 管理员 API─────────────────────────────────────────

// 获取所有用户（管理员）
app.get('/api/admin/users', adminMw, async (req, res) => {
  try {
    if (dbConnected) {
      const rows = await dbQuery('SELECT id, username, avatar, is_admin, created_at FROM users ORDER BY created_at DESC');
      res.json(rows);
    } else {
      res.json([...memUsers.values()].map(u => ({ id: u.id, username: u.username, avatar: u.avatar, is_admin: u.is_admin || 0, created_at: u.created_at })));
    }
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 添加用户（管理员）
app.post('/api/admin/users', adminMw, async (req, res) => {
  const { username, password, is_admin } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2~20 位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

  try {
    if (dbConnected) {
      const exists = (await dbQuery('SELECT id FROM users WHERE username = $1', [username]))[0];
      if (exists) return res.status(400).json({ error: '用户名已被占用' });
      const hashed = await bcrypt.hash(password, 10);
      const id = require('uuid').v4();
      const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
      await dbRun('INSERT INTO users(id, username, password, avatar, is_admin) VALUES($1,$2,$3,$4,$5)', [id, username, hashed, avatar, is_admin ? 1 : 0]);
      res.json({ success: true, user: { id, username, avatar, is_admin: is_admin ? 1 : 0 } });
    } else {
      for (const u of memUsers.values()) if (u.username === username) return res.status(400).json({ error: '用户名已被占用' });
      const id = 'user_' + Date.now();
      const hashed = await bcrypt.hash(password, 10);
      const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
      memUsers.set(id, { id, username, password: hashed, avatar, is_admin: is_admin ? 1 : 0 });
      res.json({ success: true, user: { id, username, avatar, is_admin: is_admin ? 1 : 0 } });
    }
  } catch (e) {
    console.error('[Admin Add User]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除用户（管理员）
app.delete('/api/admin/users/:id', adminMw, async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });

  try {
    if (dbConnected) {
      await dbRun('DELETE FROM users WHERE id = $1', [id]);
      await dbRun('DELETE FROM private_messages WHERE from_id = $1 OR to_id = $1', [id]);
      await dbRun('DELETE FROM messages WHERE sender_id = $1', [id]);
      res.json({ success: true });
    } else {
      memUsers.delete(id);
      res.json({ success: true });
    }
  } catch (e) {
    console.error('[Admin Delete User]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置/取消管理员（管理员）
app.put('/api/admin/users/:id/admin', adminMw, async (req, res) => {
  const { id } = req.params;
  const { is_admin } = req.body;

  try {
    if (dbConnected) {
      await dbRun('UPDATE users SET is_admin = $1 WHERE id = $2', [is_admin ? 1 : 0, id]);
      res.json({ success: true });
    } else {
      const user = memUsers.get(id);
      if (user) user.is_admin = is_admin ? 1 : 0;
      res.json({ success: true });
    }
  } catch (e) {
    console.error('[Admin Set Admin]', e.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取所有频道（管理员）
app.get('/api/admin/rooms', adminMw, async (req, res) => {
  try {
    if (dbConnected) {
      const rows = await dbQuery('SELECT * FROM rooms ORDER BY created_at ASC');
      res.json(rows);
    } else {
      res.json(memRooms);
    }
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// 添加频道（管理员）
app.post('/api/admin/rooms', adminMw, async (req, res) => {
  const { id, name, description } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'ID 和名称不能为空' });

  try {
    if (dbConnected) {
      await dbRun('INSERT INTO rooms(id, name, description, created_by) VALUES($1,$2,$3,$4)', [id, name, description || '', req.user.id]);
      res.json({ success: true });
    } else {
      memRooms.push({ id, name, description: description || '' });
      res.json({ success: true });
    }
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '频道 ID 已存在' });
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除频道（管理员）
app.delete('/api/admin/rooms/:id', adminMw, async (req, res) => {
  const { id } = req.params;

  try {
    if (dbConnected) {
      await dbRun('DELETE FROM rooms WHERE id = $1', [id]);
      await dbRun('DELETE FROM messages WHERE room_id = $1', [id]);
      res.json({ success: true });
    } else {
      const idx = memRooms.findIndex(r => r.id === id);
      if (idx !== -1) memRooms.splice(idx, 1);
      res.json({ success: true });
    }
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// ─── Socket.io───────────────────────────────────────────────────
const onlineUsers = new Map();

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

io.use(async (socket, next) => {
  const t = socket.handshake.auth.token;
  if (!t) return next(new Error('未登录'));
  try {
    const p = jwt.verify(t, JWT_SECRET);
    let user = null;
    if (dbConnected) {
      user = (await dbQuery('SELECT id, username, avatar FROM users WHERE id=$1', [p.id]))[0];
    } else {
      user = memUsers.get(p.id);
    }
    if (!user) return next(new Error('用户不存在'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Token 无效'));
  }
});

io.on('connection', (s) => {
  const { id, username, avatar } = s.user;
  onlineUsers.set(s.id, { id, username, avatar });
  broadcastOnline();

  s.on('join_room', async (rid) => {
    s.join(rid);
    let msgs = [];
    if (dbConnected) {
      msgs = await dbQuery('SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 50', [rid]);
      msgs.reverse();
    } else {
      msgs = memMessages.filter(m => m.room_id === rid).slice(-50);
    }
    s.emit('room_history', { roomId: rid, messages: msgs });
    s.to(rid).emit('system_message', { roomId: rid, text: `${username} 加入频道` });
  });

  s.on('leave_room', (rid) => s.leave(rid));

  s.on('send_message', async ({ roomId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = { id: 'msg_' + Date.now(), room_id: roomId, sender_id: id, sender_name: username, content: content.trim(), type, created_at: Math.floor(Date.now() / 1000) };
    if (dbConnected) {
      await dbRun('INSERT INTO messages(id,room_id,sender_id,sender_name,content,type,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [msg.id, msg.room_id, msg.sender_id, msg.sender_name, msg.content, msg.type, msg.created_at]);
    } else {
      memMessages.push(msg);
    }
    io.to(roomId).emit('new_message', msg);
  });

  s.on('send_private', async ({ toUserId, content, type = 'text' }) => {
    if (!content || !content.trim()) return;
    const msg = { id: 'pm_' + Date.now(), from_id: id, to_id: toUserId, content: content.trim(), type, created_at: Math.floor(Date.now() / 1000) };
    if (dbConnected) {
      await dbRun('INSERT INTO private_messages(id,from_id,to_id,content,type,created_at) VALUES($1,$2,$3,$4,$5,$6)', [msg.id, msg.from_id, msg.to_id, msg.content, msg.type, msg.created_at]);
    } else {
      memPrivateMessages.push(msg);
    }
    const tgt = [...onlineUsers.entries()].find(([, u]) => u.id === toUserId);
    if (tgt) io.to(tgt[0]).emit('new_private', msg);
    s.emit('new_private', msg);
  });

  s.on('typing', ({ roomId, isTyping }) => s.to(roomId).emit('user_typing', { userId: id, username, isTyping }));

  s.on('disconnect', () => {
    onlineUsers.delete(s.id);
    broadcastOnline();
  });
});

function broadcastOnline() {
  io.emit('online_users', [...onlineUsers.values()]);
}

// ─── 启动─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] ChatApp 启动在端口 ${PORT}`);
});

// 异步连接数据库
(async () => {
  if (!pool) {
    console.log('[db] 无数据库配置，运行内存模式');
    return;
  }
  for (let i = 0; i < 15; i++) {
    try {
      console.log(`[db] 连接 PostgreSQL (${i + 1}/15)...`);
      await pool.query('SELECT 1');
      console.log('[db] PostgreSQL 连接成功 ✓');
      await initDb();
      dbConnected = true;
      break;
    } catch (e) {
      console.error(`[db] 失败: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`[OK] 就绪! db=${dbConnected}`);
})();
