// routes/influencerRoutes.js
const express = require('express');
const router  = express.Router();
const {
  registerInfluencer,
  uploadProfileImage,
  login,
  verifyToken,
  getList,
  getById,
getCampaignsByInfluencer,
requestOtpInfluencer,
verifyOtpInfluencer,
requestPasswordResetOtpInfluencer,
verifyPasswordResetOtpInfluencer,
resetPasswordInfluencer,
viewPaymentByType,
addPaymentMethod,
deletePaymentMethod,
updatePaymentMethod,
suggestInfluencers,
updateProfile,
requestEmailUpdate,
verifyotp
} = require('../controllers/influencerController');


const {searchBrands} = require('../controllers/brandController');

// Public endpoints:
router.post('/request-otp', requestOtpInfluencer);
router.post('/verify-otp', verifyOtpInfluencer);
router.post('/register', uploadProfileImage,registerInfluencer);
router.post('/login',    login);
router.post('/get-campaign',getCampaignsByInfluencer);
router.post('/getlist',verifyToken,getList);
router.get('/getById', verifyToken,getById);

router.post('/sendOtp', requestPasswordResetOtpInfluencer);
router.post('/verifyOtp',   verifyPasswordResetOtpInfluencer);
router.post('/updatePassword', resetPasswordInfluencer);

router.post('/viewPaymentByType', verifyToken, viewPaymentByType);

router.post('/addPaymentMethod', verifyToken, addPaymentMethod);
router.post('/deletePaymentMethod', verifyToken, deletePaymentMethod);
router.post('/updatePaymentMethod', verifyToken, updatePaymentMethod);
router.post('/suggestInfluencers', verifyToken, suggestInfluencers);

// POST /influencer/searchBrands → search brands by name
router.post(    
  '/searchBrand',
  verifyToken,
  searchBrands
);  

router.post('/updateProfile', verifyToken, uploadProfileImage, updateProfile);
router.post('/requestEmailUpdate', verifyToken, requestEmailUpdate);
router.post('/verifyEmailUpdateOtp', verifyToken, verifyotp);

module.exports = router;
