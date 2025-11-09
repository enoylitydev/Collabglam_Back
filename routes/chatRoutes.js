// routes.chatjs
const express = require('express');
const router = express.Router();
const chat = require('../controllers/chatController');

router.post('/create-room', chat.createRoom);
router.post('/rooms', chat.getRooms);
router.post('/messages', chat.getMessages);
router.post('/send', chat.postMessage);
router.post('/send-file', chat.postFileMessage);
router.patch('/edit', chat.editMessage);
router.delete('/message', chat.deleteMessage);
router.post('/mark-seen', chat.markAsSeen);
router.post('/unseen-count', chat.getUnseenCount);

// NEW secure streaming
router.get('/attachment/:roomId/:attachmentId', chat.streamAttachment);

// OPTIONAL public GridFS streamer used by frontend `fileUrl()`
router.get('/file/:filename', chat.streamGridFsFile);

// legacy
router.post('/download', chat.downloadAttachmentPost);

module.exports = router;
