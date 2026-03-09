// routes/policyRoutes.js

const express = require('express');
const router = express.Router();
const policyController = require('../controllers/policyController');

// All endpoints use POST
router.post('/create', policyController.createPolicy);
router.post('/update', policyController.updatePolicy);
router.post('/delete', policyController.deletePolicy);
router.post('/getlist', policyController.getPolicy);
router.get('/all', policyController.getAllPolicies);

module.exports = router;
