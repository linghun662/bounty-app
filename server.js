const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

let fetch;
try {
  fetch = global.fetch;
  if (!fetch) throw new Error();
} catch(e) {
  fetch = require('node-fetch');
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

const app = express();

app.use(cors({
  origin: [
    'http://localhost:3000',
    'capacitor://localhost',
    'http://localhost',
    'https://bounty-app-production.up.railway.app',
    /\.railway\.app$/,
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
    'file://'
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-me';

mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/bounty', {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  nickname: String,
  phone: String,
  balance: { type: Number, default: 100 },
  frozenBalance: { type: Number, default: 0 },
  credit: { type: Number, default: 60 },
  idCardVerified: { type: Boolean, default: false },
  signature: String,
  hometown: String,
  avatar: String,
  deletedConversations: [{ type: String }]
});
const User = mongoose.model('User', UserSchema);

const TaskSchema = new mongoose.Schema({
  title: String,
  description: String,
  reward: Number,
  status: { type: String, default: 'available' },
  publisherId: String,
  publisherName: String,
  publisherPhone: String,
  locationAddress: String,
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  takerId: { type: String, default: null },
  takerName: { type: String, default: null },
  takenAt: { type: Date, default: null },
  travelStatus: { type: String, default: 'idle' },
  travelStartTime: { type: Number, default: null },
  estimatedMinutes: { type: Number, default: null },
  takerCompleted: { type: Boolean, default: false },
  proofMedia: { type: Array, default: [] },
  mediaList: Array,
  category: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TaskSchema.index({ status: 1, createdAt: -1 });
TaskSchema.index({ publisherId: 1 });
TaskSchema.index({ takerId: 1 });

const Task = mongoose.model('Task', TaskSchema);
Task.ensureIndexes().catch(err => console.error('索引创建失败:', err));

const MessageSchema = new mongoose.Schema({
  taskId: String,
  senderId: String,
  senderName: String,
  text: String,
  isNego: { type: Boolean, default: false },
  time: String,
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const BillSchema = new mongoose.Schema({
  userId: String,
  type: String,
  amount: Number,
  desc: String,
  createdAt: { type: Date, default: Date.now }
});
const Bill = mongoose.model('Bill', BillSchema);

const CreditLogSchema = new mongoose.Schema({
  userId: String,
  reason: String,
  change: Number,
  createdAt: { type: Date, default: Date.now }
});
const CreditLog = mongoose.model('CreditLog', CreditLogSchema);

const GeocodeCacheSchema = new mongoose.Schema({
  address: { type: String, unique: true },
  lat: Number,
  lng: Number,
  expires: { type: Date, default: () => Date.now() + 7*24*60*60*1000 }
});
const GeocodeCache = mongoose.models.GeocodeCache || mongoose.model('GeocodeCache', GeocodeCacheSchema);

const RatingSchema = new mongoose.Schema({
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
RatingSchema.index({ taskId: 1, fromUserId: 1, toUserId: 1 }, { unique: true });
const Rating = mongoose.model('Rating', RatingSchema);

async function updateUserBalance(userId, deltaBalance, deltaFrozen = 0) {
  const user = await User.findById(userId);
  if (!user) throw new Error(`用户不存在: ${userId}`);
  if (user.balance + deltaBalance < 0) throw new Error(`余额不足，当前余额 ${user.balance}，需扣减 ${-deltaBalance}`);
  if (user.frozenBalance + deltaFrozen < 0) throw new Error(`冻结余额不足，当前冻结 ${user.frozenBalance}，需解冻 ${-deltaFrozen}`);
  user.balance += deltaBalance;
  user.frozenBalance += deltaFrozen;
  await user.save();
  return user;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: '未提供 token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch(err) {
    return res.status(401).json({ error: 'token 无效或过期' });
  }
}

async function initDefaultData() {
  const userCount = await User.countDocuments();
  if (userCount === 0) {
    console.log('数据库为空，正在创建默认测试数据...');
    const hashedPwd = await bcrypt.hash('123456', 10);
    const user1 = await User.create({
      username: 'xiaoming',
      password: hashedPwd,
      nickname: '小明',
      phone: '13800000001',
      balance: 200,
      credit: 85,
      idCardVerified: true
    });
    const user2 = await User.create({
      username: 'hong',
      password: hashedPwd,
      nickname: '小红',
      phone: '13800000002',
      balance: 150,
      credit: 72,
      idCardVerified: true
    });

    await Task.create({
      title: '帮忙取快递',
      description: '西门驿站取件送到3栋',
      reward: 12,
      publisherId: user1._id.toString(),
      publisherName: '小明',
      locationAddress: '上海交大闵行',
      category: '取件'
    });
    await Task.create({
      title: '前端页面调试',
      description: 'CSS样式错位',
      reward: 45,
      publisherId: user2._id.toString(),
      publisherName: '小红',
      locationAddress: '徐家汇',
      category: '调试'
    });

    console.log('默认测试数据创建完成（2个任务）');
  }
}

// ============================================================
// 所有任务接口：确保 publisherName 不为 null
// ============================================================

// 获取 available 任务
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await Task.aggregate([
      { $match: { status: 'available' } },
      {
        $lookup: {
          from: 'users',
          localField: 'publisherId',
          foreignField: '_id',
          as: 'publisher'
        }
      },
      { $unwind: { path: '$publisher', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          publisherName: {
            $ifNull: [
              '$publisherName',
              { $ifNull: ['$publisher.nickname', '$publisher.username'] }
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          description: 1,
          reward: 1,
          status: 1,
          publisherId: 1,
          publisherName: 1,
          publisherPhone: 1,
          locationAddress: 1,
          latitude: 1,
          longitude: 1,
          takerId: 1,
          takerName: 1,
          takenAt: 1,
          travelStatus: 1,
          travelStartTime: 1,
          estimatedMinutes: 1,
          takerCompleted: 1,
          proofMedia: 1,
          mediaList: 1,
          category: 1,
          createdAt: 1,
          updatedAt: 1
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: 100 }
    ]);
    // 如果 publisherName 仍为 null，设置默认值
    tasks.forEach(t => {
      if (!t.publisherName) t.publisherName = '未知用户';
    });
    res.json(tasks);
  } catch (err) {
    console.error('获取任务列表失败:', err);
    res.status(500).json({ error: '获取任务列表失败' });
  }
});

// 获取所有任务（限制 100 条）
app.get('/api/tasks/all', async (req, res) => {
  try {
    const tasks = await Task.aggregate([
      {
        $lookup: {
          from: 'users',
          localField: 'publisherId',
          foreignField: '_id',
          as: 'publisher'
        }
      },
      { $unwind: { path: '$publisher', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          publisherName: {
            $ifNull: [
              '$publisherName',
              { $ifNull: ['$publisher.nickname', '$publisher.username'] }
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          description: 1,
          reward: 1,
          status: 1,
          publisherId: 1,
          publisherName: 1,
          publisherPhone: 1,
          locationAddress: 1,
          latitude: 1,
          longitude: 1,
          takerId: 1,
          takerName: 1,
          takenAt: 1,
          travelStatus: 1,
          travelStartTime: 1,
          estimatedMinutes: 1,
          takerCompleted: 1,
          proofMedia: 1,
          mediaList: 1,
          category: 1,
          createdAt: 1,
          updatedAt: 1
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: 100 }
    ]);
    tasks.forEach(t => {
      if (!t.publisherName) t.publisherName = '未知用户';
    });
    res.json(tasks);
  } catch (err) {
    console.error('获取所有任务失败:', err);
    res.status(500).json({ error: '获取所有任务失败' });
  }
});

// 获取单个任务
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const task = await Task.aggregate([
      { $match: { _id: new mongoose.Types.ObjectId(req.params.id) } },
      {
        $lookup: {
          from: 'users',
          localField: 'publisherId',
          foreignField: '_id',
          as: 'publisher'
        }
      },
      { $unwind: { path: '$publisher', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          publisherName: {
            $ifNull: [
              '$publisherName',
              { $ifNull: ['$publisher.nickname', '$publisher.username'] }
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          description: 1,
          reward: 1,
          status: 1,
          publisherId: 1,
          publisherName: 1,
          publisherPhone: 1,
          locationAddress: 1,
          latitude: 1,
          longitude: 1,
          takerId: 1,
          takerName: 1,
          takenAt: 1,
          travelStatus: 1,
          travelStartTime: 1,
          estimatedMinutes: 1,
          takerCompleted: 1,
          proofMedia: 1,
          mediaList: 1,
          category: 1,
          createdAt: 1,
          updatedAt: 1
        }
      }
    ]);
    if (!task || task.length === 0) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (!task[0].publisherName) task[0].publisherName = '未知用户';
    res.json(task[0]);
  } catch (err) {
    console.error('获取任务详情失败:', err);
    res.status(500).json({ error: '获取任务详情失败' });
  }
});

// 发布任务
app.post('/api/tasks', authMiddleware, async (req, res) => {
  const { title, description, reward, publisherName, publisherPhone, locationAddress, latitude, longitude, mediaList, category } = req.body;
  const publisherId = req.userId;
  const user = await User.findById(publisherId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.idCardVerified) return res.status(403).json({ error: '请先实名认证' });
  if (reward > user.balance) return res.status(400).json({ error: '余额不足' });
  await updateUserBalance(publisherId, -reward, reward);
  const task = new Task({
    title, description, reward, publisherId: publisherId.toString(),
    publisherName: publisherName || user.nickname || user.username || '未知用户',
    publisherPhone,
    locationAddress, latitude, longitude, mediaList, category, status: 'available'
  });
  await task.save();
  await Bill.create({ userId: publisherId, type: 'expense', amount: -reward, desc: `发布任务冻结：${title}` });
  res.json(task);
});

// 其他接口保持不变（省略，但包含）
app.put('/api/tasks/:id/cancel', authMiddleware, async (req, res) => { /* 略，和之前一样 */ });
app.put('/api/tasks/:id/accept', authMiddleware, async (req, res) => { /* 略 */ });
app.put('/api/tasks/:id/cancel-accept', authMiddleware, async (req, res) => { /* 略 */ });
app.put('/api/tasks/:id/status', authMiddleware, async (req, res) => { /* 略 */ });
app.post('/api/tasks/:id/submit-proof', authMiddleware, async (req, res) => { /* 略 */ });
app.post('/api/tasks/:id/confirm-payment', authMiddleware, async (req, res) => { /* 略 */ });
app.put('/api/tasks/:id/reward', authMiddleware, async (req, res) => { /* 略 */ });

app.get('/api/user/:id', async (req, res) => { /* 略 */ });
app.put('/api/user/:id', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/bills/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/user/:userId/conversations', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/messages/:taskId', async (req, res) => { /* 略 */ });
app.post('/api/messages', async (req, res) => { /* 略 */ });
app.put('/api/messages/read/:taskId/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => { /* 略 */ });
app.delete('/api/conversations/:taskId/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.post('/api/upload', upload.single('file'), (req, res) => { /* 略 */ });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const AMAP_KEY = '30107d62cf0ec682643d1097a48f7da4';
app.post('/api/geocode', async (req, res) => { /* 略，和之前一样 */ });
app.post('/api/regeo', async (req, res) => { /* 略 */ });
app.post('/api/verify-id', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/credit-logs/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/ratings/task/:taskId/user/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.get('/api/ratings/user/:userId', authMiddleware, async (req, res) => { /* 略 */ });
app.post('/api/ratings', authMiddleware, async (req, res) => { /* 略 */ });

// ============================================================
// 统计接口（直接计数，不加载全部任务）
// ============================================================
app.get('/api/stats/:userId', authMiddleware, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ error: '无权查看' });

  try {
    const published = await Task.countDocuments({ publisherId: userId });
    const accepted = await Task.countDocuments({ takerId: userId, status: 'ongoing' });
    const completed = await Task.countDocuments({ takerId: userId, status: 'completed' });
    res.json({ published, accepted, completed });
  } catch (err) {
    console.error('获取统计数据失败:', err);
    res.status(500).json({ error: '获取统计数据失败' });
  }
});

app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDefaultData();
});