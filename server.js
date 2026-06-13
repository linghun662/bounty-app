const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// 确保 fetch 可用（Node 18+ 内置，低版本需要 node-fetch）
let fetch;
try {
  fetch = global.fetch;
  if (!fetch) throw new Error();
} catch(e) {
  fetch = require('node-fetch');
}

// 带超时的 fetch 封装（用于高德 API）
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

// CORS 配置
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

// 确保 uploads 目录存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// multer 配置
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

// 连接 MongoDB
mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/bounty', {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

// ==================== 数据模型 ====================
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
  takerId: { type: String, default: null },
  takerName: { type: String, default: null },
  takenAt: { type: Date, default: null },
  travelStatus: { type: String, default: 'idle' },
  takerCompleted: { type: Boolean, default: false },
  proofMedia: { type: Array, default: [] },
  mediaList: Array,
  category: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// 添加索引优化查询
TaskSchema.index({ status: 1, createdAt: -1 });
TaskSchema.index({ publisherId: 1 });
TaskSchema.index({ takerId: 1 });

const Task = mongoose.model('Task', TaskSchema);

// 确保索引创建
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

// ==================== 辅助函数 ====================
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

// ==================== 自动初始化默认数据 ====================
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
      publisherId: user1._id,
      publisherName: '小明',
      locationAddress: '上海交大闵行',
      category: '取件'
    });
    await Task.create({
      title: '前端页面调试',
      description: 'CSS样式错位',
      reward: 45,
      publisherId: user2._id,
      publisherName: '小红',
      locationAddress: '徐家汇',
      category: '调试'
    });
    console.log('默认测试数据创建完成');
  }
}

// ==================== API 路由 ====================
app.post('/api/register', async (req, res) => {
  const { username, password, nickname, phone } = req.body;
  const exist = await User.findOne({ username });
  if (exist) return res.status(400).json({ error: '用户名已存在' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ username, password: hashedPassword, nickname: nickname || username, phone });
  await user.save();
  await CreditLog.create({ userId: user._id, reason: '注册奖励', change: 60 });
  res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  let isValid = false;
  try {
    isValid = await bcrypt.compare(password, user.password);
  } catch(e) { isValid = false; }

  // 兼容旧明文密码
  if (!isValid && user.password && user.password.length < 60) {
    if (user.password === password) {
      isValid = true;
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.updateOne({ _id: user._id }, { $set: { password: hashedPassword } });
      console.log(`用户 ${username} 的密码已从明文升级为 bcrypt`);
    }
  }

  if (!isValid) return res.status(401).json({ error: '用户名或密码错误' });

  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    success: true,
    token,
    user: {
      id: user._id,
      username: user.username,
      nickname: user.nickname,
      balance: user.balance,
      frozenBalance: user.frozenBalance,
      credit: user.credit,
      idCardVerified: user.idCardVerified,
      signature: user.signature,
      hometown: user.hometown,
      avatar: user.avatar,
      phone: user.phone
    }
  });
});

app.get('/api/tasks', async (req, res) => {
  const tasks = await Task.find({ status: 'available' })
    .select('-mediaList -proofMedia')
    .sort({ createdAt: -1 })
    .lean();
  res.json(tasks);
});

app.get('/api/tasks/all', async (req, res) => {
  const tasks = await Task.find()
    .select('-mediaList -proofMedia')
    .sort({ createdAt: -1 })
    .lean();
  res.json(tasks);
});

