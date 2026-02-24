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
}, { _id: false });

const categorySelectionSchema = new mongoose.Schema({
  // ✅ Use the public numeric Category.id, not ObjectId
  categoryId: {
    type: Number,
    required: true,
    index: true
  },
  categoryName: {
    type: String,
    required: true
  },
  subcategoryId: {
    type: String, // UUID from your categories seed
    required: true,
    index: true
  },
  subcategoryName: {
    type: String,
    required: true
  }
}, { _id: false });

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
      location: '' // legacy
    })
  },

  // ⬇️ categories replace interests
  categories: [categorySelectionSchema],

  goal: {
    type: String,
    enum: ['Brand Awareness', 'Sales', 'Engagement'],
    required: true
  },

  // ✅ NEW: campaignType (optional, no enum, not required)
  campaignType: {
    type: String,
    default: ''
  },

  creativeBriefText: {
    type: String,
    default: ''
  },
  budget: {
    type: Number,
    default: 0
  },
  influencerBudget: {
    type: Number,
    default: 0
  },
  timeline: {
    startDate: { type: Date },
    endDate: { type: Date }
  },
  images: [{ type: String }],
  creativeBrief: [{ type: String }],
  additionalNotes: {
    type: String,
    default: ''
  },

  campaignStatus: {
    type: String,
    enum: ['open', 'paused'],
    default: 'open',
    index: true
  },
  statusUpdatedAt: { type: Date, default: Date.now },
  pausedAt: { type: Date, default: null },
  isActive: {
    type: Number,
    enum: [0, 1],
    default: 1
  },
  applicantCount: {
    type: Number,
    default: 0
  },
  hasApplied: {
    type: Number,
    enum: [0, 1],
    default: 0
  },
  isDraft: {
    type: Number,
    enum: [0, 1],
    default: 0 // 0 = normal, 1 = draft
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// 🔧 Helpful indexes for this query pattern
campaignSchema.index({ 'categories.subcategoryId': 1 });
campaignSchema.index({ 'categories.categoryId': 1 });
campaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, campaignStatus: 1, createdAt: -1 });

/* Create & export model */
const Campaign = mongoose.models.Campaign || mongoose.model('Campaign', campaignSchema);
module.exports = Campaign;
