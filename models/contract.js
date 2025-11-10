const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');


// ============================ Schema ============================
const STATUS = [
  'draft', 'sent', 'viewed', 'negotiation', 'finalize', 'signing', 'locked', 'rejected'
];

const SignatureSchema = new mongoose.Schema({
  signed: { type: Boolean, default: false },
  byUserId: { type: String },
  name: { type: String },
  email: { type: String },
  at: { type: Date },
  sigImageDataUrl: { type: String },
  sigImageBytes: { type: Number }
}, { _id: false });

const AuditEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  byUserId: { type: String, default: '' },
  role: { type: String, enum: ['brand', 'influencer', 'admin', 'system'], default: 'system' },
  type: { type: String },
  details: { type: Object, default: {} }
}, { _id: false });

const ExpandedDeliverableSchema = new mongoose.Schema({
  type: String,
  quantity: Number,
  format: String,
  durationSec: Number, // for videos
  postingWindow: { start: Date, end: Date },
  draftRequired: { type: Boolean, default: false },
  draftDueDate: Date,
  minLiveHours: Number,
  // NEW spec-aligned fields
  liveRetentionMonths: Number,          // Deliverables[i].LiveRetentionMonths
  revisionRoundsIncluded: Number,       // Deliverables[i].RevisionRoundsIncluded
  additionalRevisionFee: Number,        // Deliverables[i].AdditionalRevisionFee
  tags: [String],                       // Deliverables[i].TagsHandles <- combined at render
  handles: [String],
  captions: String,
  links: [String],
  disclosures: String,
  whitelisting: { type: Boolean, default: false },
  sparkAds: { type: Boolean, default: false }
}, { _id: false });

const UsageBundleSchema = new mongoose.Schema({
  // Accept any string to support values like OrganicUse, PaidDigitalUse, etc.
  type: { type: String, default: 'Organic' },
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
  by: { type: String, enum: ['brand', 'influencer', 'admin', 'system', ''], default: '' },
  at: { type: Date },
  fields: [String]
}, { _id: false });

