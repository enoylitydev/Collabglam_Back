// routes/emailRoutes.js
const express = require('express');
const router = express.Router();
const emailController = require('../controllers/emailController');

// Template: load predefined template (with placeholders filled)
router.get('/templates/:key', emailController.getTemplateByKey);

// Brand sends to Influencer (generic)
router.post('/brand-to-influencer', emailController.sendBrandToInfluencer);

// Influencer sends to Brand (generic)
router.post('/influencer-to-brand', emailController.sendInfluencerToBrand);

// Brand → influencer campaign invitation using IDs + template
router.post('/campaign-invitation', emailController.sendCampaignInvitation);

router.post(
  '/campaign-invitation/preview',
  emailController.getCampaignInvitationPreview
);

// Threads
router.get('/threads/brand/:brandId', emailController.getThreadsForBrand);
router.get(
  '/threads/influencer/:influencerId',
  emailController.getThreadsForInfluencer
);

// Messages
router.get('/messages/:threadId', emailController.getMessagesForThread);


router.get(
  '/influencer/list',
  emailController.getInfluencerEmailListForBrand
);

module.exports = router;
