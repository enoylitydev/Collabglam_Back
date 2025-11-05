// controllers/mediakitController.js
const Influencer = require('../models/influencer');
const MediaKit = require('../models/mediaKit');

/* ------------------------------- Helpers -------------------------------- */

function buildSnapshotFromInfluencer(infDoc) {
  const src = infDoc.toObject({ getters: false, virtuals: false, depopulate: true });

  const EXCLUDE = new Set(['_id', '__v', 'mediaKitId', 'influencerId', 'updatedAt']);
  const MEDIAKIT_ONLY = new Set(['rateCard', 'additionalNotes', 'mediaKitPdf', 'website']);

  const snapshot = {};
  for (const path of Object.keys(MediaKit.schema.paths)) {
    if (EXCLUDE.has(path) || MEDIAKIT_ONLY.has(path)) continue;

    if (path === 'createdAt') {
      if (src.createdAt) snapshot.createdAt = src.createdAt;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(src, path)) {
      snapshot[path] = src[path];
    }
  }
  return snapshot;
}

function pickUsername(primaryPlatform, profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  if (primaryPlatform) {
    const match = profiles.find(p => p.provider === primaryPlatform);
    if (match?.username) return match.username;
  }
  return profiles.find(p => p?.username)?.username ?? null;
}

function sanitizeMediaKit(docOrObj) {
  const obj = docOrObj?.toObject ? docOrObj.toObject() : { ...docOrObj };
  // redact sensitive snapshot fields from responses
  delete obj.password;
  return obj;
}

/* ------------------------------- Controllers ---------------------------- */

// POST /api/mediakits/by-influencer
// Body: { influencerId }
// If mediakit exists -> return it (no error).
// If not -> create from influencer snapshot and return it.
async function createByInfluencer(req, res) {
  try {
    const { influencerId } = req.body || {};
    if (!influencerId) {
      return res.status(400).json({ error: 'influencerId is required in body' });
    }

    const influencer = await Influencer.findOne({ influencerId });
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    // If a MediaKit already exists for this influencer, just "open" (return) it.
    const existing = await MediaKit.findOne({ influencerId });
    if (existing) {
      return res.status(200).json({
        mediaKitId: existing.mediaKitId,
        mediaKit: sanitizeMediaKit(existing)
      });
    }

    // Otherwise, build a fresh snapshot from Influencer and create.
    const snapshot = buildSnapshotFromInfluencer(influencer);
    const mediaKit = await MediaKit.create({
      influencerId,
      ...snapshot
    });

    return res.status(201).json({
      mediaKitId: mediaKit.mediaKitId,
      mediaKit: sanitizeMediaKit(mediaKit)
    });
  } catch (err) {
    console.error('Create MediaKit error:', err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Duplicate key', details: err.keyValue });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/mediakits/update
// Body: { mediaKitId, ...fieldsToUpdate } — fully flexible update
async function updateMediaKit(req, res) {
  try {
    const { mediaKitId, ...rest } = req.body || {};
    if (!mediaKitId) {
      return res.status(400).json({ error: 'mediaKitId is required in body' });
    }

    const updated = await MediaKit.findOneAndUpdate(
      { mediaKitId },
      { $set: rest },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ error: 'MediaKit not found' });

    return res.json({
      message: 'MediaKit updated successfully',
      mediaKitId: updated.mediaKitId,
      mediaKit: sanitizeMediaKit(updated)
    });
  } catch (err) {
    console.error('Update MediaKit error:', err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'Duplicate key', details: err.keyValue });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/mediakits
// Returns only: name, email, primaryPlatform, username
async function getAllMediaKits(_req, res) {
  try {
    const docs = await MediaKit.find(
      {},
      { name: 1, email: 1, primaryPlatform: 1, socialProfiles: 1, _id: 0 }
    ).lean();

    const items = (docs || []).map(d => ({
      name: d.name ?? null,
      email: d.email ?? null,
      primaryPlatform: d.primaryPlatform ?? null,
      username: pickUsername(d.primaryPlatform, d.socialProfiles)
    }));

    return res.json(items);
  } catch (err) {
    console.error('Get all MediaKits error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createByInfluencer,
  updateMediaKit,
  getAllMediaKits
};
