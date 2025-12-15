// models/email.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

// ---------------- Helper: slugify name ----------------
function slugifyName(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .substring(0, 20) || 'user'
  );
}

const emailThreadSchema = new mongoose.Schema({
  brand: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', index: true },
  influencer: { type: mongoose.Schema.Types.ObjectId, ref: 'Influencer', index: true },

  // NEW: conversation-level info
  subject: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  lastMessageAt: { type: Date, index: true },
  lastMessageDirection: {
    type: String,
    enum: ['brand_to_influencer', 'influencer_to_brand', null],
    default: null,
  },
  lastMessageSnippet: { type: String },

  // Proxy emails in use for this pair
  brandAliasEmail: { type: String, lowercase: true, index: true },
  influencerAliasEmail: { type: String, lowercase: true, index: true },

  // What we display as "From" in UI
  brandDisplayAlias: { type: String },
  influencerDisplayAlias: { type: String },

  // Snapshots for UI
  brandSnapshot: {
    name: String,
    email: String,
  },
  influencerSnapshot: {
    name: String,
    email: String,
  },

  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
  },

  createdBy: { type: String }, // 'brand' | 'influencer' | 'system'
}, { timestamps: true });

// Only one thread per brand + influencer pair
emailThreadSchema.index({ brand: 1, influencer: 1 }, { unique: true });

emailThreadSchema.statics.generateAliasEmail = function (displayName) {
  const slug = slugifyName(displayName); // e.g. "Adidas Originals" -> "adidasoriginals"
  const domain = process.env.EMAIL_RELAY_DOMAIN || 'mail.collabglam.com';
  return `${slug}@${domain}`;
};

// alias & display are identical
emailThreadSchema.statics.generatePrettyAlias =
  emailThreadSchema.statics.generateAliasEmail;

// models/email.js (excerpt)
const emailMessageSchema = new mongoose.Schema({
  thread: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EmailThread',
    required: true,
    index: true,
  },

  direction: {
    type: String,
    enum: ['brand_to_influencer', 'influencer_to_brand', 'system'],
    required: true,
  },

  fromUser: { type: mongoose.Schema.Types.ObjectId, refPath: 'fromUserModel' },
  fromUserModel: { type: String, enum: ['Brand', 'Influencer', 'System'] },

  // Existing field (keep)
  fromAliasEmail: { type: String }, // proxy used in From:
  toRealEmail: { type: String },

  // NEW: explicit proxy/real addressing
  fromProxyEmail: { type: String, lowercase: true, index: true },
  toProxyEmail: { type: String, lowercase: true, index: true },
  fromRealEmail: { type: String, lowercase: true, index: true },

  subject: String,
  htmlBody: String,
  textBody: String,

  // Email threading fields
  messageId: { type: String, index: true },   // Message-ID header
  inReplyTo: { type: String, index: true },   // In-Reply-To header
  references: [String],

  // Timestamps from the email’s perspective
  sentAt: { type: Date },
  receivedAt: { type: Date },

  // Attachments metadata (you already have something similar)
  attachments: [{
    filename: String,
    contentType: String,
    size: Number,
    storageKey: String,
    url: String,
  }],
}, { timestamps: true });

// ---------------- Email Template Schema ----------------
// Predefined templates that you load on frontend and edit.
const emailTemplateSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true, // e.g. "brand_invitation_default"
    },
    name: {
      type: String,
      required: true, // human readable
    },
    role: {
      type: String,
      enum: ['Brand', 'Influencer', 'Both'],
      default: 'Both',
    },
    type: {
      type: String,
      default: 'generic', // e.g. 'invitation', 'followup'
    },

    subject: { type: String, required: true },
    htmlBody: { type: String, required: true },
    textBody: { type: String }, // optional plain-text version

    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const EmailThread = mongoose.model('EmailThread', emailThreadSchema);
const EmailMessage = mongoose.model('EmailMessage', emailMessageSchema);
const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

module.exports = {
  EmailThread,
  EmailMessage,
  EmailTemplate,
};
