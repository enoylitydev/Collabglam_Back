//models/subscription.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const featureSchema = new mongoose.Schema({
  key: { type: String, required: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }   // 0 ⇒ unlimited
}, { _id: false });

const subscriptionPlanSchema = new mongoose.Schema({
  planId:   { type: String, required: true, unique: true, default: uuidv4 },
  role:     { type: String, enum: ['Brand', 'Influencer'], required: true },
  name:     { type: String, required: true },

  monthlyCost: { type: Number, required: true, min: 0 },

  /** Feature catalogue for this plan */
  features: { type: [featureSchema], default: [] },

  /** Billing & lifecycle flags */
  autoRenew: { type: Boolean, default: false },          // free/basic → true
  status:    { type: String, enum: ['active', 'archived'], default: 'active' },

  /** How long one cycle lasts (mins) – handy for local testing */
  durationMins: { type: Number, default: 43200 },        // 30 days

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
