const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: String,
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: String,
    default: null,
    maxlength: [5000, 'Message cannot exceed 5000 characters']
  },
  mediaUrl: {
    type: String,
    default: null
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', null],
    default: null
  },
  mediaFilename: {
    type: String,
    default: null
  },
  read: {
    type: Boolean,
    default: false
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from now
    index: { expireAfterSeconds: 0 } // MongoDB TTL index
  }
}, {
  timestamps: true
});

// Compound index for fast conversation lookup
messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ sender: 1, recipient: 1 });

// Static method to generate a consistent conversation ID
messageSchema.statics.getConversationId = function(userId1, userId2) {
  const ids = [userId1.toString(), userId2.toString()].sort();
  return `${ids[0]}_${ids[1]}`;
};

module.exports = mongoose.model('Message', messageSchema);
