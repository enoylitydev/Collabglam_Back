// routes/brandRoutes.js

const express = require('express');
const router = express.Router();
const { register, login, 
  verifyToken,
   getBrandById, getAllBrands, requestOtp, verifyOtp, 
  requestPasswordResetOtp, verifyPasswordResetOtp,
   resetPassword,updateProfile,requestEmailUpdate,
  verifyEmailUpdate} = require('../controllers/brandController');

const { searchInfluencers } = require('../controllers/influencerController');

// POST /brand/register → register a new brand
router.post('/register', register);
router.post('/requestOtp', requestOtp);
router.post('/verifyOtp', verifyOtp);

router.post('/resetotp', requestPasswordResetOtp);
router.post('/resetVerify', verifyPasswordResetOtp);
router.post('/updatePassword', resetPassword);

// POST /brand/login → login an existing brand
router.post('/login', login);
router.get(
  '/',
  verifyToken,
  getBrandById
);
router.post(
  '/getAll',
  verifyToken,
  getAllBrands
);


// POST /brand/searchInfluencers → search influencers by name
router.post(
  '/searchInf',
  verifyToken,
  searchInfluencers
);

router.post('/update',verifyToken,updateProfile);

router.post('/requestEmailUpdate',verifyToken,requestEmailUpdate);

router.post('/verifyEmailUpdate',verifyToken,verifyEmailUpdate);


module.exports = router;
