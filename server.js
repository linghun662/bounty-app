const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_me';
const SALT_ROUNDS = 10;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 限流
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// 数据库连接
mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/bounty');

// ==================== 数据模型 ====================
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  nickname: String,
  phone: String,
  balance: { type: Number, default: 100 },      // 可用余额
  frozenBalance: { type: Number, default: 0 },  // 冻结余额（发布任务占用）
  credit: { type: Number, default: 60 },
  idCardVerified: { type: Boolean, default: false },
  signature: String,
  hometown: String,
  avatar: String
});
const User = mongoose.model('User', UserSchema);

const TaskSchema = new mongoose.Schema({
  title: String,
  description: String,
  reward: Number,
  status: { type: String, default: 'available' }, // available, ongoing, completed, cancelled
  publisherId: String,
  publisherName: String,
  publisherPhone: String,
  locationAddress: String,
  locationCoords: { lat: Number, lng: Number },   // 地理坐标
  takerId: { type: String, default: null },
  takerName: { type: String, default: null },
  takenAt: { type: Date, default: null },
  travelStatus: { type: String, default: 'idle' },
  takerCompleted: { type: Boolean, default: false },
  proofMedia: { type: Array, default: [] },       // 接取者提交的凭证
  mediaList: Array,      // 发布时上传的媒体
  category: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const Task = mongoose.model('Task', TaskSchema);

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

// ==================== 辅助函数 ====================
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: '未提供认证令牌' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: '无效令牌' });
  }
};

// 更新用户资金（原子操作）
async function updateUserBalance(userId, deltaBalance, deltaFrozen = 0) {
  const user = await User.findById(userId);
  if (!user) throw new Error('用户不存在');
  if (user.balance + deltaBalance < 0 || user.frozenBalance + deltaFrozen < 0) {
    throw new Error('余额不足');
  }
  user.balance += deltaBalance;
  user.frozenBalance += deltaFrozen;
  await user.save();
  return user;
}

// ==================== API 路由 ====================
// 注册
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, nickname, phone } = req.body;
    const exist = await User.findOne({ username });
    if (exist) return res.status(400).json({ error: '用户名已存在' });
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const user = new User({ username, password: hashed, nickname: nickname || username, phone });
    await user.save();
    await CreditLog.create({ userId: user._id, reason: '注册奖励', change: 60 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: '用户名或密码错误' });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取当前用户信息（需认证）
app.get('/api/me', verifyToken, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
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
  });
});

// 获取用户公开信息（无需认证）
app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({
    id: user._id,
    nickname: user.nickname,
    credit: user.credit,
    signature: user.signature,
    hometown: user.hometown,
    avatar: user.avatar,
    phone: user.phone
  });
});

// 更新个人信息（需认证）
app.put('/api/user', verifyToken, async (req, res) => {
  const updates = req.body;
  delete updates._id;
  delete updates.balance;
  delete updates.frozenBalance;
  delete updates.credit;
  await User.findByIdAndUpdate(req.userId, updates);
  res.json({ success: true });
});

// 实名认证
app.post('/api/verify-id', verifyToken, async (req, res) => {
  const { realName, idCard } = req.body;
  if (!realName || !idCard || idCard.length < 15) {
    return res.status(400).json({ error: '认证信息无效' });
  }
  // 模拟实名认证通过
  await User.findByIdAndUpdate(req.userId, { idCardVerified: true });
  res.json({ success: true });
});

// ==================== 任务相关 ====================
// 获取可接取任务列表
app.get('/api/tasks', async (req, res) => {
  const tasks = await Task.find({ status: 'available' }).sort({ createdAt: -1 });
  res.json(tasks);
});

// 获取所有任务（管理用）
app.get('/api/tasks/all', verifyToken, async (req, res) => {
  const tasks = await Task.find().sort({ createdAt: -1 });
  res.json(tasks);
});

