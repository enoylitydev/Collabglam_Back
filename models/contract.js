// ========================= models/contract.js (rewritten) =========================
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

/**
 * Canonical status machine
 */
const STATUS = [
  'draft',       // created (not sent)
  'sent',        // brand sent (influencer sees "Received")
  'viewed',      // influencer opened
  'negotiation', // edits/notes exchanged
  'finalize',    // frozen for signatures (no further edits expected)
  'signing',     // at least one signature captured
  'locked'       // snapshot frozen as system of record (as soon as all required signatures captured)
];

// ---- Subschemas ----
const SignatureSchema = new mongoose.Schema({
  signed: { type: Boolean, default: false },
  byUserId: { type: String },
  name: { type: String },
  email: { type: String },
  at: { type: Date },
  sigImageDataUrl: { type: String }, // data:image/png;base64,...
  sigImageBytes: { type: Number }
}, { _id: false });

const AuditEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  byUserId: { type: String, default: '' },
  role: { type: String, enum: ['brand','influencer','admin','system'], default: 'system' },
  type: { type: String }, // INITIATED, VIEWED, EDITED, FINALIZED, SIGNED, LOCKED, ADMIN_UPDATED, BRAND_EDITED, INFLUENCER_EDITED
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
  spendCap: { type: Number },
  audienceRestrictions: { type: String }
}, { _id: false });

const ConfirmationSchema = new mongoose.Schema({
  confirmed: { type: Boolean, default: false },
  byUserId: { type: String },
  at: { type: Date }
}, { _id: false });

const LastEditSchema = new mongoose.Schema({
  isEdit: { type: Boolean, default: false },
  by: { type: String, enum: ['brand','influencer','admin','system',''], default: '' },
  at: { type: Date },
  fields: [String]
}, { _id: false });

// ---- Contract schema ----
const contractSchema = new mongoose.Schema({
  contractId: { type: String, required: true, unique: true, default: uuidv4 },
  brandId: { type: String, required: true, ref: 'Brand' },
  influencerId: { type: String, required: true, ref: 'Influencer' },
  campaignId: { type: String, required: true, ref: 'Campaign' },

  status: { type: String, enum: STATUS, default: 'draft' },

  // Confirmations (quick ACKs—not signatures)
  confirmations: {
    brand: { type: ConfirmationSchema, default: () => ({ confirmed: false }) },
    influencer: { type: ConfirmationSchema, default: () => ({ confirmed: false }) }
  },

  // ----- BRAND (was YELLOW) -----
  brand: {
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
    deliverablesPresetKey: { type: String },
    deliverablesExpanded: [ExpandedDeliverableSchema]
  },

  // ----- INFLUENCER (was PURPLE) -----
  influencer: {
    shippingAddress: { type: String },
    dataAccess: {
      insightsReadOnly: { type: Boolean, default: false },
      whitelisting: { type: Boolean, default: false },
      sparkAds: { type: Boolean, default: false }
    },
    taxFormType: { type: String, enum: ['W-9','W-8BEN','W-8BEN-E'], default: 'W-9' }
  },

  // ----- OTHER/System (was GREY) -----
  other: {
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
      firstDraftDue: Date,               // 7 business days before go-live start (safety floor)
      tokensExpandedAt: { type: Date }   // when tokens were last hydrated
    }
  },

  // ----- ADMIN (was GREEN) -----
  admin: {
    governingLaw: { type: String, default: 'California, United States' },
    arbitrationSeat: { type: String, default: 'San Francisco, CA' },
    timezone: { type: String, default: 'America/Los_Angeles' },
    jurisdiction: { type: String, default: 'USA' },
    fxSource: { type: String, default: 'ECB' },
    defaultBrandReviewWindowBDays: { type: Number, default: 2 },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: '' },

    // Admin-locked legal text (versioned)
    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String },
    legalTemplateHistory: [{
      version: Number,
      text: String,
      updatedAt: { type: Date, default: Date.now },
      updatedBy: { type: String }
    }]
  },

  // Template + tokens
  templateVersion: { type: Number, default: 1 },
  templateTokensSnapshot: { type: Object, default: {} },
  renderedTextSnapshot: { type: String },

  /**
   * Effective date handling
   * - requestedEffectiveDate: brand intent; used only in tokens/display
   * - effectiveDate: system-of-record = later of all required signatures, unless override is set
   */
  requestedEffectiveDate: { type: Date },
  requestedEffectiveDateTimezone: { type: String, default: 'America/Los_Angeles' },

  effectiveDate: { type: Date },
  effectiveDateTimezone: { type: String, default: 'America/Los_Angeles' },
  effectiveDateOverride: { type: Date }, // admin-only override for rare legal cases
  lockedAt: { type: Date },

  // Signatures (tri-party)
  signatures: {
    brand: { type: SignatureSchema, default: () => ({}) },
    influencer: { type: SignatureSchema, default: () => ({}) },
    collabglam: { type: SignatureSchema, default: () => ({}) }
  },

  // Edit tracking
  isEdit: { type: Boolean, default: false },
  isEditBy: { type: String, enum: ['brand','influencer','admin','system',''], default: '' },
  editedFields: [String],
  lastEdit: { type: LastEditSchema, default: () => ({ isEdit: false, by: '', fields: [] }) },

  // Audit trail
  audit: [AuditEventSchema],

  // Minimal denorm for headers/tokens (non-authoritative)
  brandName: { type: String },
  brandAddress: { type: String },
  influencerName: { type: String },
  influencerAddress: { type: String },
  influencerHandle: { type: String },

  createdAt: { type: Date, default: Date.now }
});

// Indexes
contractSchema.index({ contractId: 1 }, { unique: true });
contractSchema.index({ brandId: 1, influencerId: 1, campaignId: 1 });
contractSchema.index({ lastSentAt: -1 }, { sparse: true }); // legacy-safe; not required elsewhere
contractSchema.index({ lockedAt: 1 });
contractSchema.index({ status: 1 });
contractSchema.index({ 'audit.at': -1 });

module.exports = mongoose.model('Contract', contractSchema);
module.exports.STATUS = STATUS;
