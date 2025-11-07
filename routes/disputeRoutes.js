const express = require('express');
const router = express.Router();

const { verifyToken } = require('../controllers/dashboardController');
const {
  createDispute,
  listMine,
  getById,
  addComment,
  adminList,
  adminUpdateStatus,
  adminAssign,
  adminGetById,
  adminAddComment
} = require('../controllers/disputeController');

// Brand/Influencer endpoints (require auth)
router.post('/create', verifyToken, createDispute);
router.post('/my', verifyToken, listMine);
router.get('/:id', verifyToken, getById);
router.post('/:id/comment', verifyToken, addComment);

// Admin endpoints (no auth required per project request)
router.post('/admin/list', adminList);
router.get('/admin/:id', adminGetById);
router.post('/admin/update-status', adminUpdateStatus);
router.post('/admin/assign', adminAssign);
router.post('/admin/:id/comment', adminAddComment);

module.exports = router;
