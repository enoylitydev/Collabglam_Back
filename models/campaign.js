// models/campaigns.js

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const targetAudienceSchema = new mongoose.Schema({
  age: {
    MinAge: { type: Number },
    MaxAge: { type: Number }
  },
  gender: {
    type: Number,
    enum: [0, 1, 2],  // 0 → Female, 1 → Male, 2 → All
    required: true,
    default: 2
  },
  locations: [
    {
      countryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Country',
        required: true
      },
      countryName: {
        type: String,
        required: true
      }
    }
  ]
});

const campaignSchema = new mongoose.Schema({
  brandId: {
    type: String,
    required: true,
    default: uuidv4
  },
  campaignsId: {
    type: String,
    required: true,
    unique: true,
    default: uuidv4
  },
  brandName: {
    type: String,
    required: true
  },
  productOrServiceName: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  targetAudience: {
    type: targetAudienceSchema,
    default: () => ({
      age: { MinAge: 0, MaxAge: 0 },
      gender: 2,
      location: ''
    })
  },
  interestId: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Interest'
    }
  ],
  interestName: {
    type: String,
    default: ''
  },
  goal: {
    type: String,
    enum: ['Brand Awareness', 'Sales', 'Engagement'],
    required: true
  },
  creativeBriefText: {
    type: String,
    default: ''
  },
  budget: {
    type: Number,
    default: 0
  },
  timeline: {
    startDate: { type: Date },
    endDate:   { type: Date }
  },
  images: [
    {
      type: String
    }
  ],
  creativeBrief: [
    {
      type: String
    }
  ],
  additionalNotes: {
    type: String,
    default: ''
  },
  isActive: {
    type: Number,
    enum: [0, 1],
    default: 1
  },
  applicantCount: {
    type: Number,
    default: 0
  },
  // ← NEW FIELD: hasApplied (0 = not applied, 1 = applied)
  hasApplied: {
    type: Number,
    enum: [0, 1],
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Campaign', campaignSchema);
