// controllers/chatController.js
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const sizeOf = require('image-size');
const multer = require('multer');

const ChatRoom       = require('../models/chat');
const Brand          = require('../models/brand');
const Influencer     = require('../models/influencer');

/* -----------------------------------------------------------
   Helpers
----------------------------------------------------------- */
function sortParticipants(a, b) {
  return a.userId.localeCompare(b.userId);
}

function broadcast(app, roomId, payloadObj) {
  const broadcastToRoom = app.get('broadcastToRoom'); // set in app.js
  if (typeof broadcastToRoom === 'function') {
    broadcastToRoom(roomId, JSON.stringify(payloadObj));
  }
}

function isUserInRoom(room, userId) {
  return room.participants.some(p => p.userId === userId);
}

function makeReplySnapshot(room, replyTo) {
  if (!replyTo) return null;
  const target = room.messages.find(m => m.messageId === replyTo);
  if (!target) return null;
  const firstAtt = target.attachments?.[0];
  return {
    messageId: target.messageId,
    senderId: target.senderId,
    text: (target.text || '').slice(0, 200),
    hasAttachment: !!firstAtt,
    attachment: firstAtt ? {
      originalName: firstAtt.originalName,
      mimeType: firstAtt.mimeType
    } : undefined
  };
}

/* -----------------------------------------------------------
   Multer setup for /chat/send-file
----------------------------------------------------------- */
const uploadsRoot = path.join(__dirname, '..', 'uploads', 'chat');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { roomId } = req.body;
    const dir = path.join(uploadsRoot, roomId || 'misc');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || `.${mime.extension(file.mimetype) || 'bin'}`;
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 100 // 100 MB per file (adjust as you like)
  }
});

