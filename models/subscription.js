// models/subscription.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/**
 * Flexible feature key/value pairs so we can evolve plans without schema churn.
 * Examples:
 *  - { key: 'invites_per_month', value: 50 }
 *  - { key: 'monthly_credits', value: 8 }
 *  - { key: 'search_cached_only', value: 1 }
 *  - { key: 'live_campaigns_limit', value: 10 }
 *  - { key: 'media_kit_items_limit', value: 60 }
 *  - { key: 'saved_searches', value: 1 }
 *  - { key: 'apply_to_campaigns_quota', value: 0 } // 0 ⇒ unlimited
 */
const featureSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    note: { type: String } // optional human-readable hint
  },
  { _id: false }
);

/**
 * Lightweight plan add-ons (e.g., Discovery Pack).
 * These are *available* on a plan; purchasing/usage should live elsewhere.
 */
const addOnSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },           // e.g. 'discovery_pack_50'
    name: { type: String, required: true },          // e.g. 'Discovery Pack (+50 credits)'
    type: { type: String, enum: ['one_time', 'recurring'], default: 'one_time' },
    price: { type: Number, required: true, min: 0 }, // in USD unless overridden
    currency: { type: String, default: 'USD' },
    payload: { type: mongoose.Schema.Types.Mixed }   // e.g. { credits: 50 }
  },
  { _id: false }
);

const subscriptionPlanSchema = new mongoose.Schema({
  planId:   { type: String, required: true, unique: true, default: uuidv4 },
  role:     { type: String, enum: ['Brand', 'Influencer'], required: true },
  name:     { type: String, required: true },        // e.g. 'free', 'growth', 'pro', 'premium', 'basic', 'creator', 'elite'
  label:    { type: String },                        // UI accent, e.g. 'Best Value'
  monthlyCost: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD' },

  /** Feature catalogue for this plan */
  features: { type: [featureSchema], default: [] },

  /** Add-ons that can be purchased alongside this plan (e.g., Discovery Pack) */
  addons: { type: [addOnSchema], default: [] },

  /** Billing & lifecycle flags */
  autoRenew: { type: Boolean, default: false },      // free/basic for tests → true
  status:    { type: String, enum: ['active', 'archived'], default: 'active' },

  /** How long one cycle lasts (mins) – handy for local testing */
  durationMins: { type: Number, default: 43200 },    // 30 days

  createdAt: { type: Date, default: Date.now }
});

// Unique guard so we don't double-seed same (role, name)
subscriptionPlanSchema.index({ role: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
