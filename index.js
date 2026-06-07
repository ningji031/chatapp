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

// ─── sql.js 初始化（必须先完成，再启动 HTTP + Socket） ──────
let db;
const dbPath = path.join(__dirname, 'chat.db');

function saveDb() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const hasRow = stmt.step();
  const result = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

(async () => {
  // 1) 等待 sql.js WASM 加载完毕
  const SQL = await initSqlJs();

  // 2) 尝试从磁盘恢复，失败则新建空库
  try {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
    console.log('[db] 从磁盘恢复 chat.db');
  } catch {
    db = new SQL.Database();
    console.log('[db] 创建新数据库');
  }

  // 3) 建表
  db.exec(`
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

  // 4) 默认聊天室
  for (const r of [
    { id:'general', name:'大厅',     desc:'欢迎来到聊天大厅！' },
    { id:'tech',    name:'技术交流', desc:'讨论技术话题'       },
    { id:'random',  name:'闲聊水区', desc:'随便聊聊'           }
  ]) {
    run('INSERT OR IGNORE INTO rooms (id,name,description,created_by) VALUES(?,?,?,\'system\')', [r.id,r.name,r.desc]);
  }
  saveDb();

  console.log('[db] 数据库初始化完成 ✓');

  // ════════════════ 5) 注册路由 & Socket（DB 就绪后）═════════════════

  // --- 注册 ---
  app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2~20 位' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    try {
      if (getOne('SELECT id FROM users WHERE username = ?', [username]))
        return res.status(400).json({ error: '用户名已被占用' });
      const hashed = await bcrypt.hash(password, 10);
      const id = uuidv4();
      const avatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(username)}`;
      run('INSERT INTO users(id,username,password,avatar) VALUES(?,?,?,?)', [id, username, hashed, avatar]);
      saveDb();
      const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id, username, avatar } });
    } catch(e) {
      console.error('Register:', e.message);
      res.status(500).json({ error: '服务器错误' });
    }
  });

  // --- 登录 ---
  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id:user.id, username:user.username, avatar:user.avatar }});
  });

  // --- 健康 ---
  app.get('/health', (_req, res) => res.json({ status:'ok', uptime:process.uptime() }));

  // --- 频道列表 ---
  app.get('/api/rooms', (_req, res) =>
    res.json(getAll('SELECT id,name,description,created_at FROM rooms ORDER BY created_at ASC'))
  );

  // --- 用户列表 ---
  app.get('/api/users', authMw, (_req, res) =>
    res.json(getAll('SELECT id,username,avatar FROM users ORDER BY username ASC'))
  );

  // --- 私聊记录 ---
  app.get('/api/private/:userId', authMw, (req, res) => {
    const me = req.user.id, other = req.params.userId;
    res.json(
      getAll('SELECT * FROM private_messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY created_at ASC LIMIT 100',
        [me, other, other, me])
    );
  });

  function authMw(req, res, next) {
    const h = req.headers.authorization;
    if (!h) return res.status(401).json({ error:'未登录' });
    try { req.user = jwt.verify(h.replace('Bearer ',''), JWT_SECRET); next(); }
    catch { res.status(401).json({ error:'Token 无效' }); }
  }

  // ─── Socket.io ──────────────────────────────────────────────────
  const onlineUsers = new Map();
  const io = new Server(server, {
    cors:{ origin:'*', methods:['GET','POST'] }
  });

  io.use((socket, next) => {
    const t = socket.handshake.auth.token;
    if(!t) return next(new Error('未登录'));
    try {
      const p = jwt.verify(t, JWT_SECRET);
      const u = getOne('SELECT id,username,avatar FROM users WHERE id=?',[p.id]);
      if(!u) return next(new Error('用户不存在'));
      socket.user=u; next();
    } catch{ next(new Error('Token无效')); }
  });

  io.on('connection',(s)=>{
    const{id,username,avatar}=s.user;
    onlineUsers.set(s.id,{id,username,avatar});
    broadcastOnline(); console.log(`[+] ${username} 在线`);

    s.on('join_room',(rid)=>{
      s.join(rid);
      const msgs=getAll('SELECT * FROM messages WHERE room_id=? ORDER BY created_at DESC LIMIT 50',[rid]).reverse();
      s.emit('room_history',{roomId:rid,messages:msgs});
      s.to(rid).emit('system_message',{roomId:rid,text:`${username} 加入频道`,time:Date.now()});
    });

    s.on('leave_room',(rid)=>s.leave(rid));

    s.on('send_message',({roomId,content,type='text'})=>{
      if(!content||!content.trim()) return;
      const msg={
        id:uuidv4(),room_id:roomId,sender_id:id,sender_name:username,
        content:content.trim(),type,created_at:Math.floor(Date.now()/1000)
      };
      run('INSERT INTO messages(id,room_id,sender_id,sender_name,content,type,created_at) VALUES(?,?,?,?,?,?,?)',
        [msg.id,msg.room_id,msg.sender_id,msg.sender_name,msg.content,msg.type,msg.created_at]);
      saveDb();
      io.to(roomId).emit('new_message',msg);
    });

    s.on('send_private',({toUserId,content,type='text'})=>{
      if(!content||!content.trim()) return;
      const msg={
        id:uuidv4(),from_id:id,to_id:toUserId,content:content.trim(),type,
        created_at:Math.floor(Date.now()/1000)
      };
      run('INSERT INTO private_messages(id,from_id,to_id,content,type,created_at) VALUES(?,?,?,?,?,?)',
        [msg.id,msg.from_id,msg.toUserId||toUserId,msg.content,msg.type,msg.created_at]);
      saveDb();
      const tgt=[...onlineUsers.entries()].find(([,u])=>u.id===toUserId);
      if(tgt) io.to(tgt[0]).emit('new_private',msg);
      s.emit('new_private',msg);
    });

    s.on('typing',({roomId,isTyping})=>s.to(roomId).emit('user_typing',{userId:id,username,isTyping}));

    s.on('disconnect',()=>{
      onlineUsers.delete(s.id); broadcastOnline(); console.log(`[-] ${username} 离线`);
    });
  });

  function broadcastOnline(){
    io.emit('online_users',[...onlineUsers.values()].map(({id,username,avatar})=>({id,username,avatar})));
  }

  // ════════════════ 6) 启动监听（一切就绪后）═════════════════
  server.listen(PORT,'0.0.0.0',()=>{
    console.log(`✅ ChatApp 启动: http://0.0.0.0:${PORT}`);
  });
})();
