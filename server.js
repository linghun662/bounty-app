const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== Turso 客户端 ==========
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ========== WebSocket 连接管理 ==========
const clients = new Map();

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const userId = url.searchParams.get('userId');
  if (!userId) {
    ws.close();
    return;
  }
  try {
    const user = await turso.execute({
      sql: 'SELECT id FROM users WHERE id = ?',
      args: [userId],
    });
    if (user.rows.length === 0) {
      ws.close();
      return;
    }
  } catch (err) {
    console.error('验证用户失败:', err);
    ws.close();
    return;
  }
  clients.set(userId, ws);
  console.log(`WebSocket 用户 ${userId} 已连接`);

  ws.on('close', () => {
    clients.delete(userId);
    console.log(`WebSocket 用户 ${userId} 已断开`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err);
  });
});

function sendToUser(userId, message) {
  const ws = clients.get(userId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// ========== 工具函数 ==========
function fixBooleans(row) {
  if (!row) return row;
  const result = { ...row };
  const booleanFields = ['takerCompleted', 'idCardVerified', 'read', 'isNego'];
  for (const field of booleanFields) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = result[field] === 1 || result[field] === true;
    }
  }
  return result;
}

function fixJsonFields(row) {
  if (!row) return row;
  const result = { ...row };
  const jsonFields = ['mediaList', 'proofMedia', 'deletedConversations'];
  for (const field of jsonFields) {
    if (result[field] !== undefined && result[field] !== null && typeof result[field] === 'string') {
      try {
        result[field] = JSON.parse(result[field]);
      } catch (e) {}
    }
  }
  return result;
}

function fixRow(row) {
  if (!row) return row;
  let result = fixJsonFields(fixBooleans(row));
  if (result.id) {
    result._id = result.id;
  }
  return result;
}

function fixRows(rows) {
  if (!rows) return rows;
  return rows.map(row => fixRow(row));
}

