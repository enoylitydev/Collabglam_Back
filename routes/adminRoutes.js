const express = require('express');
const router = express.Router();
const {login,getAllBrands,getList,getAllCampaigns,getBrandById,
    getByInfluencerId, getCampaignById,getCampaignsByBrandId,adminGetInfluencerById,
    adminGetInfluencerList

} = require('../controllers/adminController');  


const {
  adminListPayouts,
  adminMarkMilestonePaid
} = require('../controllers/milestoneController');



// POST /admin/create
router.post('/login', login);    
router.post('/brand/getlist', getAllBrands);
router.post('/influencer/getlist', getList);
router.post('/campaign/getlist', getAllCampaigns);
// GET /admin/brand/getById
router.get('/brand/getById', getBrandById);
router.get('/influencer/getById', getByInfluencerId);
router.get('/campaign/getById', getCampaignById);
router.post('/campaign/getByBrandId', getCampaignsByBrandId);

router.get('/influencer/byId', adminGetInfluencerById);
router.post('/influencer/list', adminGetInfluencerList);

router.post('/milestone/payout', adminListPayouts);
router.post('/milestone/update', adminMarkMilestonePaid);


module.exports = router;