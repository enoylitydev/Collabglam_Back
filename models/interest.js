// models/interest.js
const mongoose = require('mongoose');

const interestSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
  },
  {
    timestamps: true,
    id: false,
    versionKey: false,
  }
);

module.exports = mongoose.model('Interest', interestSchema);