// ========== 中间件 ==========
app.use(cors({
  origin: [
    'http://localhost:3000',
    'capacitor://localhost',
    'http://localhost',
    'https://bounty-app-production.up.railway.app',
    /\.railway\.app$/,
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
    'file://',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-me';

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: '未提供 token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'token 无效或过期' });
  }
}

// ========== 初始化数据库表 ==========
async function initTables() {
  try {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        nickname TEXT,
        phone TEXT,
        balance INTEGER DEFAULT 100,
        frozenBalance INTEGER DEFAULT 0,
        credit INTEGER DEFAULT 60,
        idCardVerified INTEGER DEFAULT 0,
        signature TEXT,
        hometown TEXT,
        avatar TEXT,
        deletedConversations TEXT
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        reward INTEGER,
        status TEXT DEFAULT 'available',
        publisherId TEXT,
        publisherName TEXT,
        publisherPhone TEXT,
        locationAddress TEXT,
        latitude REAL,
        longitude REAL,
        takerId TEXT,
        takerName TEXT,
        takenAt INTEGER,
        travelStatus TEXT DEFAULT 'idle',
        travelStartTime INTEGER,
        estimatedMinutes INTEGER,
        takerCompleted INTEGER DEFAULT 0,
        proofMedia TEXT,
        mediaList TEXT,
        category TEXT,
        createdAt INTEGER,
        updatedAt INTEGER
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        taskId TEXT,
        senderId TEXT,
        senderName TEXT,
        text TEXT,
        isNego INTEGER DEFAULT 0,
        time TEXT,
        read INTEGER DEFAULT 0,
        createdAt INTEGER
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS bills (
        id TEXT PRIMARY KEY,
        userId TEXT,
        type TEXT,
        amount INTEGER,
        desc TEXT,
        createdAt INTEGER
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS creditlogs (
        id TEXT PRIMARY KEY,
        userId TEXT,
        reason TEXT,
        change INTEGER,
        createdAt INTEGER
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS geocodecaches (
        address TEXT PRIMARY KEY,
        lat REAL,
        lng REAL,
        expires INTEGER
      )
    `);
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ratings (
        id TEXT PRIMARY KEY,
        taskId TEXT,
        fromUserId TEXT,
        toUserId TEXT,
        rating INTEGER,
        comment TEXT,
        createdAt INTEGER
      )
    `);
    console.log('✅ 所有表已创建/确认');
  } catch (err) {
    console.error('❌ 建表失败:', err);
  }
}

// ========== 初始化默认数据 ==========
async function initDefaultData() {
  try {
    const count = await turso.execute('SELECT COUNT(*) as count FROM users');
    if (count.rows[0].count === 0) {
      const hashedPwd = await bcrypt.hash('123456', 10);
      const userId1 = generateId();
      const userId2 = generateId();
      await turso.execute({
        sql: 'INSERT INTO users (id, username, password, nickname, phone, balance, credit, idCardVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [userId1, 'xiaoming', hashedPwd, '小明', '13800000001', 200, 85, 1],
      });
      await turso.execute({
        sql: 'INSERT INTO users (id, username, password, nickname, phone, balance, credit, idCardVerified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [userId2, 'hong', hashedPwd, '小红', '13800000002', 150, 72, 1],
      });

      const taskId1 = generateId();
      const taskId2 = generateId();
      await turso.execute({
        sql: 'INSERT INTO tasks (id, title, description, reward, publisherId, publisherName, locationAddress, category, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [taskId1, '帮忙取快递', '西门驿站取件送到3栋', 12, userId1, '小明', '上海交大闵行', '取件', Date.now()],
      });
      await turso.execute({
        sql: 'INSERT INTO tasks (id, title, description, reward, publisherId, publisherName, locationAddress, category, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [taskId2, '前端页面调试', 'CSS样式错位', 45, userId2, '小红', '徐家汇', '调试', Date.now()],
      });
      console.log('默认测试数据创建完成（2个任务）');
    }
  } catch (err) {
    console.error('初始化默认数据失败:', err);
  }
}

// ========== 路由 ==========

app.post('/api/register', async (req, res) => {
  const { username, password, nickname, phone } = req.body;
  try {
    const exist = await turso.execute({
      sql: 'SELECT id FROM users WHERE username = ?',
      args: [username],
    });
    if (exist.rows.length > 0) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateId();
    await turso.execute({
      sql: 'INSERT INTO users (id, username, password, nickname, phone) VALUES (?, ?, ?, ?, ?)',
      args: [userId, username, hashedPassword, nickname || username, phone || ''],
    });
    await turso.execute({
      sql: 'INSERT INTO creditlogs (id, userId, reason, change, createdAt) VALUES (?, ?, ?, ?, ?)',
      args: [generateId(), userId, '注册奖励', 60, Date.now()],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('注册失败:', err);
    res.status(500).json({ error: '注册失败' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await turso.execute({
      sql: 'SELECT * FROM users WHERE username = ?',
      args: [username],
    });
    if (user.rows.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const userData = user.rows[0];
    const isValid = await bcrypt.compare(password, userData.password);
    if (!isValid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = jwt.sign({ userId: userData.id }, JWT_SECRET, { expiresIn: '7d' });
    const fixedUser = fixRow(userData);
    res.json({
      success: true,
      token,
      user: {
        id: fixedUser.id,
        username: fixedUser.username,
        nickname: fixedUser.nickname,
        balance: fixedUser.balance,
        frozenBalance: fixedUser.frozenBalance,
        credit: fixedUser.credit,
        idCardVerified: fixedUser.idCardVerified,
        signature: fixedUser.signature,
        hometown: fixedUser.hometown,
        avatar: fixedUser.avatar,
        phone: fixedUser.phone,
      },
    });
  } catch (err) {
    console.error('登录失败:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await turso.execute(
      'SELECT * FROM tasks WHERE status = \'available\' ORDER BY createdAt DESC LIMIT 100'
    );
    res.json(fixRows(tasks.rows));
  } catch (err) {
    console.error('获取任务列表失败:', err);
    res.status(500).json({ error: '获取任务列表失败' });
  }
});

app.get('/api/tasks/all', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const total = await turso.execute('SELECT COUNT(*) as count FROM tasks');
    const tasks = await turso.execute({
      sql: 'SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      args: [limit, offset],
    });
    res.json({
      tasks: fixRows(tasks.rows),
      total: total.rows[0].count,
      page,
      totalPages: Math.ceil(total.rows[0].count / limit),
    });
  } catch (err) {
    console.error('获取所有任务失败:', err);
    res.status(500).json({ error: '获取所有任务失败' });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const t = task.rows[0];
    if (!t.publisherName) {
      const user = await turso.execute({
        sql: 'SELECT nickname, username FROM users WHERE id = ?',
        args: [t.publisherId],
      });
      if (user.rows.length > 0) {
        t.publisherName = user.rows[0].nickname || user.rows[0].username || '未知用户';
      } else {
        t.publisherName = '未知用户';
      }
    }
    res.json(fixRow(t));
  } catch (err) {
    console.error('获取任务详情失败:', err);
    res.status(500).json({ error: '获取任务详情失败' });
  }
});

app.post('/api/tasks', authMiddleware, async (req, res) => {
  const { title, description, reward, publisherName, publisherPhone, locationAddress, latitude, longitude, mediaList, category } = req.body;
  const publisherId = req.userId;
  try {
    const user = await turso.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [publisherId],
    });
    if (user.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    const userData = user.rows[0];
    if (!userData.idCardVerified) return res.status(403).json({ error: '请先实名认证' });
    if (reward > userData.balance) return res.status(400).json({ error: '余额不足' });
    await turso.execute({
      sql: 'UPDATE users SET balance = balance - ?, frozenBalance = frozenBalance + ? WHERE id = ?',
      args: [reward, reward, publisherId],
    });
    const taskId = generateId();
    await turso.execute({
      sql: `INSERT INTO tasks (
        id, title, description, reward, publisherId, publisherName, publisherPhone,
        locationAddress, latitude, longitude, mediaList, category, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        taskId,
        title,
        description || '',
        reward,
        publisherId,
        publisherName || userData.nickname || userData.username || '未知用户',
        publisherPhone || '',
        locationAddress || '',
        latitude || 0,
        longitude || 0,
        JSON.stringify(mediaList || []),
        category || '',
        'available',
        Date.now(),
        Date.now(),
      ],
    });
    await turso.execute({
      sql: 'INSERT INTO bills (id, userId, type, amount, desc, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      args: [generateId(), publisherId, 'expense', -reward, `发布任务冻结：${title}`, Date.now()],
    });
    const newTask = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [taskId],
    });
    res.json(fixRow(newTask.rows[0]));
  } catch (err) {
    console.error('发布任务失败:', err);
    res.status(500).json({ error: '发布任务失败' });
  }
});

// ========== 取消任务（修改后的完整逻辑） ==========
app.put('/api/tasks/:id/cancel', authMiddleware, async (req, res) => {
  const userId = req.userId;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const t = task.rows[0];

    if (t.publisherId !== userId) {
      return res.status(403).json({ error: '无权取消此任务' });
    }

    if (t.status === 'completed' || t.status === 'cancelled') {
      return res.status(400).json({ error: '任务已完成或已取消，无法再次取消' });
    }

    // 场景1：无人接取
    if (t.status === 'available') {
      await turso.execute({
        sql: 'UPDATE users SET balance = balance + ?, frozenBalance = frozenBalance - ? WHERE id = ?',
        args: [t.reward, t.reward, userId],
      });
      await turso.execute({
        sql: 'INSERT INTO bills (id, userId, type, amount, desc, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        args: [generateId(), userId, 'income', t.reward, `取消任务退款：${t.title}`, Date.now()],
      });
      await turso.execute({
        sql: 'UPDATE tasks SET status = \'cancelled\', updatedAt = ? WHERE id = ?',
        args: [Date.now(), req.params.id],
      });
      return res.json({ success: true });
    }

    // 场景2：有人接取
    if (t.status === 'ongoing') {
      if (t.takerCompleted) {
        return res.status(400).json({ error: '接取者已提交完成凭证，无法取消' });
      }

      // 解冻赏金并退还给发布者
      await turso.execute({
        sql: 'UPDATE users SET balance = balance + ?, frozenBalance = frozenBalance - ? WHERE id = ?',
        args: [t.reward, t.reward, userId],
      });
      await turso.execute({
        sql: 'INSERT INTO bills (id, userId, type, amount, desc, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        args: [generateId(), userId, 'income', t.reward, `取消任务退款（任务进行中）：${t.title}`, Date.now()],
      });

      // 解除接取者绑定
      await turso.execute({
        sql: `UPDATE tasks SET 
          status = 'cancelled',
          takerId = NULL,
          takerName = NULL,
          takenAt = NULL,
          travelStatus = 'idle',
          travelStartTime = NULL,
          estimatedMinutes = NULL,
          takerCompleted = 0,
          updatedAt = ?
          WHERE id = ?`,
        args: [Date.now(), req.params.id],
      });

      // 扣除发布者信誉分（-5）
      await turso.execute({
        sql: 'UPDATE users SET credit = MAX(0, credit - 5) WHERE id = ?',
        args: [userId],
      });
      await turso.execute({
        sql: 'INSERT INTO creditlogs (id, userId, reason, change, createdAt) VALUES (?, ?, ?, ?, ?)',
        args: [generateId(), userId, '取消正在进行的任务', -5, Date.now()],
      });

      // 通知接取者
      if (t.takerId) {
        sendToUser(t.takerId, {
          type: 'task_cancelled',
          data: { taskId: req.params.id, title: t.title }
        });
      }

      return res.json({ success: true });
    }

    return res.status(400).json({ error: '任务状态不允许取消' });
  } catch (err) {
    console.error('取消任务失败:', err);
    res.status(500).json({ error: '取消任务失败' });
  }
});
// ========== 取消任务修改结束 ==========

app.put('/api/tasks/:id/accept', authMiddleware, async (req, res) => {
  const takerId = req.userId;
  const { takerName } = req.body;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.status !== 'available') return res.status(400).json({ error: '任务已被接取' });
    await turso.execute({
      sql: 'UPDATE tasks SET status = \'ongoing\', takerId = ?, takerName = ?, takenAt = ?, updatedAt = ? WHERE id = ?',
      args: [takerId, takerName || '未知用户', Date.now(), Date.now(), req.params.id],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('接取任务失败:', err);
    res.status(500).json({ error: '接取任务失败' });
  }
});

app.put('/api/tasks/:id/cancel-accept', authMiddleware, async (req, res) => {
  const userId = req.userId;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.takerId !== userId) return res.status(403).json({ error: '无权取消' });
    if (t.status !== 'ongoing') return res.status(400).json({ error: '状态错误' });
    await turso.execute({
      sql: 'UPDATE tasks SET status = \'available\', takerId = NULL, takerName = NULL, takenAt = NULL, travelStatus = \'idle\', travelStartTime = NULL, estimatedMinutes = NULL, takerCompleted = 0, updatedAt = ? WHERE id = ?',
      args: [Date.now(), req.params.id],
    });
    const user = await turso.execute({
      sql: 'SELECT credit FROM users WHERE id = ?',
      args: [userId],
    });
    if (user.rows.length > 0) {
      const newCredit = Math.max(0, user.rows[0].credit - 5);
      await turso.execute({
        sql: 'UPDATE users SET credit = ? WHERE id = ?',
        args: [newCredit, userId],
      });
      await turso.execute({
        sql: 'INSERT INTO creditlogs (id, userId, reason, change, createdAt) VALUES (?, ?, ?, ?, ?)',
        args: [generateId(), userId, '取消接取任务', -5, Date.now()],
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('取消接取失败:', err);
    res.status(500).json({ error: '取消接取失败' });
  }
});

app.put('/api/tasks/:id/status', authMiddleware, async (req, res) => {
  const { travelStatus, estimatedMinutes, travelStartTime } = req.body;
  const update = {};
  if (travelStatus !== undefined) update.travelStatus = travelStatus;
  if (estimatedMinutes !== undefined) update.estimatedMinutes = estimatedMinutes;
  if (travelStartTime !== undefined) update.travelStartTime = travelStartTime;
  update.updatedAt = Date.now();
  try {
    const fields = Object.keys(update).map(k => `${k} = ?`).join(', ');
    const values = Object.values(update);
    values.push(req.params.id);
    await turso.execute({
      sql: `UPDATE tasks SET ${fields} WHERE id = ?`,
      args: values,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('更新任务状态失败:', err);
    res.status(500).json({ error: '更新任务状态失败' });
  }
});

app.post('/api/tasks/:id/submit-proof', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { proofMedia } = req.body;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.takerId !== userId) return res.status(403).json({ error: '只有接取者可提交凭证' });
    if (t.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
    await turso.execute({
      sql: 'UPDATE tasks SET proofMedia = ?, takerCompleted = 1, updatedAt = ? WHERE id = ?',
      args: [JSON.stringify(proofMedia || []), Date.now(), req.params.id],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('提交凭证失败:', err);
    res.status(500).json({ error: '提交凭证失败' });
  }
});

app.post('/api/tasks/:id/confirm-payment', authMiddleware, async (req, res) => {
  const userId = req.userId;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.publisherId !== userId) return res.status(403).json({ error: '只有发布者可确认' });
    if (t.status !== 'ongoing' || !t.takerCompleted) {
      return res.status(400).json({ error: '接取者尚未提交凭证' });
    }
    await turso.execute({
      sql: 'UPDATE users SET balance = balance + ?, frozenBalance = frozenBalance - ? WHERE id = ?',
      args: [t.reward, t.reward, t.publisherId],
    });
    await turso.execute({
      sql: 'UPDATE users SET balance = balance + ? WHERE id = ?',
      args: [t.reward, t.takerId],
    });
    await turso.execute({
      sql: 'UPDATE tasks SET status = \'completed\', updatedAt = ? WHERE id = ?',
      args: [Date.now(), req.params.id],
    });
    await turso.execute({
      sql: 'INSERT INTO bills (id, userId, type, amount, desc, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      args: [generateId(), t.takerId, 'income', t.reward, `完成任务：${t.title}`, Date.now()],
    });
    await turso.execute({
      sql: 'UPDATE users SET credit = credit + 5 WHERE id = ?',
      args: [t.takerId],
    });
    await turso.execute({
      sql: 'INSERT INTO creditlogs (id, userId, reason, change, createdAt) VALUES (?, ?, ?, ?, ?)',
      args: [generateId(), t.takerId, `完成任务“${t.title}”`, 5, Date.now()],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('确认支付失败:', err);
    res.status(500).json({ error: '确认支付失败' });
  }
});

app.put('/api/tasks/:id/reward', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { reward: newReward } = req.body;
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [req.params.id],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.publisherId !== userId) return res.status(403).json({ error: '只有发布者可修改赏金' });
    if (t.status !== 'available') return res.status(400).json({ error: '任务已被接取，无法修改' });
    const diff = newReward - t.reward;
    if (diff > 0) {
      await turso.execute({
        sql: 'UPDATE users SET balance = balance - ?, frozenBalance = frozenBalance + ? WHERE id = ?',
        args: [diff, diff, userId],
      });
    } else if (diff < 0) {
      await turso.execute({
        sql: 'UPDATE users SET balance = balance + ?, frozenBalance = frozenBalance - ? WHERE id = ?',
        args: [-diff, -diff, userId],
      });
    }
    await turso.execute({
      sql: 'UPDATE tasks SET reward = ?, updatedAt = ? WHERE id = ?',
      args: [newReward, Date.now(), req.params.id],
    });
    res.json({ success: true, reward: newReward });
  } catch (err) {
    console.error('修改赏金失败:', err);
    res.status(500).json({ error: '修改赏金失败' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const user = await turso.execute({
      sql: 'SELECT id, username, nickname, phone, balance, frozenBalance, credit, idCardVerified, signature, hometown, avatar FROM users WHERE id = ?',
      args: [req.params.id],
    });
    if (user.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json(fixRow(user.rows[0]));
  } catch (err) {
    console.error('获取用户信息失败:', err);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

app.put('/api/user/:id', authMiddleware, async (req, res) => {
  if (req.params.id !== req.userId) return res.status(403).json({ error: '无权修改' });
  const updates = req.body;
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(req.params.id);
  try {
    await turso.execute({
      sql: `UPDATE users SET ${fields} WHERE id = ?`,
      args: values,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('更新用户信息失败:', err);
    res.status(500).json({ error: '更新用户信息失败' });
  }
});

app.get('/api/bills/:userId', authMiddleware, async (req, res) => {
  if (req.params.userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  try {
    const bills = await turso.execute({
      sql: 'SELECT * FROM bills WHERE userId = ? ORDER BY createdAt DESC LIMIT 50',
      args: [req.params.userId],
    });
    res.json(bills.rows);
  } catch (err) {
    console.error('获取账单失败:', err);
    res.status(500).json({ error: '获取账单失败' });
  }
});

// ========== 对话列表（含 lastMessageTime） ==========
app.get('/api/user/:userId/conversations', authMiddleware, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ error: '无权查看' });

  try {
    const user = await turso.execute({
      sql: 'SELECT deletedConversations FROM users WHERE id = ?',
      args: [userId],
    });
    const deletedSet = new Set(user.rows[0]?.deletedConversations ? JSON.parse(user.rows[0].deletedConversations) : []);

    const taskRows = await turso.execute({
      sql: `SELECT id FROM tasks WHERE (publisherId = ? OR takerId = ?) AND status != 'cancelled'`,
      args: [userId, userId],
    });
    const taskIds = taskRows.rows.map(r => r.id);

    const msgRows = await turso.execute({
      sql: 'SELECT DISTINCT taskId FROM messages WHERE senderId = ?',
      args: [userId],
    });
    const msgTaskIds = msgRows.rows.map(r => r.taskId);

    const allTaskIds = [...new Set([...taskIds, ...msgTaskIds])];
    if (allTaskIds.length === 0) {
      return res.json([]);
    }

    const placeholders = allTaskIds.map(() => '?').join(',');
    const taskRes = await turso.execute({
      sql: `SELECT * FROM tasks WHERE id IN (${placeholders}) AND status != 'cancelled'`,
      args: allTaskIds,
    });

    const conversations = [];
    for (const task of taskRes.rows) {
      if (deletedSet.has(task.id)) continue;

      let otherId = null;
      let otherName = null;

      if (task.publisherId === userId) {
        otherId = task.takerId;
      } else if (task.takerId === userId) {
        otherId = task.publisherId;
      }

      if (!otherId) {
        const otherMsg = await turso.execute({
          sql: 'SELECT senderId, senderName FROM messages WHERE taskId = ? AND senderId != ? LIMIT 1',
          args: [task.id, userId],
        });
        if (otherMsg.rows.length > 0) {
          otherId = otherMsg.rows[0].senderId;
          otherName = otherMsg.rows[0].senderName;
        }
      }

      if (!otherId) continue;

      if (!otherName) {
        const userRes = await turso.execute({
          sql: 'SELECT nickname, username FROM users WHERE id = ?',
          args: [otherId],
        });
        if (userRes.rows.length > 0) {
          otherName = userRes.rows[0].nickname || userRes.rows[0].username || '用户';
        } else {
          otherName = '用户';
        }
      }

      const lastMsg = await turso.execute({
        sql: 'SELECT * FROM messages WHERE taskId = ? ORDER BY createdAt DESC LIMIT 1',
        args: [task.id],
      });

      let lastMessageTime;
      if (lastMsg.rows.length > 0) {
        lastMessageTime = lastMsg.rows[0].time;
      } else {
        lastMessageTime = new Date(task.createdAt).toISOString();
      }

      const unreadCount = await turso.execute({
        sql: 'SELECT COUNT(*) as count FROM messages WHERE taskId = ? AND senderId != ? AND read = 0',
        args: [task.id, userId],
      });

      conversations.push({
        taskId: task.id,
        otherId,
        otherName,
        lastMsg: lastMsg.rows[0]?.text || null,
        reward: task.reward,
        taskTitle: task.title,
        unread: unreadCount.rows[0].count,
        lastMessageTime,
      });
    }

    res.json(conversations);
  } catch (err) {
    console.error('获取对话列表失败:', err);
    res.status(500).json({ error: '获取对话列表失败' });
  }
});

app.get('/api/messages/:taskId', async (req, res) => {
  try {
    const messages = await turso.execute({
      sql: 'SELECT * FROM messages WHERE taskId = ? ORDER BY createdAt ASC',
      args: [req.params.taskId],
    });
    res.json(fixRows(messages.rows));
  } catch (err) {
    console.error('获取消息失败:', err);
    res.status(500).json({ error: '获取消息失败' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { taskId, senderId, senderName, text, isNego } = req.body;
    if (!taskId || !senderId || !text) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    const messageId = generateId();
    const now = Date.now();
    await turso.execute({
      sql: 'INSERT INTO messages (id, taskId, senderId, senderName, text, isNego, time, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [messageId, taskId, senderId, senderName, text, isNego ? 1 : 0, new Date().toISOString(), now],
    });
    const newMsg = { id: messageId, taskId, senderId, senderName, text, isNego: !!isNego, time: new Date().toISOString(), createdAt: now, read: 0 };

    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [taskId],
    });
    if (task.rows.length === 0) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const t = task.rows[0];
    let receiverId = null;
    if (t.publisherId === senderId) {
      receiverId = t.takerId;
    } else if (t.takerId === senderId) {
      receiverId = t.publisherId;
    }
    if (receiverId) {
      const payload = { type: 'new_message', data: fixRow(newMsg) };
      const sent = sendToUser(receiverId, payload);
      console.log(`推送结果: ${sent ? '✅ 成功' : '❌ 失败'}, 接收方: ${receiverId}`);
    } else {
      console.log('❌ 未找到接收方');
    }
    res.json(fixRow(newMsg));
  } catch (err) {
    console.error('发送消息失败:', err);
    res.status(500).json({ error: '发送消息失败' });
  }
});

app.put('/api/messages/read/:taskId/:userId', authMiddleware, async (req, res) => {
  const { taskId, userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ error: '无权操作' });
  try {
    const result = await turso.execute({
      sql: 'UPDATE messages SET read = 1 WHERE taskId = ? AND senderId != ? AND read = 0',
      args: [taskId, userId],
    });
    console.log(`标记已读: taskId=${taskId}, userId=${userId}, 影响行数=${result.rowsAffected}`);
    res.json({ success: true });
  } catch (err) {
    console.error('标记已读失败:', err);
    res.status(500).json({ error: '标记已读失败' });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  const userId = req.userId;
  try {
    const msg = await turso.execute({
      sql: 'SELECT senderId FROM messages WHERE id = ?',
      args: [req.params.messageId],
    });
    if (msg.rows.length === 0) return res.status(404).json({ error: '消息不存在' });
    if (msg.rows[0].senderId !== userId) return res.status(403).json({ error: '无权删除' });
    await turso.execute({
      sql: 'DELETE FROM messages WHERE id = ?',
      args: [req.params.messageId],
    });
    res.json({ success: true });
  } catch (err) {
    console.error('删除消息失败:', err);
    res.status(500).json({ error: '删除消息失败' });
  }
});

app.delete('/api/conversations/:taskId/:userId', authMiddleware, async (req, res) => {
  const { taskId, userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ error: '无权操作' });
  try {
    const user = await turso.execute({
      sql: 'SELECT deletedConversations FROM users WHERE id = ?',
      args: [userId],
    });
    const list = user.rows[0]?.deletedConversations ? JSON.parse(user.rows[0].deletedConversations) : [];
    if (!list.includes(taskId)) {
      list.push(taskId);
      await turso.execute({
        sql: 'UPDATE users SET deletedConversations = ? WHERE id = ?',
        args: [JSON.stringify(list), userId],
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('删除对话失败:', err);
    res.status(500).json({ error: '删除对话失败' });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有文件' });
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const AMAP_KEY = '30107d62cf0ec682643d1097a48f7da4';

app.post('/api/geocode', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: '地址不能为空' });
  try {
    let cached = await turso.execute({
      sql: 'SELECT * FROM geocodecaches WHERE address = ? AND expires > ?',
      args: [address, Date.now()],
    });
    if (cached.rows.length > 0) {
      const c = cached.rows[0];
      return res.json({ lat: c.lat, lng: c.lng });
    }
    const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&key=${AMAP_KEY}&output=JSON`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
      const loc = data.geocodes[0].location.split(',');
      const lng = parseFloat(loc[0]);
      const lat = parseFloat(loc[1]);
      await turso.execute({
        sql: 'INSERT OR REPLACE INTO geocodecaches (address, lat, lng, expires) VALUES (?, ?, ?, ?)',
        args: [address, lat, lng, Date.now() + 7 * 24 * 60 * 60 * 1000],
      });
      res.json({ lat, lng });
    } else {
      res.status(404).json({ error: '地址无法解析' });
    }
  } catch (err) {
    console.error('地理编码错误:', err);
    res.status(500).json({ error: '地理编码失败' });
  }
});

app.post('/api/regeo', async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: '缺少经纬度' });
  try {
    const url = `https://restapi.amap.com/v3/geocode/regeo?output=json&location=${lng},${lat}&key=${AMAP_KEY}&radius=200&extensions=all`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status === '1' && data.regeocode) {
      const formatted = data.regeocode.formatted_address || '';
      res.json({ address: formatted });
    } else {
      res.status(404).json({ error: '无法解析位置' });
    }
  } catch (err) {
    console.error('逆地理编码错误:', err);
    res.status(500).json({ error: '逆地理编码失败' });
  }
});

app.post('/api/verify-id', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { realName, idCard } = req.body;
  if (realName && idCard.length >= 15) {
    try {
      await turso.execute({
        sql: 'UPDATE users SET idCardVerified = 1 WHERE id = ?',
        args: [userId],
      });
      res.json({ success: true });
    } catch (err) {
      console.error('实名认证失败:', err);
      res.status(500).json({ error: '实名认证失败' });
    }
  } else {
    res.status(400).json({ error: '认证信息无效' });
  }
});

app.get('/api/credit-logs/:userId', authMiddleware, async (req, res) => {
  if (req.params.userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  try {
    const logs = await turso.execute({
      sql: 'SELECT * FROM creditlogs WHERE userId = ? ORDER BY createdAt DESC',
      args: [req.params.userId],
    });
    res.json(logs.rows);
  } catch (err) {
    console.error('获取信用日志失败:', err);
    res.status(500).json({ error: '获取信用日志失败' });
  }
});

app.get('/api/ratings/task/:taskId/user/:userId', authMiddleware, async (req, res) => {
  const { taskId, userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  try {
    const rating = await turso.execute({
      sql: 'SELECT * FROM ratings WHERE taskId = ? AND fromUserId = ?',
      args: [taskId, userId],
    });
    res.json(rating.rows[0] || null);
  } catch (err) {
    console.error('获取评价失败:', err);
    res.status(500).json({ error: '获取评价失败' });
  }
});

app.get('/api/ratings/user/:userId', authMiddleware, async (req, res) => {
  if (req.params.userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  try {
    const ratings = await turso.execute({
      sql: 'SELECT * FROM ratings WHERE toUserId = ? ORDER BY createdAt DESC',
      args: [req.params.userId],
    });
    res.json(ratings.rows);
  } catch (err) {
    console.error('获取用户评价失败:', err);
    res.status(500).json({ error: '获取用户评价失败' });
  }
});

app.post('/api/ratings', authMiddleware, async (req, res) => {
  const { taskId, toUserId, rating, comment } = req.body;
  const fromUserId = req.userId;
  if (!taskId || !toUserId || rating === undefined) return res.status(400).json({ error: '缺少必要参数' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: '评分必须为1-5' });
  if (fromUserId === toUserId) return res.status(400).json({ error: '不能给自己评价' });
  try {
    const task = await turso.execute({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      args: [taskId],
    });
    if (task.rows.length === 0) return res.status(404).json({ error: '任务不存在' });
    const t = task.rows[0];
    if (t.status !== 'completed') return res.status(400).json({ error: '任务尚未完成，不能评价' });
    if (t.publisherId !== fromUserId && t.takerId !== fromUserId) return res.status(403).json({ error: '您不是该任务的参与者' });
    if (t.publisherId !== toUserId && t.takerId !== toUserId) return res.status(400).json({ error: '被评价人不是该任务的参与者' });
    const existing = await turso.execute({
      sql: 'SELECT id FROM ratings WHERE taskId = ? AND fromUserId = ? AND toUserId = ?',
      args: [taskId, fromUserId, toUserId],
    });
    if (existing.rows.length > 0) return res.status(400).json({ error: '您已经评价过该任务了' });
    const ratingId = generateId();
    await turso.execute({
      sql: 'INSERT INTO ratings (id, taskId, fromUserId, toUserId, rating, comment, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [ratingId, taskId, fromUserId, toUserId, rating, comment || '', Date.now()],
    });
    let creditChange = 0;
    if (rating >= 4) creditChange = 2;
    else if (rating <= 2) creditChange = -2;
    if (creditChange !== 0) {
      await turso.execute({
        sql: 'UPDATE users SET credit = credit + ? WHERE id = ?',
        args: [creditChange, toUserId],
      });
      await turso.execute({
        sql: 'INSERT INTO creditlogs (id, userId, reason, change, createdAt) VALUES (?, ?, ?, ?, ?)',
        args: [generateId(), toUserId, `收到${rating >= 4 ? '好评' : '差评'}（任务: ${t.title}）`, creditChange, Date.now()],
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('提交评价失败:', err);
    res.status(500).json({ error: '提交评价失败' });
  }
});

app.get('/api/stats/:userId', authMiddleware, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  try {
    const published = await turso.execute({
      sql: 'SELECT COUNT(*) as count FROM tasks WHERE publisherId = ?',
      args: [userId],
    });
    const accepted = await turso.execute({
      sql: 'SELECT COUNT(*) as count FROM tasks WHERE takerId = ? AND status = \'ongoing\'',
      args: [userId],
    });
    const completed = await turso.execute({
      sql: 'SELECT COUNT(*) as count FROM tasks WHERE takerId = ? AND status = \'completed\'',
      args: [userId],
    });
    res.json({
      published: published.rows[0].count,
      accepted: accepted.rows[0].count,
      completed: completed.rows[0].count,
    });
  } catch (err) {
    console.error('获取统计数据失败:', err);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initTables();
  await initDefaultData();
});