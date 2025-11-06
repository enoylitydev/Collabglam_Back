// app.js
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const mongoose  = require('mongoose');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');


const influencerRoutes    = require('./routes/influencerRoutes');
const countryRoutes       = require('./routes/countryRoutes');
const brandRoutes         = require('./routes/brandRoutes');
const campaignRoutes      = require('./routes/campaignRoutes');
const categoryRoutes      = require('./routes/categoryRoutes');
const audienceRoutes      = require('./routes/audienceRoutes');
const applyCampaingRoutes = require('./routes/applyCampaingRoutes');
const contractRoutes      = require('./routes/contractRoutes');
const milestoneRoutes     = require('./routes/milestoneRoutes');
const subscriptionRoutes  = require('./routes/subscriptionRoutes');
const paymentRoutes       = require('./routes/paymentRoutes');
const chatRoutes          = require('./routes/chatRoutes');
const adminRoutes         = require('./routes/adminRoutes');
const policyRoutes        = require('./routes/policyRoutes');
const contactRoutes       = require('./routes/contactRoutes');
const faqsRoutes          = require('./routes/faqsRoutes');
const dashboardRoutes     = require('./routes/dashboardRoutes');
const platformRoutes      = require('./routes/platformRoutes');
const audienceRangeRoutes = require('./routes/audiencerangeRoutes');
const invitationRoutes    = require('./routes/invitationRoutes');
const filtersRoutes       = require('./routes/filterRoutes');
const mediaKitRoutes      = require('./routes/mediaKitRoutes');
const modashRoutes        = require('./routes/modashRoutes');
const languageRoutes      = require('./routes/languageRoutes');
const businessRoutes      = require('./routes/businessRoutes');
const unsubscribeRoutes   = require('./routes/unsubscribeRoutes');
const disputeRoutes       = require('./routes/disputeRoutes');

// Models needed inside WS handlers
const ChatRoom = require('./models/chat');

// Start unseen message notifier job
const unseenMessageNotifier = require('./jobs/unseenMessageNotifier');

const app    = express();
const server = http.createServer(app);

// ====== Static uploads (so attachment URLs work) ======
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ====== WebSocket (ws) setup ======
const wss   = new WebSocket.Server({ server, path: '/ws' });
const rooms = new Map(); // roomId -> Set<ws>

function broadcastToRoom(roomId, payloadString) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payloadString);
  }
}

// Optional heartbeat to terminate dead connections
function noop() {}
function heartbeat() { this.isAlive = true; }

function makeReplySnapshot(room, replyTo) {
  if (!replyTo) return null;
  const target = room.messages.find(m => m.messageId === replyTo);
  if (!target) return null;
  const firstAtt = target.attachments?.[0];
  return {
    messageId:  target.messageId,
    senderId:   target.senderId,
    text:       (target.text || '').slice(0, 200),
    hasAttachment: !!firstAtt,
    attachment: firstAtt ? {
      originalName: firstAtt.originalName,
      mimeType: firstAtt.mimeType
    } : undefined
  };
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  let joinedRoom = null;

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Invalid WS JSON:', raw);
      return;
    }

    switch (data.type) {
      case 'joinChat': {
        const { roomId } = data;
        if (!roomId) return;

        joinedRoom = roomId;
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        rooms.get(roomId).add(ws);
        ws.send(JSON.stringify({ type: 'joined', roomId }));
        break;
      }

      case 'sendChatMessage': {
        const { roomId, senderId, text = '', replyTo, attachments = [] } = data;
        if (!roomId || !senderId || (!text && (!attachments || attachments.length === 0))) return;

        const room = await ChatRoom.findOne({ roomId });
        if (!room) {
          console.warn(`WS: room ${roomId} not found`);
          return;
        }
        const isMember = room.participants.some(p => p.userId === senderId);
        if (!isMember) {
          console.warn(`WS: sender ${senderId} not in room ${roomId}`);
          return;
        }

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

        const payload = JSON.stringify({
          type: 'chatMessage',
          roomId,
          message: msg
        });
        broadcastToRoom(roomId, payload);
        break;
      }

      case 'typing': {
        const { roomId, senderId, isTyping } = data;
        if (!roomId || !senderId) return;
        const payload = JSON.stringify({
          type: 'typing',
          roomId,
          senderId,
          isTyping: !!isTyping
        });
        broadcastToRoom(roomId, payload);
        break;
      }

      default:
        console.warn('WS: unknown type', data.type);
    }
  });

  ws.on('close', () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      rooms.get(joinedRoom).delete(ws);
      if (rooms.get(joinedRoom).size === 0) rooms.delete(joinedRoom);
    }
  });
});

// ping clients every 30s
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(noop);
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

/* Expose helpers to controllers */
app.set('wss', wss);
app.set('wsRooms', rooms);
app.set('broadcastToRoom', broadcastToRoom);

// ====== Express middleware ======
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  credentials: true
}));

// Increase JSON/urlencoded limits to avoid PayloadTooLargeError on /register
// You can tune via env: JSON_LIMIT=8mb (default 8mb)
const JSON_LIMIT = process.env.JSON_LIMIT || '8mb';
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT, parameterLimit: 100000 }));

// Friendly 413 response instead of crashing stack traces
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ message: 'Payload too large. Try reducing the request size or increase JSON_LIMIT.' });
  }
  return next(err);
});

// ====== REST routes ======
app.use('/influencer', influencerRoutes);
app.use('/country', countryRoutes);
app.use('/brand', brandRoutes);
app.use('/campaign', campaignRoutes);
app.use('/category', categoryRoutes);
app.use('/audience', audienceRoutes);
app.use('/apply', applyCampaingRoutes);
app.use('/contract', contractRoutes);
app.use('/milestone', milestoneRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/chat', chatRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);
app.use('/policy', policyRoutes);
app.use('/contact', contactRoutes);
app.use('/faqs', faqsRoutes);
app.use('/dash', dashboardRoutes);
app.use('/platform', platformRoutes);
app.use('/audienceRange', audienceRangeRoutes);
app.use('/invitation', invitationRoutes);
app.use('/filters', filtersRoutes);
app.use('/media-kit', mediaKitRoutes);
app.use('/modash', modashRoutes);
app.use('/languages', languageRoutes);
app.use('/business', businessRoutes);
app.use('/unsubscribe', unsubscribeRoutes);
app.use('/dispute', disputeRoutes);

/* Mongo & start */
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    
    // Start the unseen message notifier job
    unseenMessageNotifier.start();
    console.log('✅ Started unseen message notifier job');
    
    server.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });
