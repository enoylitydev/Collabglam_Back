'use strict';

const router = require('express').Router();
const {
  syncYouTubeProfile,
  getAllInfluencers,
  updateInfluencerManualFields,
} = require('../controllers/youtubeController');

router.post('/handel-data', syncYouTubeProfile);
router.post('/getall', getAllInfluencers);
router.post('/update-manual', updateInfluencerManualFields);
module.exports = router;