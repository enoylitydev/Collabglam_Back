// models/chat.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const attachmentSchema = new mongoose.Schema({
  attachmentId: { type: String, required: true, default: uuidv4 },
  url: { type: String, required: true }, // public URL your FE can load
  path: { type: String, default: null },  // local fs path (if stored locally)
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  // Optional metadata (filled when available)
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  duration: { type: Number, default: null }, // seconds for audio/video if you measure it
  thumbnailUrl: { type: String, default: null }, // if you generate thumbs later
  storage: { type: String, enum: ['local', 'remote', 'gridfs'], default: 'local' },
  gridfsFilename: { type: String, default: null },
  gridfsId: { type: String, default: null }
}, { _id: false });

const replySnapshotSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  senderId: { type: String, required: true },
  text: { type: String, default: '' },
  // tiny peek at first attachment (if any)
  hasAttachment: { type: Boolean, default: false },
  attachment: {
    originalName: { type: String, default: null },
    mimeType: { type: String, default: null }
  }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, default: uuidv4 },
  senderId: { type: String, required: true },
  text: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
  editedAt: { type: Date, default: null },
  replyTo: { type: String, default: null },
  reply: { type: replySnapshotSchema, default: null },
  attachments: { type: [attachmentSchema], default: [] },
  seenBy: { type: [String], default: [] }  // ADD THIS LINE
}, { _id: false });

const participantSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['brand', 'influencer', 'other'], default: 'other' }
}, { _id: false });

// Add to chat schema in models/chat.js
const chatRoomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, default: uuidv4 },
  participants: { type: [participantSchema], required: true },
  messages: { type: [messageSchema], default: [] },
  lastNotificationSent: { type: Map, of: Date, default: {} }  // ADD THIS
}, { timestamps: true });

module.exports = mongoose.model('ChatRoom', chatRoomSchema);
