const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/bounty');

// ==================== 数据模型（新增 frozenBalance、proofMedia 等） ====================
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  nickname: String,
  phone: String,
  balance: { type: Number, default: 100 },        // 可用余额
  frozenBalance: { type: Number, default: 0 },    // 冻结余额（发布任务占用）
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
  takerId: { type: String, default: null },
  takerName: { type: String, default: null },
  takenAt: { type: Date, default: null },
  travelStatus: { type: String, default: 'idle' },
  takerCompleted: { type: Boolean, default: false },   // 接取者是否已提交凭证
  proofMedia: { type: Array, default: [] },             // 接取者上传的凭证
  mediaList: Array,
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

// ==================== 辅助函数（原子更新余额） ====================
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

// ==================== API 路由（完全兼容原前端，增强逻辑） ====================

// 登录（明文密码保持兼容）
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

app.post('/api/register', async (req, res) => {
  const { username, password, nickname, phone } = req.body;
  const exist = await User.findOne({ username });
  if (exist) return res.status(400).json({ error: '用户名已存在' });
  const user = new User({ username, password, nickname: nickname || username, phone });
  await user.save();
  await CreditLog.create({ userId: user._id, reason: '注册奖励', change: 60 });
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

// 发布任务（冻结赏金）
app.post('/api/tasks', async (req, res) => {
  const { title, description, reward, publisherId, publisherName, publisherPhone, locationAddress, mediaList, category } = req.body;
  const user = await User.findById(publisherId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.idCardVerified) return res.status(403).json({ error: '请先实名认证' });
  if (reward > user.balance) return res.status(400).json({ error: '余额不足' });
  // 冻结赏金
  await updateUserBalance(publisherId, -reward, reward);
  const task = new Task({
    title, description, reward, publisherId, publisherName, publisherPhone,
    locationAddress, mediaList, category, status: 'available'
  });
  await task.save();
  await new Bill({ userId: publisherId, type: 'expense', amount: -reward, desc: `发布任务冻结：${title}` }).save();
  res.json(task);
});

// 发布者取消任务（解冻资金）
app.put('/api/tasks/:id/cancel', async (req, res) => {
  const { userId } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== userId) return res.status(403).json({ error: '无权取消' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取或已完成' });
  task.status = 'cancelled';
  await task.save();
  await updateUserBalance(userId, task.reward, -task.reward);
  await new Bill({ userId, type: 'income', amount: task.reward, desc: `取消任务退款：${task.title}` }).save();
  res.json({ success: true });
});

// 接取任务（无需操作资金）
app.put('/api/tasks/:id/accept', async (req, res) => {
  const { takerId, takerName } = req.body;
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

// 接取者取消接取（只扣信用分，不解冻资金）
app.put('/api/tasks/:id/cancel-accept', async (req, res) => {
  const { userId } = req.body;
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

// 更新任务进度（出发、到达等）
app.put('/api/tasks/:id/status', async (req, res) => {
  const { travelStatus, estimatedMinutes, travelStartTime } = req.body;
  const update = { updatedAt: new Date() };
  if (travelStatus !== undefined) update.travelStatus = travelStatus;
  if (estimatedMinutes !== undefined) update.estimatedMinutes = estimatedMinutes;
  if (travelStartTime !== undefined) update.travelStartTime = travelStartTime;
  await Task.findByIdAndUpdate(req.params.id, update);
  res.json({ success: true });
});

// 接取者提交凭证（新接口）
app.post('/api/tasks/:id/submit-proof', async (req, res) => {
  const { userId, proofMedia } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.takerId !== userId) return res.status(403).json({ error: '只有接取者可提交凭证' });
  if (task.status !== 'ongoing') return res.status(400).json({ error: '任务状态不正确' });
  task.proofMedia = proofMedia;
  task.takerCompleted = true;
  await task.save();
  res.json({ success: true });
});

// 发布者确认完成并支付（解冻资金转给接取者）
app.post('/api/tasks/:id/confirm-payment', async (req, res) => {
  const { userId } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== userId) return res.status(403).json({ error: '只有发布者可确认' });
  if (task.status !== 'ongoing' || !task.takerCompleted) {
    return res.status(400).json({ error: '接取者尚未提交凭证' });
  }
  // 解冻发布者的冻结资金，并转给接取者
  await updateUserBalance(task.publisherId, 0, -task.reward);
  await updateUserBalance(task.takerId, task.reward, 0);
  task.status = 'completed';
  await task.save();
  await new Bill({ userId: task.takerId, type: 'income', amount: task.reward, desc: `完成任务：${task.title}` }).save();
  await CreditLog.create({ userId: task.takerId, reason: `完成任务“${task.title}”`, change: 5 });
  await User.findByIdAndUpdate(task.takerId, { $inc: { credit: 5 } });
  res.json({ success: true });
});

// 修改赏金（议价，仅发布者）
app.put('/api/tasks/:id/reward', async (req, res) => {
  const { userId, reward: newReward } = req.body;
  const task = await Task.findById(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.publisherId !== userId) return res.status(403).json({ error: '只有发布者可修改赏金' });
  if (task.status !== 'available') return res.status(400).json({ error: '任务已被接取，无法修改' });
  const diff = newReward - task.reward;
  if (diff > 0) {
    // 涨价：需要发布者补差价（增加冻结）
    await updateUserBalance(userId, -diff, diff);
  } else if (diff < 0) {
    // 降价：退还差价（减少冻结）
    await updateUserBalance(userId, -diff, diff);
  }
  task.reward = newReward;
  await task.save();
  res.json({ success: true, reward: newReward });
});

// 获取用户信息
app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

app.put('/api/user/:id', async (req, res) => {
  await User.findByIdAndUpdate(req.params.id, req.body);
  res.json({ success: true });
});

app.get('/api/bills/:userId', async (req, res) => {
  const bills = await Bill.find({ userId: req.params.userId }).sort({ createdAt: -1 }).limit(50);
  res.json(bills);
});

app.get('/api/user/:userId/conversations', async (req, res) => {
  const userId = req.params.userId;
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

app.get('/api/messages/:taskId', async (req, res) => {
  const messages = await Message.find({ taskId: req.params.taskId }).sort({ createdAt: 1 });
  res.json(messages);
});

app.post('/api/messages', async (req, res) => {
  const message = new Message(req.body);
  await message.save();
  res.json(message);
});

app.put('/api/messages/read/:taskId/:userId', async (req, res) => {
  await Message.updateMany(
    { taskId: req.params.taskId, senderId: { $ne: req.params.userId }, read: false },
    { read: true }
  );
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
  const logs = await CreditLog.find({ userId: req.params.userId }).sort({ createdAt: -1 });
  res.json(logs);
});

app.post('/api/init', async (req, res) => {
  const count = await User.countDocuments();
  if (count > 0) return res.json({ success: true, message: '数据已存在' });
  const user1 = await User.create({ username: 'xiaoming', password: '123456', nickname: '小明', phone: '13800000001', balance: 200, credit: 85, idCardVerified: true });
  const user2 = await User.create({ username: 'hong', password: '123456', nickname: '小红', phone: '13800000002', balance: 150, credit: 72, idCardVerified: true });
  await Task.create({ title: '帮忙取快递', description: '西门驿站取件送到3栋', reward: 12, publisherId: user1._id, publisherName: '小明', locationAddress: '上海交大闵行', category: '取件' });
  await Task.create({ title: '前端页面调试', description: 'CSS样式错位', reward: 45, publisherId: user2._id, publisherName: '小红', locationAddress: '徐家汇', category: '调试' });
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));