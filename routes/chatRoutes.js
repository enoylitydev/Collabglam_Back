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
// run in cmd
// developer@Developers-Mac-mini project % curl -X POST http://localhost:5000/chat/test-email-notification \
//   -H "Content-Type: application/json" \
//   -d '{"userId": "devansh78@gmail.com"}'

// // Add at the end of your routes, before module.exports
// router.post('/test-email-notification', async (req, res) => {
//     try {
//         const { userId } = req.body;

//         if (!userId) {
//             return res.status(400).json({ message: 'userId required' });
//         }

//         const ChatRoom = require('../models/chat');
//         const Brand = require('../models/brand');
//         const Influencer = require('../models/influencer');

//         // Find rooms where user is a participant
//         const rooms = await ChatRoom.find({ 'participants.userId': userId });

//         let notificationsSent = 0;
//         const results = [];

//         for (const room of rooms) {
//             const unseenCount = room.messages.filter(
//                 msg => msg.senderId !== userId &&
//                     (!msg.seenBy || !msg.seenBy.includes(userId))
//             ).length;

//             if (unseenCount > 0) {
//                 const participant = room.participants.find(p => p.userId === userId);

//                 // Get user details
//                 let user;
//                 if (participant.role === 'brand') {
//                     user = await Brand.findOne({ brandId: userId }).select('email name');
//                 } else if (participant.role === 'influencer') {
//                     user = await Influencer.findOne({ influencerId: userId }).select('email name');
//                 }

//                 if (user && user.email) {
//                     // Use your existing notification function
//                     const unseenMessageNotifier = require('../jobs/unseenMessageNotifier');
//                     await unseenMessageNotifier.sendUnseenMessageNotification(
//                         user.email,
//                         user.name || 'User',
//                         unseenCount,
//                         room.roomId
//                     );

//                     notificationsSent++;
//                     results.push({
//                         roomId: room.roomId,
//                         email: user.email,
//                         unseenCount
//                     });
//                 }
//             }
//         }

//         return res.json({
//             message: 'Test completed',
//             notificationsSent,
//             results
//         });
//     } catch (err) {
//         console.error('Test email error:', err);
//         return res.status(500).json({ message: err.message });
//     }
// });


module.exports = router;
