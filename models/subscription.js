// models/subscription.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const featureSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    note:  { type: String } // optional human-readable hint
  },
  { _id: false }
);

const addOnSchema = new mongoose.Schema(
  {
    key:      { type: String, required: true },
    name:     { type: String, required: true },
    type:     { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },
    price:    { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' },
    payload:  { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false }
);

const subscriptionPlanSchema = new mongoose.Schema({
  planId:   { type: String, required: true, unique: true, default: uuidv4 },

  /** Audience */
  role:     { type: String, enum: ['Brand', 'Influencer'], required: true },

  /** Identifiers for UI */
  name:        { type: String, required: true },      // slug (e.g., 'free', 'growth', 'creator_plus')
  displayName: { type: String },                      // UI label (e.g., 'FREE', 'GROWTH', 'CREATOR PLUS')
  label:       { type: String },                      // accent like 'Best Value'

  /** Pricing */
  monthlyCost:     { type: Number, required: true, min: 0 },
  currency:        { type: String, default: 'USD' },
  isCustomPricing: { type: Boolean, default: false },  // Enterprise-style plans

  /** Descriptions */
  overview:   { type: String },                       // short plan overview text

  /** Feature catalogue – ONLY THIS FIELD */
  features:   { type: [featureSchema], default: [] },

  /** Optional add-ons */
  addons:     { type: [addOnSchema], default: [] },

  /** Billing & lifecycle flags */
  autoRenew:  { type: Boolean, default: false },
  status:     { type: String, enum: ['active', 'archived'], default: 'active' },

  /** Cycle length (mins) – useful for local testing */
  durationMins:    { type: Number, default: 43200 },     // 30 days
  // optional extra duration fields – keep if you use them
  durationMinutes: { type: Number },
  durationDays:    { type: Number },

  /** Sorting in price table (lower first). Enterprise kept last with a higher number */
  sortOrder:  { type: Number, default: 100 },

  createdAt:  { type: Date, default: Date.now }
});

// Guard: unique per (role, name)
subscriptionPlanSchema.index({ role: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