// 获取单个任务详情
app.get('/api/tasks/:id', async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

// 发布任务（需认证）
app.post('/api/tasks', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user.idCardVerified) return res.status(403).json({ error: '请先完成实名认证' });
    const { title, description, reward, locationAddress, mediaList, category } = req.body;
    if (reward > user.balance) return res.status(400).json({ error: '余额不足' });
    // 冻结资金
    await updateUserBalance(req.userId, -reward, reward);
    const task = new Task({
      title, description, reward,
      publisherId: req.userId,
      publisherName: user.nickname,
      publisherPhone: user.phone,
      locationAddress,
      mediaList,
      category,
      status: 'available'
    });
    await task.save();
    await new Bill({ userId: req.userId, type: 'expense', amount: -reward, desc: `发布任务：${title}（冻结）` }).save();
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 发布者取消任务（需认证，仅 available 状态）
app.put('/api/tasks/:id/cancel', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== req.userId) return res.status(403).json({ error: '无权操作' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取或已完成，无法取消' });
  task.status = 'cancelled';
  await task.save();
  // 解冻资金并退还
  await updateUserBalance(req.userId, task.reward, -task.reward);
  await new Bill({ userId: req.userId, type: 'income', amount: task.reward, desc: `取消任务退款：${task.title}` }).save();
  res.json({ success: true });
});

// 接取任务（需认证）
app.put('/api/tasks/:id/accept', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取' });
  const user = await User.findById(req.userId);
  task.status = 'ongoing';
  task.takerId = req.userId;
  task.takerName = user.nickname;
  task.takenAt = new Date();
  await task.save();
  res.json({ success: true });
});

// 接取者取消接取（需认证）
app.put('/api/tasks/:id/cancel-accept', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== req.userId) return res.status(403).json({ error: '无权操作' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  task.status = 'available';
  task.takerId = null;
  task.takerName = null;
  task.takenAt = null;
  task.travelStatus = 'idle';
  task.takerCompleted = false;
  await task.save();
  // 扣除信用分
  const user = await User.findById(req.userId);
  const newCredit = Math.max(0, user.credit - 5);
  const change = -5;
  user.credit = newCredit;
  await user.save();
  await CreditLog.create({ userId: req.userId, reason: '取消接取任务', change });
  res.json({ success: true });
});

// 更新任务进度（travelStatus等）
app.put('/api/tasks/:id/status', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  // 只有接取者可以更新 travelStatus
  if (task.takerId !== req.userId) return res.status(403).json({ error: '只有接取者可更新进度' });
  const allowed = ['travelStatus', 'estimatedMinutes', 'travelStartTime'];
  const updates = {};
  for (let key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  updates.updatedAt = new Date();
  await Task.findByIdAndUpdate(req.params.id, updates);
  res.json({ success: true });
});

// 提交完成凭证（接取者）
app.post('/api/tasks/:id/submit-proof', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== req.userId) return res.status(403).json({ error: '只有接取者可提交凭证' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  const { proofMedia } = req.body;
  task.proofMedia = proofMedia;
  task.takerCompleted = true;
  await task.save();
  res.json({ success: true });
});

// 发布者确认完成并结算
app.post('/api/tasks/:id/confirm-payment', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== req.userId) return res.status(403).json({ error: '只有发布者可确认结算' });
  if (task.status !== 'ongoing' || !task.takerCompleted) return res.status(400).json({ error: '接取者尚未提交凭证或任务已完成' });
  // 将冻结资金转给接取者
  await updateUserBalance(task.publisherId, 0, -task.reward); // 解冻发布者的冻结资金
  await updateUserBalance(task.takerId, task.reward, 0);      // 增加接取者余额
  task.status = 'completed';
  await task.save();
  await new Bill({ userId: task.takerId, type: 'income', amount: task.reward, desc: `完成任务：${task.title}` }).save();
  await CreditLog.create({ userId: task.takerId, reason: `完成任务“${task.title}”`, change: 5 });
  await User.findByIdAndUpdate(task.takerId, { $inc: { credit: 5 } });
  res.json({ success: true });
});

