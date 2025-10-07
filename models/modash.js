// models/modash.js
const mongoose = require('mongoose');

const modashCountrySchema = new mongoose.Schema(
  {
    countryId: { type: Number, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

// Text index for quick search
modashCountrySchema.index({ name: 'text', title: 'text' });

module.exports = mongoose.model('ModashCountry', modashCountrySchema);
