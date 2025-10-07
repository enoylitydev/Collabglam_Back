// models/influencer.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { edgeNgrams, charNgrams } = require('../utils/searchTokens');

const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
const phoneRegex = /^[0-9]{10}$/;

// Payment sub-schema
const paymentSchema = new mongoose.Schema({
  paymentId: { type: String, default: () => uuidv4() },
  type: { type: Number, enum: [0, 1], required: true }, 
  bank: {
    accountHolder: { type: String, required: function () { return this.type === 1; } },
    accountNumber: { type: String, required: function () { return this.type === 1; } },
    ifsc: { type: String },
    swift: { type: String },
    bankName: { type: String, required: function () { return this.type === 1; } },
    branch: { type: String },
    countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.type === 1; } },
    countryName: { type: String, required: function () { return this.type === 1; } }
  },
  paypal: {
    email: { type: String, match: [emailRegex, 'Invalid PayPal email'], required: function () { return this.type === 0; } },
    username: { type: String }
  },
  isDefault: { type: Boolean, default: false }
}, { _id: false, timestamps: true });

const influencerSchema = new mongoose.Schema({
  influencerId: { type: String, required: true, unique: true, default: uuidv4 },
  name: { type: String, required: function () { return this.otpVerified; } },
  email: { type: String, required: true, unique: true, match: [emailRegex, 'Invalid email'] },
  password: { type: String, minlength: 8, required: function () { return this.otpVerified; } },
  phone: { type: String, match: [phoneRegex, 'Invalid phone'], required: function () { return this.otpVerified; } },
  socialMedia: { type: String, required: function () { return this.otpVerified; } },
  gender: { type: Number, enum: [0, 1, 2], required: function () { return this.otpVerified; } },
  profileLink: { type: String, required: function () { return this.otpVerified; } },
  profileImage: { type: String, required: function () { return this.otpVerified; } },
  audienceBifurcation: {
    malePercentage: { type: Number, min: 0, max: 100, required: function () { return this.otpVerified; } },
    femalePercentage: { type: Number, min: 0, max: 100, required: function () { return this.otpVerified; } }
  },
  categories: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Interest', required: true }],
    validate: {
      validator: function (arr) {
        if (!this.otpVerified) return true;
        return Array.isArray(arr) && arr.length >= 1 && arr.length <= 3;
      },
      message: 'You must select between 1 and 3 categories.'
    },
    required: function () { return this.otpVerified; }
  },
  categoryName: {
    type: [String],
    default: [],
    validate: {
      validator: function (arr) {
        if (!this.otpVerified) return true;
        return Array.isArray(arr) && arr.length === this.categories.length;
      },
      message: 'categoryName entries must correspond 1:1 with categories.'
    },
    required: function () { return this.otpVerified; }
  },
  platformId: { type: mongoose.Schema.Types.ObjectId, ref: 'Platform', required: function () { return this.otpVerified; } },
  platformName: { type: String, required: function () { return this.otpVerified; } },
  audienceAgeRangeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Audience', required: function () { return this.otpVerified; } },
  audienceAgeRange: { type: String, required: function () { return this.otpVerified; } },
  audienceId: { type: mongoose.Schema.Types.ObjectId, ref: 'AudienceRange', required: function () { return this.otpVerified; } },
  audienceRange: { type: String, required: function () { return this.otpVerified; } },
  countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.otpVerified; } },
  country: { type: String, required: function () { return this.otpVerified; } },
  callingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.otpVerified; } },
  callingcode: { type: String, required: function () { return this.otpVerified; } },
  bio: { type: String, default: '' },

  // 🔎 Autocomplete tokens (indexed array). Each token is LOWERCASE.
  _ac: { type: [String], index: true },

  createdAt: { type: Date, default: Date.now },

  // Legacy OTP fields (kept for backward compatibility; not used in new OTP flow)
  otpCode: { type: String },
  otpExpiresAt: { type: Date },
  otpVerified: { type: Boolean, default: false },

  passwordResetCode: { type: String },
  passwordResetExpiresAt: { type: Date },
  passwordResetVerified: { type: Boolean, default: false },

  paymentMethods: { type: [paymentSchema], default: [] },

  // Keep your original subscription structure
  subscription: {
    planName: { type: String, required: true, default: 'free' },
    planId: { type: String, required: true, default: 'a58683f0-8d6e-41b0-addd-a718c2622142' },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    features: {
      type: [new mongoose.Schema({
        key: { type: String, required: true },
        limit: { type: Number, required: true },
        used: { type: Number, required: true }
      }, { _id: false })],
      default: []
    }
  },

  subscriptionExpired: { type: Boolean, default: false },
  failedLoginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null }
}, { timestamps: true });

/* ---------------------- Helpful Indexes for Filters ---------------------- */
influencerSchema.index({ countryId: 1 });
influencerSchema.index({ platformId: 1 });
influencerSchema.index({ gender: 1 });
influencerSchema.index({ audienceRange: 1 });
influencerSchema.index({ 'audienceBifurcation.malePercentage': 1 });
influencerSchema.index({ 'audienceBifurcation.femalePercentage': 1 });
influencerSchema.index({ name: 1 });              // for stable alphabetical sorts

/* -------------------- Keep only one default payment method -------------------- */
influencerSchema.pre('validate', function (next) {
  if (Array.isArray(this.paymentMethods)) {
    this.paymentMethods.forEach(pm => { if (!pm.paymentId) pm.paymentId = uuidv4(); });
    const defaults = this.paymentMethods.filter(pm => pm.isDefault);
    if (defaults.length > 1) return next(new Error('Only one payment method can be marked as default.'));
  }
  next();
});

/* ------------------------- Autocomplete Token Builder ------------------------- */
const AC_FIELDS = ['name', 'categoryName', 'platformName', 'country', 'socialMedia', 'bio'];
const normalize = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : '');

function buildACTokens(doc) {
  const bag = [];
  const pushFor = (val) => {
    const norm = normalize(val);
    if (!norm) return;
    bag.push(...edgeNgrams(norm));
    bag.push(...charNgrams(norm, 2, 4));
  };
  for (const f of AC_FIELDS) {
    const v = doc[f];
    if (!v) continue;
    if (Array.isArray(v)) v.forEach(pushFor);
    else pushFor(v);
  }
  const deduped = Array.from(new Set(bag.filter(Boolean)));
  return deduped.slice(0, 2000);
}

/* ----------------- Recompute _ac on saves and updates ----------------- */
influencerSchema.pre('save', function (next) {
  this._ac = buildACTokens(this);
  next();
});

influencerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (e) { next(e); }
});

/* ------------------------------- Methods ------------------------------- */
influencerSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Partial unique index on paymentMethods.paymentId
influencerSchema.index(
  { 'paymentMethods.paymentId': 1 },
  { unique: true, partialFilterExpression: { 'paymentMethods.paymentId': { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Influencer', influencerSchema);
