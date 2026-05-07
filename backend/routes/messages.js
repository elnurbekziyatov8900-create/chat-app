const express = require('express');
const path = require('path');
const Message = require('../models/Message');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { upload, getMediaType } = require('../middleware/upload');

const router = express.Router();

// GET /api/messages/:userId - Get conversation with a user
router.get('/:userId', protect, async (req, res) => {
  try {
    const otherUser = await User.findById(req.params.userId);
    if (!otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const conversationId = Message.getConversationId(req.user._id, req.params.userId);

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const messages = await Message.find({ conversationId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('sender', 'username')
      .populate('recipient', 'username')
      .lean();

    // Mark messages as read
    await Message.updateMany(
      { conversationId, recipient: req.user._id, read: false },
      { $set: { read: true } }
    );

    res.json({
      messages: messages.reverse(),
      page,
      hasMore: messages.length === limit
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ message: 'Failed to load messages.' });
  }
});

// POST /api/messages/media/:userId - Upload media
router.post('/media/:userId', protect, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded.' });
    }

    const otherUser = await User.findById(req.params.userId);
    if (!otherUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const conversationId = Message.getConversationId(req.user._id, req.params.userId);
    const mediaType = getMediaType(req.file.mimetype);
    const mediaUrl = `/uploads/${req.file.filename}`;

    const message = await Message.create({
      conversationId,
      sender: req.user._id,
      recipient: req.params.userId,
      content: null,
      mediaUrl,
      mediaType,
      mediaFilename: req.file.filename
    });

    await message.populate('sender', 'username');
    await message.populate('recipient', 'username');

    res.status(201).json({ message });
  } catch (err) {
    console.error('Media upload error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'File too large. Maximum size is 50MB.' });
    }
    if (err.message && err.message.includes('Invalid file type')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Failed to upload media.' });
  }
});

module.exports = router;
