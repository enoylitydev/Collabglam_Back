const mongoose = require('mongoose');

/* ────────────────────────────────
   Embedded → topCountries
   – ONLY countryId, name, percentage
────────────────────────────────── */
const topCountrySchema = new mongoose.Schema(
  {
    countryId  : { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
    name       : { type: String, required: true },          // e.g. “United States”
    percentage : { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

/* ────────────────────────────────
   Embedded → ageBreakdown
   – now carries audienceRangeId too
────────────────────────────────── */
const ageBreakdownSchema = new mongoose.Schema(
  {
    audienceRangeId : { type: mongoose.Schema.Types.ObjectId, ref: 'Audience', required: true },
    range           : { type: String, required: true },     // e.g. “25-34”
    percentage      : { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

const mediaKitSchema = new mongoose.Schema(
  {
    /* primary keys */
    influencerId   : { type: String, required: true, unique: true },

    /* headline info */
    name           : { type: String, required: true },
    profileImage   : String,
    bio            : String,
    followers      : Number,
    engagementRate : Number,

    /* taxonomy */
    platformName : String,
    categories   : [String],

    /* gender split */
    audienceBifurcation: {
      malePercentage   : { type: Number, min: 0, max: 100 },
      femalePercentage : { type: Number, min: 0, max: 100 },
    },

    /* revised embedded arrays */
    topCountries : [topCountrySchema],
    ageBreakdown : [ageBreakdownSchema],

    interests : [String],
    gallery   : [String],

    /* collateral */
    mediaKitPdf : String,
    email       : String,
    website     : String,

    /* manual columns */
    notes    : { type: String, default: '' },
    rateCard : { type: String },               // URL or file-id
  },
  { timestamps: true }
);

module.exports = mongoose.model('MediaKit', mediaKitSchema);
