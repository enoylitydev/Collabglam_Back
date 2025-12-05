// models/milestonePayment.js

const mongoose = require('mongoose');

const milestonePaymentSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  paymentId: {
    type: String,
  },
  signature: {
    type: String,
  },
  amount: {
    type: Number,
    required: true, // in minor units (same as Razorpay: paise)
  },
  currency: {
    type: String,
    required: true,
    default: 'INR', // or 'USD' if you prefer, but Razorpay usually INR
  },
  receipt: {
    type: String,
  },

  // Who paid and for what
  brandId: {
    type: String,
    required: true,
  },
  influencerId: {
    type: String,
    required: true,
  },
  campaignId: {
    type: String,
    required: true,
  },
  milestoneTitle: {
    type: String,
  },

  status: {
    type: String,
    enum: ['created', 'paid', 'failed'],
    default: 'created',
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  paidAt: {
    type: Date,
  },
});

module.exports = mongoose.model('MilestonePayment', milestonePaymentSchema);
