// models/delieverable.js
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const milestone = require("./milestone");

const deliverableUrlSchema = new mongoose.Schema(
  {
    label: { type: String, default: "" },
    url: { type: String, required: true },
  },
  { _id: false }
);

const delieverableSchema = new mongoose.Schema({
  delieverableApprovalId: {
    type: String,
    default: uuidv4,
    unique: true,
    index: true,
  },

  brandId: { type: String, required: true, ref: "Brand" },
  influencerId: { type: String, required: true, ref: "Influencer" },
  campaignId: { type: String, required: true, ref: "Campaign" },
  milestoneId: { type: String, required: true, ref: "Milestone" },
  title: { type: String, required: true },
  description: { type: String, default: "" },

  status: {
    type: String,
    enum: ["pending", "revision", "approved"],
    default: "pending",
  },

  approvedRole: {
    type: String
   
  },

  approvalId: { type: String, default: "" }, // optional tracking id
  comments: { type: String, default: "" },

  url: { type: [deliverableUrlSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedDate: { type: Date, default: Date.now },
});

delieverableSchema.pre("save", function (next) {
  this.updatedDate = new Date();
  next();
});

delieverableSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedDate: new Date() });
  next();
});

module.exports =
  mongoose.models.delieverable ||
  mongoose.model("delieverable", delieverableSchema);