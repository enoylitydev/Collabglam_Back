// models/email.js
const mongoose = require('mongoose');
const crypto = require('crypto');

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

// ---------------- Email Thread Schema ----------------
// One thread per Brand + Influencer pair. Stores alias emails.
const emailThreadSchema = new Schema(
  {
    brand: {
      type: Schema.Types.ObjectId,
      ref: 'Brand',
      required: true,
    },
    influencer: {
      type: Schema.Types.ObjectId,
      ref: 'Influencer',
      required: true,
    },

    brandSnapshot: {
      name: { type: String, required: true },
      email: { type: String, required: true },
    },
    influencerSnapshot: {
      name: { type: String, required: true },
      email: { type: String, required: true },
    },

    /**
     * TECHNICAL RELAY ADDRESS (UNIQUE PER THREAD)
     * Example: b-adidas-a1b2c3@collabglam.com
     * Used as Reply-To and inbound routing for both sides.
     */
    brandAliasEmail: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    /**
     * GLOBAL INFLUENCER ALIAS (SAME FOR EVERYONE)
     * Example: influencer@collabglam.com
     * Not unique, only used as visible "from" for influencers.
     */
    influencerAliasEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      // NOTE: intentionally NOT unique
    },

    /**
     * Optional prettier aliases to show in UI
     * brandDisplayAlias: adidas@collabglam.com
     * influencerDisplayAlias: influencer@collabglam.com
     */
    brandDisplayAlias: { type: String, trim: true },
    influencerDisplayAlias: { type: String, trim: true },

    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
    },

    createdBy: {
      type: String,
      enum: ['brand', 'influencer', 'system'],
      default: 'system',
    },
  },
  { timestamps: true }
);

// Only one thread per brand + influencer pair
emailThreadSchema.index({ brand: 1, influencer: 1 }, { unique: true });

// Static helper on schema to generate alias emails
emailThreadSchema.statics.generateAliasEmail = function (displayName, prefix) {
  const slug = slugifyName(displayName);
  const rand = crypto.randomBytes(3).toString('hex'); // 6 chars
  const localPart = `${prefix}-${slug}-${rand}`; // e.g. b-adidas-a1b2c3
  const domain = process.env.EMAIL_RELAY_DOMAIN;
  return `${localPart}@${domain}`;
};

emailThreadSchema.statics.generatePrettyAlias = function (displayName) {
  const slug = slugifyName(displayName);
  const domain = process.env.EMAIL_RELAY_DOMAIN;
  return `${slug}@${domain}`;
};

// ---------------- Email Message Schema ----------------
// One document per sent email (brand->influencer or influencer->brand)
const emailMessageSchema = new Schema(
  {
    thread: {
      type: Schema.Types.ObjectId,
      ref: 'EmailThread',
      required: true,
    },
    direction: {
      type: String,
      enum: ['brand_to_influencer', 'influencer_to_brand'],
      required: true,
    },
    fromUser: {
      type: Schema.Types.ObjectId,
      refPath: 'fromUserModel',
      required: true,
    },
    fromUserModel: {
      type: String,
      enum: ['Brand', 'Influencer'],
      required: true,
    },

    // The alias used in the outbound email (pretty brand alias or influencer@...)
    fromAliasEmail: { type: String, required: true },

    // The real destination address (brand or influencer Gmail)
    toRealEmail: { type: String, required: true },

    subject: { type: String, required: true },
    htmlBody: { type: String },
    textBody: { type: String },

    template: {
      type: Schema.Types.ObjectId,
      ref: 'EmailTemplate',
      default: null,
    },
  },
  { timestamps: true }
);

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
