const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const contractSchema = new mongoose.Schema({
  contractId:     { type: String, required: true, unique: true, default: uuidv4 },
  brandId:        { type: String, required: true, ref: 'Brand' },
  influencerId:   { type: String, required: true, ref: 'Influencer' },
  campaignId:     { type: String, required: true, ref: 'Campaign' },

  brandName:           { type: String, required: true },
  brandAddress:        { type: String, required: true },
  influencerName:      { type: String, required: true },
  influencerAddress:   { type: String, required: true },
  influencerHandle:    { type: String, required: true },

  effectiveDate:           { type: String, required: true },
  deliverableDescription:  { type: String, required: true },
  feeAmount:               { type: String, required: true },

  timeline: {
    startDate: { type: Date },
    endDate:   { type: Date }
  },

  // 0 = PDF only, 1 = save
  type:        { type: Number, required: true },

  // states
  isAssigned:  { type: Number, default: 0 }, // brand sent
  isAccepted:  { type: Number, default: 0 }, // influencer accepted
  isRejected:  { type: Number, default: 0 }, // influencer rejected

  rejectedReason: { type: String, default: '' },
  rejectedAt:     { type: Date },

  resendCount: { type: Number, default: 0 },
  lastSentAt:  { type: Date, default: Date.now },

  createdAt:   { type: Date, default: Date.now }
});

// Safety: if accepted -> clear rejection flags automatically
contractSchema.pre('save', function(next) {
  if (this.isAccepted === 1) {
    this.isRejected     = 0;
    this.rejectedReason = '';
    this.rejectedAt     = undefined;
  }
  next();
});

module.exports = mongoose.model('Contract', contractSchema);