const contractSchema = new mongoose.Schema({
  contractId: { type: String, required: true, unique: true, default: uuidv4 },
  brandId: { type: String, required: true, ref: 'Brand' },
  influencerId: { type: String, required: true, ref: 'Influencer' },
  campaignId: { type: String, required: true, ref: 'Campaign' },

  status: { type: String, enum: STATUS, default: 'draft' },

  confirmations: {
    brand: { type: ConfirmationSchema, default: () => ({ confirmed: false }) },
    influencer: { type: ConfirmationSchema, default: () => ({ confirmed: false }) }
  },

  // Brand data
  brand: {
    campaignTitle: { type: String },
    platforms: [{ type: String, enum: ['YouTube', 'Instagram', 'TikTok'] }],
    goLive: { start: { type: Date }, end: { type: Date } },
    totalFee: { type: Number },
    currency: { type: String, default: 'USD' },
    milestoneSplit: { type: String },
    usageBundle: UsageBundleSchema,
    revisionsIncluded: { type: Number, default: 1 },
    deliverablesPresetKey: { type: String },
    deliverablesExpanded: [ExpandedDeliverableSchema]
  },

  // Influencer data (expanded to persist acceptance details)
  influencer: {
    // acceptance fields
    legalName: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    taxId: { type: String, default: '' },

    addressLine1: { type: String, default: '' },
    addressLine2: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    country: { type: String, default: '' },
    notes: { type: String, default: '' },

    // existing fields
    shippingAddress: { type: String, default: '' },
    dataAccess: {
      insightsReadOnly: { type: Boolean, default: false },
      whitelisting: { type: Boolean, default: false },
      sparkAds: { type: Boolean, default: false }
    },
    taxFormType: { type: String, enum: ['W-9', 'W-8BEN', 'W-8BEN-E'], default: 'W-9' }
  },


  other: {
    brandProfile: { legalName: String, address: String, contactName: String, email: String, country: String },
    influencerProfile: { legalName: String, address: String, contactName: String, email: String, country: String, handle: String },
    autoCalcs: { firstDraftDue: Date, tokensExpandedAt: { type: Date } }
  },

  // Admin/System data
  admin: {
    governingLaw: { type: String, default: 'California, United States' },
    arbitrationSeat: { type: String, default: 'San Francisco, CA' },
    timezone: { type: String, default: 'America/Los_Angeles' },
    jurisdiction: { type: String, default: 'USA' },
    fxSource: { type: String, default: 'ECB' },
    defaultBrandReviewWindowBDays: { type: Number, default: 2 },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: '' },

    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String },
    legalTemplateHistory: [{ version: Number, text: String, updatedAt: { type: Date, default: Date.now }, updatedBy: { type: String } }]
  },

  // Template + tokens
  templateVersion: { type: Number, default: 1 },
  templateTokensSnapshot: { type: Object, default: {} },
  renderedTextSnapshot: { type: String },

  // Display preferences
  dateFormatShort: { type: String, default: 'MMMM D, YYYY' },
  dateFormatLong: { type: String, default: 'Do MMMM YYYY' },
  locale: { type: String, default: 'en-US' },

  // Effective date handling
  requestedEffectiveDate: { type: Date },
  requestedEffectiveDateTimezone: { type: String, default: 'America/Los_Angeles' },
  effectiveDate: { type: Date },
  effectiveDateTimezone: { type: String, default: 'America/Los_Angeles' },
  effectiveDateOverride: { type: Date },
  lockedAt: { type: Date },

  // Signatures (tri-party)
  signatures: {
    brand: { type: SignatureSchema, default: () => ({}) },
    influencer: { type: SignatureSchema, default: () => ({}) },
    collabglam: { type: SignatureSchema, default: () => ({}) }
  },

  // Edit tracking
  isEdit: { type: Boolean, default: false },
  isEditBy: { type: String, enum: ['brand', 'influencer', 'admin', 'system', ''], default: '' },
  editedFields: [String],
  lastEdit: { type: LastEditSchema, default: () => ({ isEdit: false, by: '', fields: [] }) },

  // Audit trail
  audit: [AuditEventSchema],

  // Denorms
  brandName: { type: String },
  brandAddress: { type: String },
  influencerName: { type: String },
  influencerAddress: { type: String },
  influencerHandle: { type: String },

  // Convenience fields
  lastSentAt: { type: Date },
  isAssigned: { type: Number, default: 0 },
  isAccepted: { type: Number, default: 0 },
  isRejected: { type: Number, default: 0 },
  feeAmount: { type: Number, default: 0 },
  currency: { type: String, default: 'USD' },

  // Resend lineage
  resendIteration: { type: Number, default: 0 },
  resendOf: { type: String },
  supersededBy: { type: String },
  resentAt: { type: Date },

  createdAt: { type: Date, default: Date.now }
});

// Indexes
contractSchema.index({ contractId: 1 }, { unique: true });
contractSchema.index({ brandId: 1, influencerId: 1, campaignId: 1 });
contractSchema.index({ lastSentAt: -1 });
contractSchema.index({ lockedAt: 1 });
contractSchema.index({ status: 1 });
contractSchema.index({ 'audit.at': -1 });
contractSchema.index({ resendOf: 1 });
contractSchema.index({ supersededBy: 1 });

