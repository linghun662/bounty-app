const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 连接 MongoDB（Railway 上应设置环境变量 MONGODB_URL）
mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/bounty');

// ==================== 数据模型 ====================
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  nickname: String,
  phone: String,
  balance: { type: Number, default: 100 },
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
  mediaList: Array,
  proofMedia: Array,
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
  time: { type: String, default: () => new Date().toLocaleTimeString() },
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

// ==================== API 路由 ====================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  res.json({
    success: true,
    user: {
      id: user._id,
      username: user.username,
      nickname: user.nickname,
      balance: user.balance,
      credit: user.credit,
      idCardVerified: user.idCardVerified,
      signature: user.signature,
      hometown: user.hometown,
      avatar: user.avatar,
      phone: user.phone
    }
  });
});

app.post('/api/register', async (req, res) => {
  const { username, password, nickname, phone } = req.body;
  const exist = await User.findOne({ username });
  if (exist) return res.status(400).json({ error: '用户名已存在' });
  const user = new User({ username, password, nickname: nickname || username, phone });
  await user.save();
  res.json({ success: true });
});

app.get('/api/tasks', async (req, res) => {
  const tasks = await Task.find({ status: 'available' }).sort({ createdAt: -1 });
  res.json(tasks);
});

app.get('/api/tasks/all', async (req, res) => {
  const tasks = await Task.find().sort({ createdAt: -1 });
  res.json(tasks);
});

app.get('/api/tasks/:id', async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  res.json(task);
});

app.post('/api/tasks', async (req, res) => {
  const task = new Task(req.body);
  await task.save();
  await User.findByIdAndUpdate(task.publisherId, { $inc: { balance: -task.reward } });
  await new Bill({ userId: task.publisherId, type: 'expense', amount: -task.reward, desc: `发布任务：${task.title}` }).save();
  res.json(task);
});

app.put('/api/tasks/:id/accept', async (req, res) => {
  const { takerId, takerName, takerPhone } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取' });
  task.status = 'ongoing';
  task.takerId = takerId;
  task.takerName = takerName;
  task.takerPhone = takerPhone;
  task.takenAt = new Date();
  task.updatedAt = new Date();
  await task.save();
  res.json({ success: true, task });
});

app.put('/api/tasks/:id/cancel-accept', async (req, res) => {
  const { userId } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== userId) return res.status(403).json({ error: '无权取消' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  task.status = 'available';
  task.takerId = null;
  task.takerName = null;
  task.takenAt = null;
  task.updatedAt = new Date();
  await task.save();
  const user = await User.findById(userId);
  if (user) {
    user.credit = Math.max(0, user.credit - 5);
    await user.save();
  }
  res.json({ success: true });
});

app.put('/api/tasks/:id/status', async (req, res) => {
  await Task.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() });
  res.json({ success: true });
});

app.post('/api/tasks/:id/complete', async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  await User.findByIdAndUpdate(task.takerId, { $inc: { balance: task.reward } });
  await new Bill({ userId: task.takerId, type: 'income', amount: task.reward, desc: `完成任务：${task.title}` }).save();
  task.status = 'completed';
  task.updatedAt = new Date();
  await task.save();
  res.json({ success: true });
});

app.post('/api/tasks/:id/confirm-payment', async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'ongoing' || !task.takerCompleted) return res.status(400).json({ error: '无法结算' });
  await User.findByIdAndUpdate(task.takerId, { $inc: { balance: task.reward } });
  await new Bill({ userId: task.takerId, type: 'income', amount: task.reward, desc: `完成任务：${task.title}` }).save();
  task.status = 'completed';
  task.updatedAt = new Date();
  await task.save();
  res.json({ success: true });
});

app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

app.put('/api/user/:id', async (req, res) => {
  const updates = req.body;
  await User.findByIdAndUpdate(req.params.id, updates);
  res.json({ success: true });
});

app.get('/api/bills/:userId', async (req, res) => {
  const bills = await Bill.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
  res.json(bills);
});

// ==================== 关键：会话列表接口 ====================
app.get('/api/user/:userId/conversations', async (req, res) => {
  const userId = req.params.userId;
  const tasks = await Task.find({
    $or: [{ publisherId: userId }, { takerId: userId }]
  }).sort({ updatedAt: -1 });
  const conversations = [];
  for (const task of tasks) {
    const lastMsg = await Message.findOne({ taskId: task._id.toString() }).sort({ createdAt: -1 });
    const otherId = task.publisherId === userId ? task.takerId : task.publisherId;
    const otherName = task.publisherId === userId ? task.takerName : task.publisherName;
    if (otherId && otherName) {
      conversations.push({
        taskId: task._id,
        otherId,
        otherName,
        lastMsg: lastMsg?.text || '暂无消息',
        reward: task.reward,
        taskTitle: task.title,
        unread: 0,
        takenAt: task.takenAt
      });
    }
  }
  res.json(conversations);
});

app.get('/api/messages/:taskId', async (req, res) => {
  const messages = await Message.find({ taskId: req.params.taskId }).sort({ createdAt: 1 });
  res.json(messages);
});

app.post('/api/messages', async (req, res) => {
  const message = new Message(req.body);
  await message.save();
  // 同时更新对应任务的 updatedAt
  await Task.findByIdAndUpdate(message.taskId, { updatedAt: new Date() });
  res.json(message);
});

app.put('/api/messages/read/:taskId/:userId', async (req, res) => {
  await Message.updateMany({ taskId: req.params.taskId, senderId: { $ne: req.params.userId }, read: false }, { read: true });
  res.json({ success: true });
});

app.post('/api/verify-id', async (req, res) => {
  const { userId, realName, idCard } = req.body;
  if (realName && idCard.length >= 15) {
    await User.findByIdAndUpdate(userId, { idCardVerified: true });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: '认证信息无效' });
  }
});

app.get('/api/credit-logs/:userId', async (req, res) => {
  res.json([{ reason: '注册奖励', change: 60, time: new Date().toLocaleString() }]);
});

app.post('/api/init', async (req, res) => {
  const count = await User.countDocuments();
  if (count > 0) return res.json({ success: true, message: '数据已存在' });
  const user1 = await User.create({ username: 'xiaoming', password: '123456', nickname: '小明', phone: '13800000001', balance: 188, credit: 85, idCardVerified: true, signature: '靠谱跑腿', hometown: '上海' });
  const user2 = await User.create({ username: 'hong', password: '123456', nickname: '小红', phone: '13800000002', balance: 95, credit: 72, idCardVerified: false, signature: '前端开发', hometown: '北京' });
  await Task.create({ title: '帮忙取快递', description: '西门驿站取件送到3栋', reward: 12, publisherId: user1._id, publisherName: '小明', locationAddress: '上海交大闵行', category: '取件' });
  await Task.create({ title: '前端页面调试', description: 'CSS样式错位，远程15分钟搞定', reward: 45, publisherId: user2._id, publisherName: '小红', locationAddress: '徐家汇', category: '调试' });
  res.json({ success: true });
});

// 单页应用路由（必须放在所有 API 路由之后）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));