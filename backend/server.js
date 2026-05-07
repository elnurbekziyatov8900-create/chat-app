require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { protectSocket } = require('./middleware/auth');
const Message = require('./models/Message');
const User = require('./models/User');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');

const app = express();
const server = http.createServer(app);

// ─── Socket.io Setup ──────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB for socket messages
});

// ─── Express Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { message: 'Too many requests. Please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { message: 'Too many requests. Please try again later.' }
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// Static files
const uploadsDir = path.join(__dirname, process.env.UPLOADS_DIR || 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ─── Socket.io Authentication ─────────────────────────────────────────────────
io.use(protectSocket);

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();

io.on('connection', async (socket) => {
  const userId = socket.user._id.toString();

  // Track socket
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);

  // Mark user online
  await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
  io.emit('user:status', { userId, isOnline: true });

  console.log(`[Socket] ${socket.user.username} connected (${socket.id})`);

  // ── Join own room for direct messages
  socket.join(userId);

  // ── Send message
  socket.on('message:send', async (data) => {
    try {
      const { recipientId, content } = data;

      if (!recipientId || !content) return;

      const sanitizedContent = content.trim().slice(0, 5000);
      if (!sanitizedContent) return;

      const conversationId = Message.getConversationId(userId, recipientId);

      const message = await Message.create({
        conversationId,
        sender: userId,
        recipient: recipientId,
        content: sanitizedContent
      });

      await message.populate('sender', 'username');
      await message.populate('recipient', 'username');

      const msgObj = message.toObject();

      // Emit to sender and recipient rooms
      io.to(userId).emit('message:new', msgObj);
      io.to(recipientId).emit('message:new', msgObj);

    } catch (err) {
      console.error('[Socket] message:send error:', err);
      socket.emit('error', { message: 'Failed to send message.' });
    }
  });

  // ── Typing indicator
  socket.on('typing:start', ({ recipientId }) => {
    if (recipientId) {
      io.to(recipientId).emit('typing:start', { userId, username: socket.user.username });
    }
  });

  socket.on('typing:stop', ({ recipientId }) => {
    if (recipientId) {
      io.to(recipientId).emit('typing:stop', { userId });
    }
  });

  // ── Mark messages as read
  socket.on('messages:read', async ({ conversationId, senderId }) => {
    try {
      await Message.updateMany(
        { conversationId, recipient: userId, read: false },
        { $set: { read: true } }
      );
      // Notify sender their messages were read
      if (senderId) {
        io.to(senderId).emit('messages:read', { conversationId, readBy: userId });
      }
    } catch (err) {
      console.error('[Socket] messages:read error:', err);
    }
  });

  // ── Media sent notification (after REST upload)
  socket.on('media:sent', (messageObj) => {
    if (messageObj && messageObj.recipient) {
      const recipientId = typeof messageObj.recipient === 'object'
        ? messageObj.recipient._id.toString()
        : messageObj.recipient.toString();
      io.to(recipientId).emit('message:new', messageObj);
      io.to(userId).emit('message:new', messageObj);
    }
  });

  // ── Disconnect
  socket.on('disconnect', async () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
        io.emit('user:status', { userId, isOnline: false });
      }
    }
    console.log(`[Socket] ${socket.user.username} disconnected (${socket.id})`);
  });
});

// ─── Cleanup Job: Delete expired media files ──────────────────────────────────
// Runs every hour — finds messages with expired files and removes them from disk
cron.schedule('0 * * * *', async () => {
  try {
    const now = new Date();
    const expiredMessages = await Message.find({
      expiresAt: { $lte: now },
      mediaFilename: { $ne: null }
    }).select('mediaFilename');

    for (const msg of expiredMessages) {
      const filePath = path.join(uploadsDir, msg.mediaFilename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Cleanup] Deleted expired file: ${msg.mediaFilename}`);
      }
    }

    if (expiredMessages.length > 0) {
      console.log(`[Cleanup] Processed ${expiredMessages.length} expired media files`);
    }
  } catch (err) {
    console.error('[Cleanup] Error during media cleanup:', err);
  }
});

// Also clean up orphaned files in uploads dir every 6 hours
cron.schedule('0 */6 * * *', async () => {
  try {
    const files = fs.readdirSync(uploadsDir);
    const dbFilenames = new Set(
      (await Message.find({ mediaFilename: { $ne: null } }).select('mediaFilename').lean())
        .map(m => m.mediaFilename)
    );

    for (const file of files) {
      if (!dbFilenames.has(file)) {
        const filePath = path.join(uploadsDir, file);
        const stat = fs.statSync(filePath);
        // Only delete if file is older than 48h (safety check)
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours > 48) {
          fs.unlinkSync(filePath);
          console.log(`[Cleanup] Deleted orphaned file: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error during orphan cleanup:', err);
  }
});

// ─── MongoDB Connection & Server Start ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/chatapp';

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('[DB] Connected to MongoDB');
    server.listen(PORT, () => {
      console.log(`[Server] Running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Connection failed:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});
