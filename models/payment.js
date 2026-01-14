const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
  },
  paymentId: {
    type: String,
  },
  signature: {
    type: String,
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    required: true,
    default: "USD",
  },
  receipt: {
    type: String,
  },

  userId: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    required: true,
    enum: ["Brand", "Influencer"],
  },

  planId: {
    type: String,
    required: true,
  },
  planName: {
    type: String,
    default: "",
  },

  status: {
    type: String,
    enum: ["created", "paid", "failed"],
    default: "created",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  paidAt: {
    type: Date,
  },

  invoiceNumber: { type: String },
  invoiceFilePath: { type: String },
  invoiceEmailTo: { type: String },
  invoiceEmailSentAt: { type: Date },
});

module.exports = mongoose.model("Payment", paymentSchema);
