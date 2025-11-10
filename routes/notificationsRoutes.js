// routes/notificationsRoutes.js
const express = require('express');
const ctrl = require('../controllers/notificationController');

const router = express.Router();

// Influencer notifications
router.get('/influencer', ctrl.listForInfluencer);
router.post('/influencer/mark-read', ctrl.markReadForInfluencer);
router.post('/influencer/mark-all-read', ctrl.markAllReadForInfluencer);

// Brand notifications
router.get('/brand', ctrl.listForBrand);
router.post('/brand/mark-read', ctrl.markReadForBrand);
router.post('/brand/mark-all-read', ctrl.markAllReadForBrand);
router.post('/brand/delete', ctrl.deleteForBrand);

router.post('/influencer/delete', ctrl.deleteForInfluencer);

module.exports = router;
