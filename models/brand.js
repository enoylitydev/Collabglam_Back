// models/brand.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ---- NEW: regex & helpers ----
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
const phoneRegex = /^[0-9]{10}$/;

const COMPANY_SIZE_ENUM = ['1-10', '11-50', '51-200', '200+'];

// URL normalizer
function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

const DEFAULT_FREE_PLAN_ID = 'ca41f2c1-7fbd-4e22-b27c-d537ecbaf02a';

// ---------------- Subscription Subschemas ----------------
const subscriptionFeatureSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    limit: { type: Number, required: true }, // 0 = unlimited
    used: { type: Number, default: 0 },
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, default: DEFAULT_FREE_PLAN_ID },
    planName: { type: String, required: true, default: 'free' },
    role: { type: String, enum: ['Brand', 'Influencer'], default: 'Brand' },
    planRef: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    monthlyCost: { type: Number, default: 0 },
    autoRenew: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    durationMins: { type: Number, default: 43200 },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    features: { type: [subscriptionFeatureSchema], default: [] },
  },
  { _id: false }
);

// ---------------- Brand Schema ----------------
const brandSchema = new mongoose.Schema(
  {
    brandId: { type: String, required: true, unique: true, default: uuidv4 },
    name: { type: String, required: true },
    password: { type: String, minlength: 8, required: true },
    phone: { type: String, match: [phoneRegex, 'Invalid phone'], required: true },
    country: { type: String, required: true },
    callingcode: { type: String, required: true },
    countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },
    callingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: true },

    email: { type: String, required: true, unique: true, match: [emailRegex, 'Invalid email'] },
    createdAt: { type: Date, default: Date.now },

    // ---------------- NEW REFERENCES ----------------
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    businessType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusinessType',
    },

    website: {
      type: String,
      set: normalizeUrl,
      validate: {
        validator: v => !v || /^https?:\/\/[^\s]+$/i.test(v),
        message: 'Invalid website URL',
      },
    },
    instagramHandle: {
      type: String,
      set: v => {
        const s = String(v || '').trim().replace(/^@/, '').toLowerCase();
        return s || undefined;
      },
      match: [/^[a-z0-9._]{1,30}$/i, 'Invalid Instagram handle'],
    },
    logoUrl: {
      type: String,
      set: normalizeUrl,
      validate: {
        validator: v => !v || /^https?:\/\/[^\s]+$/i.test(v),
        message: 'Invalid logo URL',
      },
    },
    companySize: { type: String, enum: COMPANY_SIZE_ENUM },
    referralCode: { type: String, trim: true },
    isVerifiedRepresentative: { type: Boolean, required: true, default: false },

    passwordResetCode: { type: String },
    passwordResetExpiresAt: { type: Date },
    passwordResetVerified: { type: Boolean, default: false },

    subscription: { type: subscriptionSchema, default: () => ({}) },
    subscriptionExpired: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

// Hash password before saving
brandSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password helper
brandSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('Brand', brandSchema);
