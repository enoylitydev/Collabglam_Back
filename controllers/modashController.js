const Country = require('../models/modash');

exports.getAllCountries = async (req, res) => {
  try {
    // omit __v; include everything else
    const countries = await Country.find({}, '-__v').lean();
    return res.status(200).json(countries);
  } catch (err) {
    console.error('Error fetching countries:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
