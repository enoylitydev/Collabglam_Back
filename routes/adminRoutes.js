const express = require('express');
const router = express.Router();
const {login,getAllBrands,getList,getAllCampaigns,getBrandById,getByInfluencerId, getCampaignById,getCampaignsByBrandId} = require('../controllers/adminController');  

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

module.exports = router;