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
  adminAssign
} = require('../controllers/disputeController');

// Brand/Influencer endpoints (require auth)
router.post('/create', verifyToken, createDispute);
router.post('/my', verifyToken, listMine);
router.get('/:id', verifyToken, getById);
router.post('/:id/comment', verifyToken, addComment);

// Admin endpoints (no auth required per project request)
router.post('/admin/list', adminList);
router.post('/admin/update-status', adminUpdateStatus);
router.post('/admin/assign', adminAssign);

module.exports = router;
