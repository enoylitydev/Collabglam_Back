const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const faqItemSchema = new mongoose.Schema(
  {
    faqId: {
      type: String,
      default: uuidv4
    },
    sectionKey: {
      type: String,
      required: true,
      enum: [
        'general',
        'brand_questions',
        'creator_influencer_questions',
        'pricing_budget_fees_payouts',
        'campaign_workflow_questions',
        'messaging_safety_anti_bypass',
        'privacy_data_security',
        'legal_disclosure_content_rights',
        'billing_cancellations_refunds',
        'support_account_help'
      ]
    },
    sectionTitle: {
      type: String,
      required: true
    },
    question: {
      type: String,
      required: true,
      trim: true
    },
    answer: {
      type: String,
      required: true,
      trim: true
    },
    displayOrder: {
      type: Number,
      default: 0
    },
    isPublished: {
      type: Boolean,
      default: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedDate: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const faqSchema = new mongoose.Schema(
  {
    faqPageId: {
      type: String,
      default: uuidv4,
      unique: true
    },
    pageKey: {
      type: String,
      default: 'main_faq',
      unique: true
    },
    title: {
      type: String,
      default: 'CollabGlam Frequently Asked Questions (FAQ)',
      required: true
    },
    shortDescription: {
      type: String,
      required: true
    },
    introText: {
      type: String,
      required: true
    },
    contactHeading: {
      type: String,
      default: 'Contact Information'
    },
    contactText: {
      type: String,
      required: true
    },
    effectiveDate: {
      type: Date,
      required: true
    },
    updatedDate: {
      type: Date,
      default: Date.now
    },
    isPublished: {
      type: Boolean,
      default: true
    },
    items: {
      type: [faqItemSchema],
      default: []
    }
  },
  { timestamps: true }
);

const FAQ = mongoose.models.FAQ || mongoose.model('FAQ', faqSchema);
module.exports = FAQ;