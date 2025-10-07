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
  released: {
    type: Boolean,
    default: false
  },
  releasedAt: {
    type: Date
  }
}, { 
  _id: false,        // you still key off milestoneHistoryId  
  timestamps: true   // adds createdAt & updatedAt on each sub‐doc
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
  walletBalance: {
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
