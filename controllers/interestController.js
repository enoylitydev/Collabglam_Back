// controllers/interestController.js

const Interest = require('../models/categories');

/**
 * GET /interests
 *  → Returns an array of all interest documents: [{ _id, name }, …]
 */
exports.getAllInterests = async (req, res) => {
  try {
    const interests = await Interest.find({})
      .sort({ name: 1 })      // sort alphabetically by name
      .select('_id name');    // return only _id and name
    return res.status(200).json(interests);
  } catch (error) {
    console.error('Error in getAllInterests:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error while fetching interests.' });
  }
};

/**
 * POST /interests
 *  Body: { name: "NEW_INTEREST_NAME" }
 *  → Creates a single new interest (if it doesn’t already exist).
 */
exports.createInterest = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res
        .status(400)
        .json({ message: 'Interest name is required and must be a non-empty string.' });
    }

    const trimmedName = name.trim();

    // 1) If an interest with this name already exists (case-insensitive), reject.
    const existing = await Interest.findOne({ name: new RegExp(`^${trimmedName}$`, 'i') });
    if (existing) {
      return res.status(400).json({ message: 'This interest already exists.' });
    }

    // 2) Create & save
    const newInterest = new Interest({ name: trimmedName });
    await newInterest.save();

    return res
      .status(201)
      .json({ _id: newInterest._id, name: newInterest.name });
  } catch (error) {
    console.error('Error in createInterest:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error while creating interest.' });
  }
};
