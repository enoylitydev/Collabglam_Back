// routes/index.js (or wherever you mount routes)
const express = require('express');
const router = express.Router();
const modashController = require('../controllers/modashController');

// proxy endpoint
router.post('/resolve-profile', modashController.resolveProfile);

module.exports = router;
