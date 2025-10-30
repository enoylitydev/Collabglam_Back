// models/contract.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const SignatureSchema = new mongoose.Schema({
  signed: { type: Boolean, default: false },
  byUserId: { type: String },
  name: { type: String },
  email: { type: String },
  at: { type: Date }
}, { _id: false });

const AuditEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  byUserId: { type: String, default: '' },
  role: { type: String, enum: ['brand','influencer','admin','system'], default: 'system' },
  type: { type: String }, // e.g., INITIATED, PURPLE_CONFIRMED, ADMIN_UPDATED, SIGNED, LOCKED, RESENT, REJECTED
  details: { type: Object, default: {} }
}, { _id: false });

const ExpandedDeliverableSchema = new mongoose.Schema({
  type: String,
  quantity: Number,
  format: String,
  durationSec: Number,
  postingWindow: {
    start: Date,
    end: Date
  },
  draftRequired: { type: Boolean, default: false },
  draftDueDate: Date,
  minLiveHours: Number,
  tags: [String],
  handles: [String],
  captions: String,
  links: [String],
  disclosures: String,
  whitelisting: { type: Boolean, default: false },
  sparkAds: { type: Boolean, default: false }
}, { _id: false });

const UsageBundleSchema = new mongoose.Schema({
  type: { type: String, enum: ['Organic','Paid Digital','Custom'], default: 'Organic' },
  durationMonths: Number,
  geographies: [String],
  derivativeEditsAllowed: { type: Boolean, default: false },
  spendCap: { type: Number }, // optional for paid
  audienceRestrictions: { type: String } // text
}, { _id: false });

const OwnerEnum = ['yellow','purple','grey','green'];

const contractSchema = new mongoose.Schema({
  contractId: { type: String, required: true, unique: true, default: uuidv4 },
  brandId: { type: String, required: true, ref: 'Brand' },
  influencerId: { type: String, required: true, ref: 'Influencer' },
  campaignId: { type: String, required: true, ref: 'Campaign' },

  // ----- YELLOW (Brand fills small popup) -----
  yellow: {
    campaignTitle: { type: String },
    platforms: [{ type: String, enum: ['YouTube','Instagram','TikTok'] }],
    goLive: {
      start: { type: Date },
      end: { type: Date }
    },
    totalFee: { type: Number },
    currency: { type: String, default: 'USD' },
    milestoneSplit: { type: String }, // e.g., "50/50"
    usageBundle: UsageBundleSchema,
    revisionsIncluded: { type: Number, default: 1 },
    deliverablesPresetKey: { type: String }, // points to your preset id/key in app logic
    deliverablesExpanded: [ExpandedDeliverableSchema] // system-generated from preset
  },

  // ----- PURPLE (Influencer quick confirm) -----
  purple: {
    shippingAddress: { type: String },
    dataAccess: {
      insightsReadOnly: { type: Boolean, default: false },
      whitelisting: { type: Boolean, default: false },
      sparkAds: { type: Boolean, default: false }
    },
    taxFormType: { type: String, enum: ['W-9','W-8BEN','W-8BEN-E'], default: 'W-9' }
  },

  // ----- GREY (System pulls/auto-calcs) -----
  grey: {
    brandProfile: {
      legalName: String,
      address: String,
      contactName: String,
      email: String,
      country: String
    },
    influencerProfile: {
      legalName: String,
      address: String,
      contactName: String,
      email: String,
      country: String,
      handle: String
    },
    autoCalcs: {
      firstDraftDue: Date, // 7 business days before go-live start with safety floor
      tokensExpandedAt: { type: Date }
    }
  },

  // ----- GREEN (Admin controls) -----
  green: {
    governingLaw: { type: String, default: 'California, United States' },
    arbitrationSeat: { type: String, default: 'San Francisco, CA' },
    timezone: { type: String, default: 'America/Los_Angeles' },
    jurisdiction: { type: String, default: 'USA' },
    fxSource: { type: String, default: 'ECB' }, // Payments.FXSource
    defaultBrandReviewWindowBDays: { type: Number, default: 2 },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: '' },

    // Admin-locked legal text (versioned)
    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String }, // current active template text
    legalTemplateHistory: [{
      version: Number,
      text: String,
      updatedAt: { type: Date, default: Date.now },
      updatedBy: { type: String } // admin id/email
    }]
  },

  // ----- Template + tokens -----
  templateVersion: { type: Number, default: 1 }, // copy from green.legalTemplateVersion when frozen
  templateTokensSnapshot: { type: Object, default: {} }, // frozen on lock
  renderedTextSnapshot: { type: String }, // final rendered text at lock

  // Effective date handling
  effectiveDate: { type: Date },               // set at final signature (last signature time in chosen TZ)
  effectiveDateTimezone: { type: String, default: 'America/Los_Angeles' },
  effectiveDateOverride: { type: Date },       // optional admin override (audit still holds actual timestamp)
  lockedAt: { type: Date },                    // after final signature

  // Compatibility (from original)
  type: { type: Number, required: true },      // 0 = PDF only (stream), 1 = save
  isAssigned: { type: Number, default: 0 },
  isAccepted: { type: Number, default: 0 },    // legacy; keep for compatibility
  isRejected: { type: Number, default: 0 },
  rejectedReason: { type: String, default: '' },
  rejectedAt: { type: Date },
  resendCount: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: Date.now },

  // Signatures
  signatures: {
    brand: { type: SignatureSchema, default: () => ({}) },
    influencer: { type: SignatureSchema, default: () => ({}) },
    collabglam: { type: SignatureSchema, default: () => ({}) }
  },

  // Audit trail
  audit: [AuditEventSchema],

  // Minimal legacy fields (kept for old endpoints to function)
  brandName: { type: String },
  brandAddress: { type: String },
  influencerName: { type: String },
  influencerAddress: { type: String },
  influencerHandle: { type: String },
  effectiveDateStr: { type: String }, // deprecated, prefer effectiveDate
  deliverableDescription: { type: String }, // deprecated
  feeAmount: { type: String }, // deprecated

  createdAt: { type: Date, default: Date.now }
});

// Safety: clear rejection flags on accept
contractSchema.pre('save', function(next) {
  if (this.isAccepted === 1 || this.signatures?.influencer?.signed || this.signatures?.brand?.signed) {
    this.isRejected = 0;
    this.rejectedReason = '';
    this.rejectedAt = undefined;
  }
  next();
});

module.exports = mongoose.model('Contract', contractSchema);
