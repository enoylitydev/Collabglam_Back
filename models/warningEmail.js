// models/warningEmail.js
const mongoose = require("mongoose");

const { Schema } = mongoose;

const warningEmailSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["brand", "influencer"],
      required: true,
      index: true,
    },
    brandId: {
      type: String,
      index: true,
    },
    brand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Brand',
      index: true,
    },
    influencerId: {
      type: String,
      index: true,
    },
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      index: true,
    },
    subject: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    originalSubject: {
      type: String,
    },
    originalBody: {
      type: String,
    },
    reasonForBlocking: {
      type: String,
    },
    recipientEmail: {
      type: String,
      lowercase: true,
      required: true,
    },
    fromProxyEmail: {
      type: String,
      lowercase: true,
    },
    toProxyEmail: {
      type: String,
      lowercase: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
warningEmailSchema.index({ role: 1, brandId: 1 });
warningEmailSchema.index({ role: 1, influencerId: 1 });
warningEmailSchema.index({ createdAt: -1 });

const WarningEmail = mongoose.model("WarningEmail", warningEmailSchema);

module.exports = WarningEmail;

