// routes/interestRoutes.js

const express = require('express');
const router  = express.Router();

const interestController = require('../controllers/interestController');

// 1) List all interests
//    GET /interests
router.get('/getList', interestController.getAllInterests);

// 2) Create a new interest
//    POST /interests
router.post('/saveRecord', interestController.createInterest);

module.exports = router;