app.get('/api/tasks/:id', async (req, res) => {
  const task = await Task.findById(req.params.id).lean();
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

app.post('/api/tasks', authMiddleware, async (req, res) => {
  const { title, description, reward, publisherName, publisherPhone, locationAddress, mediaList, category } = req.body;
  const publisherId = req.userId;
  const user = await User.findById(publisherId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.idCardVerified) return res.status(403).json({ error: '请先实名认证' });
  if (reward > user.balance) return res.status(400).json({ error: '余额不足' });
  await updateUserBalance(publisherId, -reward, reward);
  const task = new Task({
    title, description, reward, publisherId, publisherName, publisherPhone,
    locationAddress, mediaList, category, status: 'available'
  });
  await task.save();
  await Bill.create({ userId: publisherId, type: 'expense', amount: -reward, desc: `发布任务冻结：${title}` });
  res.json(task);
});

app.put('/api/tasks/:id/cancel', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const task = await Task.findById(req.params.id).select('status publisherId reward title').lean();
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId.toString() !== userId.toString()) return res.status(403).json({ error: '无权取消' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取或已完成' });
  await Task.updateOne({ _id: req.params.id }, { $set: { status: 'cancelled', updatedAt: new Date() } });
  await updateUserBalance(userId, task.reward, -task.reward);
  await Bill.create({ userId, type: 'income', amount: task.reward, desc: `取消任务退款：${task.title || '未命名任务'}` });
  res.json({ success: true });
});

app.put('/api/tasks/:id/accept', authMiddleware, async (req, res) => {
  const takerId = req.userId;
  const { takerName } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取' });
  task.status = 'ongoing';
  task.takerId = takerId;
  task.takerName = takerName;
  task.takenAt = new Date();
  await task.save();
  res.json({ success: true });
});

app.put('/api/tasks/:id/cancel-accept', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== userId) return res.status(403).json({ error: '无权取消' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '状态错误' });
  task.status = 'available';
  task.takerId = null;
  task.takerName = null;
  task.takenAt = null;
  task.travelStatus = 'idle';
  task.takerCompleted = false;
  await task.save();
  const user = await User.findById(userId);
  if (user) {
    const newCredit = Math.max(0, user.credit - 5);
    await User.findByIdAndUpdate(userId, { credit: newCredit });
    await CreditLog.create({ userId, reason: '取消接取任务', change: -5 });
  }
  res.json({ success: true });
});

app.put('/api/tasks/:id/status', authMiddleware, async (req, res) => {
  const { travelStatus, estimatedMinutes, travelStartTime } = req.body;
  const update = { updatedAt: new Date() };
  if (travelStatus !== undefined) update.travelStatus = travelStatus;
  if (estimatedMinutes !== undefined) update.estimatedMinutes = estimatedMinutes;
  if (travelStartTime !== undefined) update.travelStartTime = travelStartTime;
  await Task.updateOne({ _id: req.params.id }, { $set: update });
  res.json({ success: true });
});

app.post('/api/tasks/:id/submit-proof', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { proofMedia } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== userId) return res.status(403).json({ error: '只有接取者可提交凭证' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  task.proofMedia = proofMedia;
  task.takerCompleted = true;
  await task.save();
  res.json({ success: true });
});

app.post('/api/tasks/:id/confirm-payment', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== userId) return res.status(403).json({ error: '只有发布者可确认' });
  if (task.status !== 'ongoing' || !task.takerCompleted) {
    return res.status(400).json({ error: '接取者尚未提交凭证' });
  }
  await updateUserBalance(task.publisherId, 0, -task.reward);
  await updateUserBalance(task.takerId, task.reward, 0);
  task.status = 'completed';
  await task.save();
  await Bill.create({ userId: task.takerId, type: 'income', amount: task.reward, desc: `完成任务：${task.title}` });
  await CreditLog.create({ userId: task.takerId, reason: `完成任务“${task.title}”`, change: 5 });
  await User.findByIdAndUpdate(task.takerId, { $inc: { credit: 5 } });
  res.json({ success: true });
});

app.put('/api/tasks/:id/reward', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { reward: newReward } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== userId) return res.status(403).json({ error: '只有发布者可修改赏金' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取，无法修改' });
  const diff = newReward - task.reward;
  if (diff > 0) {
    await updateUserBalance(userId, -diff, diff);
  } else if (diff < 0) {
    await updateUserBalance(userId, -diff, diff);
  }
  task.reward = newReward;
  await task.save();
  res.json({ success: true, reward: newReward });
});

app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id).lean();
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

app.put('/api/user/:id', authMiddleware, async (req, res) => {
  if (req.params.id !== req.userId) return res.status(403).json({ error: '无权修改' });
  await User.updateOne({ _id: req.params.id }, { $set: req.body });
  res.json({ success: true });
});

app.get('/api/bills/:userId', authMiddleware, async (req, res) => {
  if (req.params.userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  const bills = await Bill.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50).lean();
  res.json(bills);
});

