// app.js
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const mongoose  = require('mongoose');
const http      = require('http');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');

// routes
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
const notificationsRoutes = require('./routes/notificationsRoutes');

// jobs
const unseenMessageNotifier = require('./jobs/unseenMessageNotifier');

// sockets (Socket.IO)
const sockets = require('./sockets');

const app    = express();
const server = http.createServer(app);

// ====== Static uploads (so attachment URLs work) ======
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ====== Socket.IO setup (replaces old ws) ======
const io = sockets.init(server);

// expose helpers to controllers/jobs if they want to emit without importing sockets
app.set('io', io);
app.set('emitToBrand', sockets.emitToBrand);
app.set('emitToInfluencer', sockets.emitToInfluencer);
app.set('broadcastToRoom', sockets.legacyBroadcastToRoom); // back-compat for any legacy broadcast usage

// ====== Express middleware ======
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  credentials: true
}));

// Increase JSON/urlencoded limits
const JSON_LIMIT = process.env.JSON_LIMIT || '8mb';
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT, parameterLimit: 100000 }));

// Friendly 413 response
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
app.use('/notifications', notificationsRoutes);

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

module.exports = app;