// 修改赏金（议价，仅发布者）
app.put('/api/tasks/:id/reward', verifyToken, async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== req.userId) return res.status(403).json({ error: '只有发布者可修改赏金' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取，无法修改赏金' });
  const newReward = parseFloat(req.body.reward);
  if (isNaN(newReward) || newReward <= 0) return res.status(400).json({ error: '赏金无效' });
  const oldReward = task.reward;
  const diff = newReward - oldReward;
  if (diff > 0) {
    // 涨价：需要发布者补足差价（从可用余额中增加冻结）
    await updateUserBalance(req.userId, -diff, diff);
  } else if (diff < 0) {
    // 降价：退还差价（从冻结资金中解冻部分）
    await updateUserBalance(req.userId, -diff, diff);
  }
  task.reward = newReward;
  await task.save();
  res.json({ success: true, reward: newReward });
});

// ==================== 消息相关 ====================
app.get('/api/messages/:taskId', async (req, res) => {
  const messages = await Message.find({ taskId: req.params.taskId }).sort({ createdAt: 1 });
  res.json(messages);
});

app.post('/api/messages', verifyToken, async (req, res) => {
  const { taskId, text, isNego } = req.body;
  const user = await User.findById(req.userId);
  const message = new Message({
    taskId,
    senderId: req.userId,
    senderName: user.nickname,
    text,
    isNego,
    time: new Date().toLocaleTimeString(),
    createdAt: new Date()
  });
  await message.save();
  res.json(message);
});

app.put('/api/messages/read/:taskId', verifyToken, async (req, res) => {
  await Message.updateMany({ taskId: req.params.taskId, senderId: { $ne: req.userId }, read: false }, { read: true });
  res.json({ success: true });
});

// 获取用户的会话列表（含未读数）
app.get('/api/user/conversations', verifyToken, async (req, res) => {
  const userId = req.userId;
  const tasks = await Task.find({
    $or: [{ publisherId: userId }, { takerId: userId }],
    status: { $ne: 'cancelled' }
  }).sort({ updatedAt: -1 });
  const conversations = [];
  for (const task of tasks) {
    const lastMsg = await Message.findOne({ taskId: task._id.toString() }).sort({ createdAt: -1 });
    const unreadCount = await Message.countDocuments({
      taskId: task._id.toString(),
      senderId: { $ne: userId },
      read: false
    });
    let otherId = task.publisherId === userId ? task.takerId : task.publisherId;
    let otherName = task.publisherId === userId ? task.takerName : task.publisherName;
    if ((!otherId || !otherName) && lastMsg) {
      otherId = lastMsg.senderId === userId ? null : lastMsg.senderId;
      otherName = lastMsg.senderId === userId ? null : lastMsg.senderName;
    }
    if (otherId && otherName) {
      conversations.push({
        taskId: task._id,
        otherId,
        otherName,
        lastMsg: lastMsg?.text || '暂无消息',
        reward: task.reward,
        taskTitle: task.title,
        unread: unreadCount
      });
    }
  }
  res.json(conversations);
});

// 账单
app.get('/api/bills', verifyToken, async (req, res) => {
  const bills = await Bill.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(50);
  res.json(bills);
});

// 信用记录
app.get('/api/credit-logs', verifyToken, async (req, res) => {
  const logs = await CreditLog.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json(logs);
});

// 初始化测试数据（仅开发用）
app.post('/api/init', async (req, res) => {
  if (await User.countDocuments() > 0) return res.json({ success: true, message: '数据已存在' });
  const hash = await bcrypt.hash('123456', SALT_ROUNDS);
  const user1 = await User.create({ username: 'xiaoming', password: hash, nickname: '小明', phone: '13800000001', balance: 200, frozenBalance: 0, credit: 85, idCardVerified: true, signature: '靠谱跑腿', hometown: '上海' });
  const user2 = await User.create({ username: 'hong', password: hash, nickname: '小红', phone: '13800000002', balance: 150, frozenBalance: 0, credit: 72, idCardVerified: true, signature: '前端开发', hometown: '北京' });
  await Task.create({ title: '帮忙取快递', description: '西门驿站取件送到3栋', reward: 12, publisherId: user1._id, publisherName: '小明', locationAddress: '上海交大闵行', category: '取件', status: 'available' });
  await Task.create({ title: '前端页面调试', description: 'CSS样式错位，远程15分钟搞定', reward: 45, publisherId: user2._id, publisherName: '小红', locationAddress: '徐家汇', category: '调试', status: 'available' });
  res.json({ success: true });
});

// 前端路由
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));