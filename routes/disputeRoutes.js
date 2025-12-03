// routes/disputeRoutes.js
const express = require('express');
const router = express.Router();

const { verifyToken } = require('../controllers/dashboardController');
const {
  // brand
  brandCreateDispute,
  brandList,
  brandGetById,
  brandAddComment,
  // influencer
  influencerCreateDispute,
  influencerList,
  influencerGetById,
  influencerAddComment,
  influencerCampaignsForDispute,
  // admin
  adminList,
  adminGetById,
  adminAddComment,
  adminUpdateStatus,
  adminAssign
} = require('../controllers/disputeController');

// -------- Brand endpoints (require brand auth) --------
router.post('/brand/create', verifyToken, brandCreateDispute);
router.post('/brand/list', verifyToken, brandList);
router.get('/brand/:id', verifyToken, brandGetById);
router.post('/brand/:id/comment', verifyToken, brandAddComment);

// -------- Influencer endpoints (require influencer auth) --------
router.post('/influencer/create', verifyToken, influencerCreateDispute);
router.post('/influencer/list', verifyToken, influencerList);
router.get('/influencer/:id', verifyToken, influencerGetById);
router.post('/influencer/:id/comment', verifyToken, influencerAddComment);
router.post('/influencer/applied', verifyToken, influencerCampaignsForDispute);

// -------- Admin endpoints (no auth required per project request) --------
router.post('/admin/list', adminList);
router.get('/admin/:id', adminGetById);
router.post('/admin/:id/comment', adminAddComment);
router.post('/admin/update-status', adminUpdateStatus);
router.post('/admin/assign', adminAssign);

module.exports = router;
