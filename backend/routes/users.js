const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

// GET /api/users/search?q=username
router.get('/search', protect, async (req, res) => {
  try {
    const query = (req.query.q || '').trim().replace(/[^a-zA-Z0-9_]/g, '');

    if (!query || query.length < 1) {
      return res.json({ users: [] });
    }

    if (query.length > 30) {
      return res.status(400).json({ message: 'Search query too long.' });
    }

    const users = await User.find({
      username: { $regex: query, $options: 'i' },
      _id: { $ne: req.user._id }
    })
      .select('username email isOnline lastSeen')
      .limit(20)
      .lean();

    res.json({ users });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ message: 'Search failed.' });
  }
});

// GET /api/users/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('username email isOnline lastSeen')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ message: 'Failed to get user.' });
  }
});

module.exports = router;
