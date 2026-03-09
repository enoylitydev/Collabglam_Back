const express = require('express');
const router = express.Router();
const faqCtrl = require('../controllers/faqsController');

// Create or replace full FAQ page document
router.post('/save', faqCtrl.saveFAQPage);

// Get full FAQ page
router.post('/get', faqCtrl.getFAQPage);

// Get admin full FAQ page
router.post('/admin/get', faqCtrl.getFAQPageAdmin);

// FAQ item operations
router.post('/item/add', faqCtrl.addFAQItem);
router.post('/item/updateById', faqCtrl.updateFAQItem);
router.post('/item/deleteById', faqCtrl.deleteFAQItem);

module.exports = router;