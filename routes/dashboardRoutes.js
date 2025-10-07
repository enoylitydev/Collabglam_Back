// routes/dashboard.js
const express = require('express');
const router  = express.Router();
const {
  verifyToken,
  getDashboard,
  getDashboardInf
} = require('../controllers/dashboardController');

router.post('/brand',       verifyToken, getDashboard);
router.post('/influencer',  verifyToken, getDashboardInf);

module.exports = router;