/* -----------------------------------------------------------
   1) Create (or return) a one-to-one room
   POST /chat/create-room
   body: { brandId, influencerId }
----------------------------------------------------------- */
exports.createRoom = async (req, res) => {
  try {
    const { brandId, influencerId } = req.body;
    if (!brandId || !influencerId) {
      return res.status(400).json({ message: 'brandId and influencerId are required' });
    }

    const [brand, infl] = await Promise.all([
      Brand.findOne({ brandId }, 'name'),
      Influencer.findOne({ influencerId }, 'name')
    ]);
    if (!brand || !infl) {
      return res.status(404).json({ message: 'Brand or Influencer not found' });
    }

    const participants = [
      { userId: brandId, name: brand.name, role: 'brand' },
      { userId: influencerId, name: infl.name, role: 'influencer' }
    ].sort(sortParticipants);

    // Check if the chat room already exists
    let room = await ChatRoom.findOne({
      'participants.userId': { $all: [brandId, influencerId] },
      'participants.2': { $exists: false } // ensure it's a 1-1 room
    });

    let message;
    if (!room) {
      // Create a new room
      room = new ChatRoom({ participants });

      await room.save();
      message = 'Chat room created';
    } else {
      message = 'Chat room already exists';
    }

    return res.json({ message, roomId: room.roomId });
  } catch (err) {
    console.error('createRoom error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


/* -----------------------------------------------------------
   2) List all rooms for a user
   POST /chat/rooms
   body: { userId }
----------------------------------------------------------- */
exports.getRooms = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const rooms = await ChatRoom.find({ 'participants.userId': userId })
      .select('roomId participants messages.messageId messages.text messages.senderId messages.timestamp messages.attachments messages.seenBy')
      .lean();

    const summary = rooms.map(room => {
      const last = room.messages[room.messages.length - 1] || null;
      
      // Calculate unseen message count for this user
      const unseenCount = room.messages.filter(
        msg => msg.senderId !== userId && !msg.seenBy.includes(userId)
      ).length;
      
      return {
        roomId: room.roomId,
        participants: room.participants,
        lastMessage: last,
        unseenCount
      };
    });

    return res.json({ message: 'Rooms retrieved', rooms: summary });
  } catch (err) {
    console.error('getRooms error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   3) Fetch last N messages for a room (with optional pagination)
   POST /chat/messages
   body: { roomId, limit = 50, before? }
----------------------------------------------------------- */
exports.getMessages = async (req, res) => {
  try {
    const { roomId, limit = 50, before } = req.body;
    if (!roomId) return res.status(400).json({ message: 'roomId is required' });

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    let msgs = room.messages;
    if (before) {
      const cut = new Date(before);
      msgs = msgs.filter(m => m.timestamp < cut);
    }
    msgs = msgs.slice(-Math.max(1, parseInt(limit, 10)));

    return res.json({ message: 'Messages fetched', messages: msgs });
  } catch (err) {
    console.error('getMessages error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   4) Send a new message (JSON) — supports replyTo + attachments (URLs)
   POST /chat/send
   body: { roomId, senderId, text?, replyTo?, attachments? }
   - attachments?: [{ url, originalName, mimeType, size, width?, height?, duration?, thumbnailUrl?, storage? }]
----------------------------------------------------------- */
exports.postMessage = async (req, res) => {
  try {
    const { roomId, senderId, text = '', replyTo, attachments = [] } = req.body;
    if (!roomId || !senderId || (!text && (!attachments || attachments.length === 0))) {
      return res.status(400).json({ message: 'roomId, senderId and (text or attachments) are required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });
    if (!isUserInRoom(room, senderId)) return res.status(403).json({ message: 'Sender is not a participant of this room' });

    const reply = makeReplySnapshot(room, replyTo);

    const normalized = Array.isArray(attachments) ? attachments.map(a => ({
      attachmentId: uuidv4(),
      url: a.url,
      path: a.path || null,
      originalName: a.originalName || 'file',
      mimeType: a.mimeType || 'application/octet-stream',
      size: Number(a.size || 0),
      width: a.width || null,
      height: a.height || null,
      duration: a.duration || null,
      thumbnailUrl: a.thumbnailUrl || null,
      storage: a.storage || 'remote'
    })) : [];

    const msg = {
      messageId: uuidv4(),
      senderId,
      text,
      timestamp: new Date(),
      replyTo: replyTo || null,
      reply: reply || null,
      attachments: normalized
    };

    room.messages.push(msg);
    await room.save();

    // Broadcast over WebSocket (ws)
    broadcast(req.app, roomId, {
      type: 'chatMessage',
      roomId,
      message: msg
    });

    return res.status(201).json({ message: 'Message sent', messageData: msg });
  } catch (err) {
    console.error('postMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   4b) Send file(s) with multipart/form-data
   POST /chat/send-file
   form fields: roomId, senderId, text?, replyTo?
   files field: files (multiple)
----------------------------------------------------------- */
exports.postFileMessage = [
  upload.array('files', 10), // up to 10 files per message; adjust as needed
  async (req, res) => {
    try {
      const { roomId, senderId, text = '', replyTo } = req.body;
      if (!roomId || !senderId) {
        return res.status(400).json({ message: 'roomId and senderId are required' });
      }

      const room = await ChatRoom.findOne({ roomId });
      if (!room) return res.status(404).json({ message: 'Chat room not found' });
      if (!isUserInRoom(room, senderId)) return res.status(403).json({ message: 'Sender is not a participant of this room' });

      const files = req.files || [];
      if (files.length === 0 && !text) {
        return res.status(400).json({ message: 'Provide at least one file or text' });
      }

      // Build public URLs for served static files
      const host = req.get('host');
      const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
      const baseUrl = `${protocol}://${host}`;

      const attachments = files.map(f => {
        let width = null, height = null;
        try {
          if (f.mimetype && f.mimetype.startsWith('image/')) {
            const dim = sizeOf(f.path);
            width = dim?.width || null;
            height = dim?.height || null;
          }
        } catch { /* ignore dimension errors */ }

        const rel = path.relative(path.join(__dirname, '..'), f.path).split(path.sep).join('/'); // relative to project root
        const url = `${baseUrl}/${rel.replace(/^public\//, '')}`; // if you mount static on '/'

        return {
          attachmentId: uuidv4(),
          url,
          path: f.path,
          originalName: f.originalname,
          mimeType: f.mimetype || 'application/octet-stream',
          size: f.size || 0,
          width,
          height,
          storage: 'local'
        };
      });

      const reply = makeReplySnapshot(room, replyTo);

      const msg = {
        messageId: uuidv4(),
        senderId,
        text,
        timestamp: new Date(),
        replyTo: replyTo || null,
        reply: reply || null,
        attachments
      };

      room.messages.push(msg);
      await room.save();

      broadcast(req.app, roomId, {
        type: 'chatMessage',
        roomId,
        message: msg
      });

      return res.status(201).json({ message: 'File message sent', messageData: msg });
    } catch (err) {
      console.error('postFileMessage error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }
];

/* -----------------------------------------------------------
   5) Edit a message (text-only edit keeps attachments intact)
   PATCH /chat/edit
   body: { roomId, messageId, senderId, newText }
----------------------------------------------------------- */
exports.editMessage = async (req, res) => {
  try {
    const { roomId, messageId, senderId, newText } = req.body;
    if (!roomId || !messageId || !senderId || typeof newText !== 'string') {
      return res.status(400).json({ message: 'roomId, messageId, senderId, newText required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    const msg = room.messages.find(m => m.messageId === messageId);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    if (msg.senderId !== senderId) {
      return res.status(403).json({ message: 'You can edit only your own messages' });
    }

    msg.text = newText;
    msg.editedAt = new Date();
    await room.save();

    broadcast(req.app, roomId, {
      type: 'chatMessageEdited',
      roomId,
      message: msg
    });

    return res.json({ message: 'Message edited', message: msg });
  } catch (err) {
    console.error('editMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


/* -----------------------------------------------------------
   6) Delete a message (hard delete + remove local files)
   DELETE /chat/message
   body: { roomId, messageId, senderId }
----------------------------------------------------------- */
exports.deleteMessage = async (req, res) => {
  try {
    const { roomId, messageId, senderId } = req.body;
    if (!roomId || !messageId || !senderId) {
      return res.status(400).json({ message: 'roomId, messageId, senderId required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    const idx = room.messages.findIndex(m => m.messageId === messageId);
    if (idx === -1) return res.status(404).json({ message: 'Message not found' });

    const msg = room.messages[idx];
    if (msg.senderId !== senderId) {
      return res.status(403).json({ message: 'You can delete only your own messages' });
    }

    // Try to unlink local attachments
    for (const att of (msg.attachments || [])) {
      if (att.storage === 'local' && att.path) {
        fs.promises.unlink(att.path).catch(() => { }); // ignore errors
      }
    }

    room.messages.splice(idx, 1);
    await room.save();

    broadcast(req.app, roomId, {
      type: 'chatMessageDeleted',
      roomId,
      messageId
    });

    return res.json({ message: 'Message deleted', messageId });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


/* -----------------------------------------------------------
   7) Mark message(s) as seen
   POST /chat/mark-seen
   body: { roomId, userId, messageIds? }
   - If messageIds is provided: mark those specific messages as seen
   - If messageIds is omitted/empty: mark ALL messages in the room as seen
----------------------------------------------------------- */
exports.markAsSeen = async (req, res) => {
  try {
    const { roomId, userId, messageIds } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ message: 'roomId and userId are required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    // Verify user is a participant
    if (!isUserInRoom(room, userId)) {
      return res.status(403).json({ message: 'You are not a participant of this room' });
    }

    let query = { roomId };
    let update = {};

    if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
      // Mark specific messages as seen
      query['messages.messageId'] = { $in: messageIds };
      update = {
        $addToSet: {
          'messages.$[elem].seenBy': userId
        }
      };
    } else {
      // Mark all unseen messages as seen for this user
      update = {
        $addToSet: {
          'messages.$[elem].seenBy': userId
        }
      };
    }

    const arrayFilters = [{
      "elem.senderId": { $ne: userId },
      "elem.seenBy": { $ne: userId }
    }];

    const updatedRoom = await ChatRoom.findOneAndUpdate(
      query,
      update,
      { new: true, arrayFilters, select: 'roomId messages.messageId messages.seenBy' }
    ).lean();

    if (!updatedRoom) {
      return res.status(404).json({ message: 'Chat room not found or no messages updated' });
    }

    const updatedMessages = updatedRoom.messages
      .filter(msg => messageIds ? messageIds.includes(msg.messageId) : !msg.seenBy.includes(userId))
      .map(msg => ({
        messageId: msg.messageId,
        seenBy: msg.seenBy
      }));

    if (updatedMessages.length > 0) {
      // Broadcast seen status update
      broadcast(req.app, roomId, {
        type: 'messagesSeen',
        roomId,
        userId,
        messages: updatedMessages
      });
    }

    return res.json({
      message: 'Messages marked as seen',
      markedCount: updatedMessages.length,
      updatedMessages
    });

    return res.json({
      message: 'Messages marked as seen',
      markedCount,
      updatedMessages
    });
  } catch (err) {
    console.error('markAsSeen error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   8) Get unseen message count for a user in a room
   POST /chat/unseen-count
   body: { roomId, userId }
----------------------------------------------------------- */
exports.getUnseenCount = async (req, res) => {
  try {
    const { roomId, userId } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ message: 'roomId and userId are required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    if (!isUserInRoom(room, userId)) {
      return res.status(403).json({ message: 'You are not a participant of this room' });
    }

    // Count messages not sent by this user and not seen by this user
    const unseenCount = room.messages.filter(
      msg => msg.senderId !== userId && !msg.seenBy.includes(userId)
    ).length;

    return res.json({
      message: 'Unseen count retrieved',
      roomId,
      userId,
      unseenCount
    });
  } catch (err) {
    console.error('getUnseenCount error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// controllers/chatController.js

exports.downloadAttachmentPost = async (req, res) => {
  try {
    const { roomId, attachmentId, userId } = req.body;

    if (!roomId || !attachmentId) {
      return res.status(400).json({ message: 'roomId and attachmentId are required' });
    }
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const room = await ChatRoom.findOne({ roomId });
    if (!room) return res.status(404).json({ message: 'Chat room not found' });

    // Only participants can download
    if (!isUserInRoom(room, userId)) {
      return res.status(403).json({ message: 'You are not a participant of this room' });
    }

    // Find the attachment inside any message
    let targetAttachment = null;
    for (const m of room.messages) {
      const found = (m.attachments || []).find(a => a.attachmentId === attachmentId);
      if (found) { targetAttachment = found; break; }
    }
    if (!targetAttachment) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    const filename = targetAttachment.originalName || 'file';
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Local storage: stream file back with download headers
    if (targetAttachment.storage === 'local' && targetAttachment.path) {
      if (!fs.existsSync(targetAttachment.path)) {
        return res.status(404).json({ message: 'File not found on disk' });
      }

      // Optional: expose filename for fetch->blob flows on FE
      res.setHeader('X-Filename', encodeURIComponent(filename));

      // Let Express handle headers + stream
      return res.download(targetAttachment.path, filename);
    }

    // Remote storage: pass through to the public URL (or upgrade later to signed URL)
    if (targetAttachment.url) {
      // Note: 302 after POST will switch to GET on most clients/browsers.
      return res.redirect(302, targetAttachment.url);
    }

    return res.status(500).json({ message: 'Attachment is not downloadable' });
  } catch (err) {
    console.error('downloadAttachment (POST) error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
