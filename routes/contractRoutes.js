// routes/contractRoutes.js
const express = require('express');
const router = express.Router();

const {
  // NEW (color-owner flow)
  initiate,
  influencerConfirm,
  adminUpdate,
  preview,
  sign,

  // Legacy-compatible + shared
  sendOrGenerateContract,
  getContract,
  viewContractPdf,
  acceptContract,
  rejectContract,
  resendContract,
  getRejectedContractsByBrand,
  getRejectedContractsByInfluencer
} = require('../controllers/contractController');

/**
 * v2 — Color-owner flow
 * YELLOW (Brand) → GREY (System) → PURPLE (Influencer) → GREEN (Admin) → Sign & Lock
 */
router.post('/initiate', initiate);                   // Brand fills Yellow; System expands Grey
router.post('/influencerConfirm', influencerConfirm); // Influencer quick 3-field confirm (Purple)
router.post('/adminUpdate', adminUpdate);             // Admin-only Green edits + legal versioning
router.get('/preview', preview);                      // Live preview JSON or ?pdf=1
router.post('/sign', sign);                           // Signatures; locks on final signature

/**
 * Shared/Final
 */
router.post('/viewPdf', viewContractPdf);             // View final/locked PDF (or pre-lock live render)

/**
 * Legacy routes (kept for backward compatibility)
 */
router.post('/sendContract', sendOrGenerateContract);
router.post('/getContract', getContract);
router.post('/view', viewContractPdf);
router.post('/accept', acceptContract);
router.post('/reject', rejectContract);
router.post('/resend', resendContract);
router.post('/rejectedByBrand', getRejectedContractsByBrand);
router.post('/rejectedByInfluencer', getRejectedContractsByInfluencer);

module.exports = router;
