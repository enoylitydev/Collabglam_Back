const express            = require('express');
const { body }           = require('express-validator');
const router             = express.Router();
const mediaKitController = require('../controllers/mediaKitController');

/* -------------- validation helpers (express-validator) --------- */
const requireInfluencerId = body('influencerId')
  .notEmpty()
  .withMessage('influencerId is required');

/* -----------   ALL ROUTES USE POST & BODY PAYLOAD  ------------- */
router.post(
  '/influencer',
  requireInfluencerId,
  mediaKitController.getInfluencerDetails
);

router.post(
  '/list',
  mediaKitController.getAllMediaKits               // no body needed
);

router.post(
  '/get',
  requireInfluencerId,
  mediaKitController.getMediaKitById
);

router.post(
  '/create',
  requireInfluencerId,
  mediaKitController.createMediaKit
);

router.post(
  '/update',
  requireInfluencerId,
  mediaKitController.updateMediaKit
);

module.exports = router;
