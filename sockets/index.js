// sockets/index.js
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const ChatRoom = require(path.join(__dirname, '..', 'models', 'chat'));

let io;

/** ---- helpers shared by handlers ---- */
function makeReplySnapshot(room, replyTo) {
  if (!replyTo) return null;
  const target = room.messages.find((m) => m.messageId === replyTo);
  if (!target) return null;
  const firstAtt = target.attachments?.[0];
  return {
    messageId: target.messageId,
    senderId: target.senderId,
    text: (target.text || '').slice(0, 200),
    hasAttachment: !!firstAtt,
    attachment: firstAtt
      ? {
          originalName: firstAtt.originalName,
          mimeType: firstAtt.mimeType,
        }
      : undefined,
  };
}

function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((a) => ({
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
    storage: a.storage || 'remote',
  }));
}

/**
 * Attach Socket.IO to HTTP server once in app entry (server.js/app.js)
 *   const io = require('./sockets').init(server);
 */
function init(server) {
  io = new Server(server, {
    // keep path default unless you need to mirror old `/ws`
    // path: '/ws',
    cors: {
      origin: process.env.FRONTEND_ORIGIN || '*',
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    // --- identity/notification rooms (brand/influencer) ---
    // client calls: socket.emit('join', { brandId?, influencerId? })
    socket.on('join', ({ brandId, influencerId } = {}) => {
      try {
        if (brandId) socket.join(`brand:${brandId}`);
        if (influencerId) socket.join(`influencer:${influencerId}`);
      } catch (_) {}
    });

    // --- chat: join a chat room by roomId ---
    // client calls: socket.emit('joinChat', { roomId })
    socket.on('joinChat', ({ roomId } = {}) => {
      if (!roomId) return;
      socket.join(`chat:${roomId}`);
      socket.emit('joined', { roomId });
    });

    // --- chat: send message ---
    // client calls: socket.emit('sendChatMessage', { roomId, senderId, text, replyTo, attachments })
    socket.on(
      'sendChatMessage',
      async ({ roomId, senderId, text = '', replyTo, attachments = [] } = {}) => {
        try {
          if (!roomId || !senderId || (!text && (!attachments || attachments.length === 0))) return;

          const room = await ChatRoom.findOne({ roomId });
          if (!room) return;

          const isMember = room.participants.some((p) => String(p.userId) === String(senderId));
          if (!isMember) return;

          const reply = makeReplySnapshot(room, replyTo);
          const normalized = normalizeAttachments(attachments);

          const msg = {
            messageId: uuidv4(),
            senderId,
            text,
            timestamp: new Date(),
            replyTo: replyTo || null,
            reply: reply || null,
            attachments: normalized,
          };

          room.messages.push(msg);
          await room.save();

          io.to(`chat:${roomId}`).emit('chatMessage', {
            roomId,
            message: msg,
          });
        } catch (e) {
          // swallow to avoid crashing socket
        }
      }
    );

    // --- chat: typing indicator ---
    // client calls: socket.emit('typing', { roomId, senderId, isTyping: true/false })
    socket.on('typing', ({ roomId, senderId, isTyping } = {}) => {
      if (!roomId || !senderId) return;
      io.to(`chat:${roomId}`).emit('typing', {
        roomId,
        senderId,
        isTyping: !!isTyping,
      });
    });

    socket.on('disconnect', () => {});
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized yet.');
  return io;
}

/** ---- public emitters for controllers/jobs ---- */
function emitToBrand(brandId, event, payload) {
  if (!brandId) return;
  getIO().to(`brand:${brandId}`).emit(event, payload);
}
function emitToInfluencer(influencerId, event, payload) {
  if (!influencerId) return;
  getIO().to(`influencer:${influencerId}`).emit(event, payload);
}
function broadcastToChatRoom(roomId, event, payload) {
  if (!roomId) return;
  getIO().to(`chat:${roomId}`).emit(event, payload);
}

/**
 * Back-compat helper for any legacy code that used:
 *   app.get('broadcastToRoom')(roomId, jsonStringOrObject)
 */
function legacyBroadcastToRoom(roomId, payloadMaybeString) {
  try {
    const payload =
      typeof payloadMaybeString === 'string'
        ? JSON.parse(payloadMaybeString)
        : payloadMaybeString;

    // if legacy payload has { type, ... }, emit on that event for parity
    if (payload && payload.type) {
      broadcastToChatRoom(roomId, payload.type, payload);
    } else {
      broadcastToChatRoom(roomId, 'message', payload);
    }
  } catch {
    // ignore parse errors
  }
}

module.exports = {
  init,
  getIO,
  emitToBrand,
  emitToInfluencer,
  broadcastToChatRoom,
  legacyBroadcastToRoom,
};