function computeStatusFlags(doc) {
  const s = doc?.status || 'draft';

  const viewedOrBeyond = ['viewed', 'negotiation', 'finalize', 'signing', 'locked'].includes(s);
  const finalizeOrBeyond = ['finalize', 'signing', 'locked'].includes(s);
  const signingOrBeyond = ['signing', 'locked'].includes(s);
  const locked = s === 'locked';

  const brandConfirmed = !!doc?.confirmations?.brand?.confirmed;
  const influencerConfirmed = !!doc?.confirmations?.influencer?.confirmed;

  const both = !!(
    doc?.signatures?.brand?.signed &&
    doc?.signatures?.influencer?.signed &&
    doc?.signatures?.collabglam?.signed
  );

  const rejected = s === 'rejected' || doc?.isRejected === 1;

  const isResendChild = !!(doc?.resendIteration > 0 || doc?.resendOf);

  return {
    isDraft: s === 'draft',
    isSent: s === 'sent',
    isViewed: viewedOrBeyond,
    isNegotiation: s === 'negotiation',
    isFinalized: finalizeOrBeyond,
    isSigning: signingOrBeyond,
    isLocked: locked,
    isRejected: rejected,

    isBrandInitiate: s !== 'draft',
    isBrandConfirmed: brandConfirmed,
    isInfluencerConfirm: influencerConfirmed,
    isBothSigned: both,

    canEditBrandFields: !locked && !both && !brandConfirmed && !influencerConfirmed && !finalizeOrBeyond,
    canEditInfluencerFields: !locked && !both && influencerConfirmed && !finalizeOrBeyond,
    canSignBrand: !locked && brandConfirmed && influencerConfirmed,
    canSignInfluencer: !locked && influencerConfirmed && brandConfirmed,

    isResendChild
  };
}

contractSchema.virtual('flags').get(function () { return computeStatusFlags(this); });

contractSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(doc, ret) {
    delete ret._id;
    const f = computeStatusFlags(doc);

    ret.statusFlags = f;

    ret.isBrandInitiate = f.isBrandInitiate;
    ret.isInfluencerconfirm = f.isInfluencerConfirm; // exact casing requested
    ret.isrejected = f.isRejected;                    // exact casing requested

    ret.isInfluencerConfirm = f.isInfluencerConfirm;
    ret.isRejected = f.isRejected;

    ret.isDraft = f.isDraft;
    ret.isSent = f.isSent;
    ret.isViewed = f.isViewed;
    ret.isNegotiation = f.isNegotiation;
    ret.isFinalized = f.isFinalized;
    ret.isSigning = f.isSigning;
    ret.isLocked = f.isLocked;
    ret.isBrandConfirmed = f.isBrandConfirmed;
    ret.isBothSigned = f.isBothSigned;
    ret.canEditBrandFields = f.canEditBrandFields;
    ret.canEditInfluencerFields = f.canEditInfluencerFields;
    ret.canSignBrand = f.canSignBrand;
    ret.canSignInfluencer = f.canSignInfluencer;

    ret.isResend = f.isResendChild;
    ret.isresend = f.isResendChild;

    return ret;
  }
});

contractSchema.statics.getSupportedCurrencies = function () {
  try { const data = require('../data/currencies.json'); return Object.keys(data || {}); } catch (e) { return []; }
};
contractSchema.statics.getCurrenciesMeta = function () {
  try { return require('../data/currencies.json'); } catch (e) { return {}; }
};
contractSchema.statics.isCurrencySupported = function (code) {
  if (!code) return false; const c = String(code).toUpperCase(); const data = this.getCurrenciesMeta(); return Boolean(data && data[c]);
};
contractSchema.statics.getTimezones = function () {
  try { return require('../data/timezones.json'); } catch (e) { return []; }
};
contractSchema.statics.findTimezone = function (key) {
  if (!key) return null; const list = this.getTimezones(); const q = String(key).toLowerCase();
  return list.find(t =>
    (t.value && t.value.toLowerCase() === q) ||
    (t.abbr && t.abbr.toLowerCase() === q) ||
    (Array.isArray(t.utc) && t.utc.some(u => (u || '').toLowerCase() === q)) ||
    (t.text && t.text.toLowerCase().includes(q))
  ) || null;
};
contractSchema.statics.isTimezoneSupported = function (key) { return Boolean(this.findTimezone(key)); };

const Contract = mongoose.model('Contract', contractSchema);
Contract.STATUS = STATUS;
module.exports = Contract;
module.exports.STATUS = STATUS;