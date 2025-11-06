const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const attachmentSchema = new mongoose.Schema({
  url: { type: String, required: true },
  originalName: { type: String },
  mimeType: { type: String },
  size: { type: Number }
}, { _id: false });

const commentSchema = new mongoose.Schema({
  commentId: { type: String, required: true, default: uuidv4 },
  authorRole: { type: String, enum: ['Admin', 'Brand', 'Influencer'], required: true },
  authorId: { type: String, required: true },
  text: { type: String, required: true },
  attachments: { type: [attachmentSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const disputeSchema = new mongoose.Schema({
  disputeId: { type: String, required: true, unique: true, default: uuidv4 },

  // linkage
  campaignId: { type: String, required: false, default: null, ref: 'Campaign' },
  brandId: { type: String, required: true, ref: 'Brand' },
  influencerId: { type: String, required: true, ref: 'Influencer' },

  createdBy: {
    id: { type: String, required: true },
    role: { type: String, enum: ['Brand', 'Influencer'], required: true }
  },

  subject: { type: String, required: true },
  description: { type: String, default: '' },

  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },

  related: {
    type: {
      type: String,
      enum: ['contract', 'milestone', 'payment', 'other'],
      default: 'other'
    },
    id: { type: String, default: null }
  },

  status: {
    type: String,
    enum: ['open', 'in_review', 'awaiting_user', 'resolved', 'rejected'],
    default: 'open'
  },

  assignedTo: {
    adminId: { type: String, default: null },
    name: { type: String, default: null }
  },

  comments: { type: [commentSchema], default: [] }
}, { timestamps: true });

disputeSchema.index({ brandId: 1, createdAt: -1 });
disputeSchema.index({ influencerId: 1, createdAt: -1 });
disputeSchema.index({ campaignId: 1, createdAt: -1 });
disputeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Dispute', disputeSchema);
