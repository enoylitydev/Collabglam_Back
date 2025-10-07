const express = require('express');
const { getAllCountries } = require('../controllers/modashController');

const router = express.Router();

// GET /api/countries
router.get('/getAll', getAllCountries);

module.exports = router;