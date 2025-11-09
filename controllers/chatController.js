// controllers/chatController.js
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const multer = require('multer');
const mongoose = require('mongoose');
const { uploadToGridFS, deleteGridFsFiles } = require('../utils/gridfs');

const ChatRoom       = require('../models/chat');
const Brand          = require('../models/brand');
const Influencer     = require('../models/influencer');

const { createAndEmit } = require('../utils/notifier'); // 🔔 centralized notifier

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

// find the counterparty and sender names/roles for notification routing
function resolveChatRoles(room, senderId) {
  const sender = room.participants.find(p => p.userId === senderId) || {};
  const other  = room.participants.find(p => p.userId !== senderId) || {};
  return {
    senderId,
    senderName: sender.name || 'Someone',
    otherId: other.userId,
    otherRole: other.role, // 'brand' | 'influencer'
    otherName: other.name || 'Participant'
  };
}

function chatPathForRole(role, roomId) {
  const safeRole = role === 'brand' ? 'brand' : 'influencer';
  return `/${safeRole}/messages/${encodeURIComponent(roomId)}`;
}

/* -----------------------------------------------------------
   Multer + GridFS for /chat/send-file
----------------------------------------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 100 } // 100 MB per file
});

async function saveFilesToGridFS(files = [], req) {
  if (!Array.isArray(files) || files.length === 0) return [];
  return uploadToGridFS(files, {
    prefix: 'chat',
    metadata: { kind: 'chat_attachment' },
    req
  });
}


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
    ].sort((a, b) => a.userId.localeCompare(b.userId));

    let room = await ChatRoom.findOne({
      'participants.userId': { $all: [brandId, influencerId] },
      'participants.2': { $exists: false } // ensure it's a 1-1 room
    });

    let message;
    if (!room) {
      room = new ChatRoom({ participants });
      await room.save();
      message = 'Chat room created';
      // NOTE: No notification on room creation (per request).
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

      const unseenCount = room.messages.filter(
        msg => msg.senderId !== userId && !(msg.seenBy || []).includes(userId)
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
   4) Send a new message (JSON)
   POST /chat/send
   body: { roomId, senderId, text?, replyTo?, attachments? }
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

    broadcast(req.app, roomId, {
      type: 'chatMessage',
      roomId,
      message: msg
    });

    // 🔔 Notify the counterparty
    const { senderName, otherId, otherRole } = resolveChatRoles(room, senderId);
    const preview = (text || '').trim() ? (text || '').slice(0, 120) : (normalized.length ? `${normalized.length} attachment(s)` : 'New message');
    createAndEmit({
      brandId: otherRole === 'brand' ? String(otherId) : null,
      influencerId: otherRole === 'influencer' ? String(otherId) : null,
      type: 'chat.message',
      title: `New message from ${senderName}`,
      message: preview,
      entityType: 'chat',
      entityId: room.roomId,
      actionPath: chatPathForRole(otherRole, room.roomId),
    }).catch(e => console.error('notify chat.message failed:', e));

    return res.status(201).json({ message: 'Message sent', messageData: msg });
  } catch (err) {
    console.error('postMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   4b) Send file(s)
   POST /chat/send-file
----------------------------------------------------------- */
exports.postFileMessage = [
  upload.array('files', 10),
  async (req, res) => {
    try {
      const { roomId, senderId, text = '', replyTo } = req.body;
      if (!roomId || !senderId) {
        return res.status(400).json({ message: 'roomId and senderId are required' });
      }

      const room = await ChatRoom.findOne({ roomId });
      if (!room) return res.status(404).json({ message: 'Chat room not found' });
      if (!isUserInRoom(room, senderId)) return res.status(403).json({ message: 'Sender is not a participant of this room' });

      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0 && !text) {
        return res.status(400).json({ message: 'Provide at least one file or text' });
      }

      const saved = await saveFilesToGridFS(files, req);

      const attachments = saved.map(s => ({
        attachmentId: uuidv4(),
        url: s.url,
        originalName: s.originalName || 'file',
        mimeType: s.mimeType || 'application/octet-stream',
        size: s.size || 0,
        width: null,
        height: null,
        storage: 'gridfs',
        gridfsFilename: s.filename,
        gridfsId: s.id
      }));

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

      // 🔔 Notify counterparty
      const { senderName, otherId, otherRole } = resolveChatRoles(room, senderId);
      const preview = attachments.length ? `${attachments.length} attachment(s)` : (text || '').slice(0, 120) || 'New message';
      createAndEmit({
        brandId: otherRole === 'brand' ? String(otherId) : null,
        influencerId: otherRole === 'influencer' ? String(otherId) : null,
        type: 'chat.message',
        title: `New message from ${senderName}`,
        message: preview,
        entityType: 'chat',
        entityId: room.roomId,
        actionPath: chatPathForRole(otherRole, room.roomId),
      }).catch(e => console.error('notify chat.message (file) failed:', e));

      return res.status(201).json({ message: 'File message sent', messageData: msg });
    } catch (err) {
      console.error('postFileMessage error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }
];

/* -----------------------------------------------------------
   5) Edit a message
   PATCH /chat/edit
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

    // 🔔 Notify counterparty
    const { senderName, otherId, otherRole } = resolveChatRoles(room, senderId);
    createAndEmit({
      brandId: otherRole === 'brand' ? String(otherId) : null,
      influencerId: otherRole === 'influencer' ? String(otherId) : null,
      type: 'chat.message.edited',
      title: `Message edited by ${senderName}`,
      message: (newText || '').slice(0, 120),
      entityType: 'chat',
      entityId: room.roomId,
      actionPath: chatPathForRole(otherRole, room.roomId),
    }).catch(e => console.error('notify chat.message.edited failed:', e));

    return res.json({ message: 'Message edited', message: msg });
  } catch (err) {
    console.error('editMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


/* -----------------------------------------------------------
   6) Delete a message
   DELETE /chat/message
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

    // Cleanup attachments
    try {
      for (const att of (msg.attachments || [])) {
        if (att.storage === 'local' && att.path) {
          fs.promises.unlink(att.path).catch(() => { });
        }
      }
      const gridIds = (msg.attachments || [])
        .filter(a => a.storage === 'gridfs' && a.gridfsId)
        .map(a => a.gridfsId);
      if (gridIds.length) await deleteGridFsFiles(gridIds);
    } catch { /* ignore */ }

    room.messages.splice(idx, 1);
    await room.save();

    broadcast(req.app, roomId, {
      type: 'chatMessageDeleted',
      roomId,
      messageId
    });

    // 🔔 Notify counterparty
    const { senderName, otherId, otherRole } = resolveChatRoles(room, senderId);
    createAndEmit({
      brandId: otherRole === 'brand' ? String(otherId) : null,
      influencerId: otherRole === 'influencer' ? String(otherId) : null,
      type: 'chat.message.deleted',
      title: `Message deleted by ${senderName}`,
      message: '',
      entityType: 'chat',
      entityId: room.roomId,
      actionPath: chatPathForRole(otherRole, room.roomId),
    }).catch(e => console.error('notify chat.message.deleted failed:', e));

    return res.json({ message: 'Message deleted', messageId });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


/* -----------------------------------------------------------
   7) Mark message(s) as seen
   POST /chat/mark-seen
----------------------------------------------------------- */
/* -----------------------------------------------------------
   7) Mark message(s) as seen
   POST /chat/mark-seen
----------------------------------------------------------- */
exports.markAsSeen = async (req, res) => {
  try {
    const { roomId, userId, messageIds } = req.body;
    if (!roomId || !userId) {
      return res.status(400).json({ message: 'roomId and userId are required' });
    }

    // 1) Load BEFORE state to compute dedupe (which msgs were already seen)
    const before = await ChatRoom.findOne(
      { roomId },
      'roomId participants messages.messageId messages.senderId messages.seenBy'
    ).lean();

    if (!before) return res.status(404).json({ message: 'Chat room not found' });

    // Verify user is a participant
    const isParticipant = (before.participants || []).some(p => p.userId === userId);
    if (!isParticipant) {
      return res.status(403).json({ message: 'You are not a participant of this room' });
    }

    // Build set of messageIds already seen by this user (excluding their own messages)
    const alreadySeen = new Set(
      (before.messages || [])
        .filter(m => m.senderId !== userId && Array.isArray(m.seenBy) && m.seenBy.includes(userId))
        .map(m => m.messageId)
    );

    // 2) Apply update — addToSet for seenBy only where:
    //    - not sender's own message
    //    - userId not already in seenBy
    //    - (optional) message is in messageIds when provided
    const elemFilter = {
      'elem.senderId': { $ne: userId },
      'elem.seenBy': { $ne: userId },
    };
    if (Array.isArray(messageIds) && messageIds.length > 0) {
      elemFilter['elem.messageId'] = { $in: messageIds };
    }

    await ChatRoom.updateOne(
      { roomId },
      { $addToSet: { 'messages.$[elem].seenBy': userId } },
      { arrayFilters: [elemFilter] }
    );

    // 3) Load AFTER state
    const after = await ChatRoom.findOne(
      { roomId },
      'roomId participants messages.messageId messages.senderId messages.seenBy'
    ).lean();

    if (!after) {
      return res.status(404).json({ message: 'Chat room not found or no messages updated' });
    }

    // 4) Compute which messages became newly seen in THIS call
    const newlySeen = (after.messages || []).filter(m => {
      if (m.senderId === userId) return false; // never count own messages
      const nowSeen = Array.isArray(m.seenBy) && m.seenBy.includes(userId);
      const wasSeen = alreadySeen.has(m.messageId);
      const inFilter = Array.isArray(messageIds) && messageIds.length > 0
        ? messageIds.includes(m.messageId)
        : true;
      return nowSeen && !wasSeen && inFilter;
    });

    // If nothing new was marked seen, do not broadcast/notify (prevents duplicates)
    if (newlySeen.length === 0) {
      return res.json({
        message: 'Messages marked as seen',
        markedCount: 0,
        updatedMessages: [],
      });
    }

    // Prepare payload for broadcast (with full seenBy arrays from AFTER)
    const updatedMessages = newlySeen.map(m => ({
      messageId: m.messageId,
      seenBy: m.seenBy || [],
    }));

    // 5) Broadcast only for newly seen messages
    broadcast(req.app, roomId, {
      type: 'messagesSeen',
      roomId,
      userId,
      messages: updatedMessages,
    });

    // 6) Gentle notify counterparty ONCE per new seen set
    //    (i.e., this will not fire again unless new messages get seen later)
    const self = (after.participants || []).find(p => p.userId === userId) || {};
    const other = (after.participants || []).find(p => p.userId !== userId) || {};
    if (other && other.userId) {
      // You can keep this for all cases or restrict to "no messageIds" like before.
      // Either way it'll only trigger when there are *newly* seen messages now.
      createAndEmit({
        brandId: other.role === 'brand' ? String(other.userId) : null,
        influencerId: other.role === 'influencer' ? String(other.userId) : null,
        type: 'chat.seen',
        title: `${self.name || 'Participant'} viewed your messages`,
        message: `${newlySeen.length} message${newlySeen.length > 1 ? 's' : ''} viewed.`,
        entityType: 'chat',
        entityId: after.roomId,
        actionPath: chatPathForRole(other.role, after.roomId),
      }).catch(e => console.error('notify chat.seen failed:', e));
    }

    return res.json({
      message: 'Messages marked as seen',
      markedCount: updatedMessages.length,
      updatedMessages,
    });
  } catch (err) {
    console.error('markAsSeen error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* -----------------------------------------------------------
   8) Get unseen message count for a user in a room
   POST /chat/unseen-count
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

    const unseenCount = room.messages.filter(
      msg => msg.senderId !== userId && !(msg.seenBy || []).includes(userId)
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

// POST download (kept as-is; no notification needed)
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

    if (!isUserInRoom(room, userId)) {
      return res.status(403).json({ message: 'You are not a participant of this room' });
    }

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

    if (targetAttachment.storage === 'local' && targetAttachment.path) {
      if (!fs.existsSync(targetAttachment.path)) {
        return res.status(404).json({ message: 'File not found on disk' });
      }
      res.setHeader('X-Filename', encodeURIComponent(filename));
      return res.download(targetAttachment.path, filename);
    }

    if (targetAttachment.storage === 'gridfs' && targetAttachment.gridfsFilename) {
      return res.redirect(302, `/file/${encodeURIComponent(targetAttachment.gridfsFilename)}`);
    }

    if (targetAttachment.url) {
      return res.redirect(302, targetAttachment.url);
    }

    return res.status(500).json({ message: 'Attachment is not downloadable' });
  } catch (err) {
    console.error('downloadAttachment (POST) error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
