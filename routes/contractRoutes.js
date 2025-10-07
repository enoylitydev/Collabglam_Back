// routes/contractRoutes.js
const express = require('express');
const router = express.Router();
const { sendOrGenerateContract, getContract, viewContractPdf, acceptContract, rejectContract, resendContract, getRejectedContractsByBrand, getRejectedContractsByInfluencer } = require('../controllers/contractController');

// GET /country → returns all countries
router.post('/sendContract', sendOrGenerateContract);
router.post('/getContract', getContract);
router.post('/view', viewContractPdf);
router.post('/accept', acceptContract);

router.post('/reject', rejectContract);
router.post('/resend', resendContract);
router.post('/rejectedByBrand', getRejectedContractsByBrand);
router.post('/rejectedByInfluencer', getRejectedContractsByInfluencer);

module.exports = router;