app.get('/api/user/:userId/conversations', authMiddleware, async (req, res) => {
  const userId = req.params.userId;
  if (userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  const user = await User.findById(userId).lean();
  const deletedSet = new Set(user.deletedConversations || []);
  const tasks = await Task.find({
    $or: [{ publisherId: userId }, { takerId: userId }],
    status: { $ne: 'cancelled' }
  }).select('-mediaList -proofMedia').sort({ updatedAt: -1 }).lean();
  const conversations = [];
  for (const task of tasks) {
    if (deletedSet.has(task._id.toString())) continue;
    const lastMsg = await Message.findOne({ taskId: task._id.toString() }).sort({ createdAt: -1 }).lean();
    const unreadCount = await Message.countDocuments({
      taskId: task._id.toString(),
      senderId: { $ne: userId },
      read: false
    });
    let otherId = task.publisherId === userId ? task.takerId : task.publisherId;
    let otherName = task.publisherId === userId ? task.takerName : task.publisherName;
    if (otherId && otherName) {
      conversations.push({
        taskId: task._id,
        otherId,
        otherName,
        lastMsg: lastMsg?.text || null,
        reward: task.reward,
        taskTitle: task.title,
        unread: unreadCount
      });
    }
  }
  res.json(conversations);
});

app.get('/api/messages/:taskId', async (req, res) => {
  const messages = await Message.find({ taskId: req.params.taskId }).sort({ createdAt: 1 }).lean();
  res.json(messages);
});

app.post('/api/messages', async (req, res) => {
  const message = new Message(req.body);
  await message.save();
  res.json(message);
});

app.put('/api/messages/read/:taskId/:userId', authMiddleware, async (req, res) => {
  const { taskId, userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ error: '无权操作' });
  await Message.updateMany(
    { taskId, senderId: { $ne: userId }, read: false },
    { $set: { read: true } }
  );
  res.json({ success: true });
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const message = await Message.findById(req.params.messageId);
  if (!message) return res.status(404).json({ error: '消息不存在' });
  if (message.senderId !== userId) return res.status(403).json({ error: '无权删除' });
  await Message.deleteOne({ _id: req.params.messageId });
  res.json({ success: true });
});

app.delete('/api/conversations/:taskId/:userId', authMiddleware, async (req, res) => {
  const { taskId, userId } = req.params;
  if (userId !== req.userId) return res.status(403).json({ error: '无权操作' });
  await User.updateOne({ _id: userId }, { $addToSet: { deletedConversations: taskId } });
  res.json({ success: true });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有文件' });
  const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 地理编码代理（正向） - 使用带超时的 fetch
app.post('/api/geocode', async (req, res) => {
  const { address } = req.body;
  const AMAP_KEY = process.env.AMAP_KEY || '30107d62cf0ec682643d1097a48f7da4';
  if (!address) return res.status(400).json({ error: '地址不能为空' });
  try {
    let cached = await GeocodeCache.findOne({ address });
    if (cached && cached.expires > Date.now()) {
      return res.json({ lat: cached.lat, lng: cached.lng });
    }
    const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&key=${AMAP_KEY}&output=JSON`;
    const response = await fetchWithTimeout(url, {}, 5000);
    const data = await response.json();
    if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
      const loc = data.geocodes[0].location.split(',');
      const lng = parseFloat(loc[0]);
      const lat = parseFloat(loc[1]);
      if (cached) {
        cached.lat = lat;
        cached.lng = lng;
        cached.expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await cached.save();
      } else {
        await GeocodeCache.create({ address, lat, lng });
      }
      res.json({ lat, lng });
    } else {
      res.status(404).json({ error: '地址无法解析' });
    }
  } catch (err) {
    console.error('地理编码错误', err);
    res.status(500).json({ error: '地理编码失败' });
  }
});

// 逆地理编码 - 使用带超时的 fetch
app.post('/api/regeo', async (req, res) => {
  const { lat, lng } = req.body;
  const AMAP_KEY = process.env.AMAP_KEY || '30107d62cf0ec682643d1097a48f7da4';
  if (!lat || !lng) return res.status(400).json({ error: '缺少经纬度' });
  try {
    const url = `https://restapi.amap.com/v3/geocode/regeo?output=json&location=${lng},${lat}&key=${AMAP_KEY}&radius=200&extensions=all`;
    const response = await fetchWithTimeout(url, {}, 5000);
    const data = await response.json();
    if (data.status === '1' && data.regeocode) {
      let address = data.regeocode.formatted_address;
      res.json({ address });
    } else {
      res.status(404).json({ error: '无法解析位置' });
    }
  } catch (err) {
    console.error('逆地理编码错误', err);
    res.status(500).json({ error: '逆地理编码失败' });
  }
});

app.post('/api/verify-id', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { realName, idCard } = req.body;
  if (realName && idCard.length >= 15) {
    await User.updateOne({ _id: userId }, { $set: { idCardVerified: true } });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: '认证信息无效' });
  }
});

app.get('/api/credit-logs/:userId', authMiddleware, async (req, res) => {
  if (req.params.userId !== req.userId) return res.status(403).json({ error: '无权查看' });
  const logs = await CreditLog.find({ userId: req.params.userId }).sort({ createdAt: -1 }).lean();
  res.json(logs);
});

// ==================== 前端静态文件托管 ====================
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 启动服务器 ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDefaultData();
});