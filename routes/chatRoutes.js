// routes/chat.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/chatController');

router.post('/room', ctrl.createRoom);
router.post('/rooms', ctrl.getRooms);
router.post('/history', ctrl.getMessages);
router.post('/message', ctrl.postMessage);
router.post('/edit', ctrl.editMessage);
router.delete('/message', ctrl.deleteMessage);
router.post('/send-file', ctrl.postFileMessage);

router.post('/download', ctrl.downloadAttachmentPost);

// Seen/Unseen feature routes
router.post('/mark-seen', ctrl.markAsSeen);
router.post('/unseen-count', ctrl.getUnseenCount);

module.exports = router;
