const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const POLICY_KEYS = [
  'acceptable_use_and_communication_policy',
  'privacy_policy',
  'terms_of_service',
  'cookie_policy',
  'shipping_delivery_policy',
  'returns_refund_policy',
  'data_processing_addendum',
  'subprocessor_list'
];

const policySchema = new mongoose.Schema(
  {
    policyId: {
      type: String,
      default: uuidv4,
      unique: true
    },
    policyKey: {
      type: String,
      enum: POLICY_KEYS,
      required: true,
      unique: true
    },
    title: {
      type: String,
      required: true
    },
    fileName: {
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
    content: {
      type: String,
      required: true
    },
    isPublished: {
      type: Boolean,
      default: true
    }
  },
  { timestamps: true }
);

const Policy = mongoose.models.Policy || mongoose.model('Policy', policySchema);

module.exports = { Policy, POLICY_KEYS };