// models/milestone.js

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const milestoneHistorySchema = new mongoose.Schema({
  milestoneHistoryId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  influencerId: {
    type: String,
    required: true
  },
  campaignId: {
    type: String,
    required: true
  },
  milestoneTitle: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  milestoneDescription: {
    type: String,
    default: ''
  },

  // brand clicked “release” (for this milestone)
  released: {
    type: Boolean,
    default: false
  },
  releasedAt: {
    type: Date
  },

  // NEW: payout status for platform flow
  // pending -> not released
  // initiated -> released by brand, waiting for admin
  // paid -> approved by admin / sent to influencer
  payoutStatus: {
    type: String,
    enum: ['pending', 'initiated', 'paid'],
    default: 'pending'
  },
  paidAt: {
    type: Date
  }
}, {
  _id: false,
  timestamps: true
});

const milestoneSchema = new mongoose.Schema({
  milestoneId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  brandId: {
    type: String,
    required: true
  },

  // running balance of escrow for this brand
  walletBalance: {
    type: Number,
    required: true,
    default: 0
  },

  // NEW: total of all milestone amounts ever created for this brand
  totalAmount: {
    type: Number,
    required: true,
    default: 0
  },

  milestoneHistory: {
    type: [milestoneHistorySchema],
    default: []
  }
}, { timestamps: true });

module.exports = mongoose.model('Milestone', milestoneSchema);
