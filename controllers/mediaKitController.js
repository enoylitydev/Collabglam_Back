/* ────────────────────────────────────────────────────────────
   models
────────────────────────────────────────────────────────────── */
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const MediaKit   = require('../models/mediaKit');
const Influencer = require('../models/influencer');
const Country    = require('../models/country');
const Audience   = require('../models/audienceRange');

/* ────────────────────────────────────────────────────────────
   util: async error wrapper
────────────────────────────────────────────────────────────── */
const catchAsync = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/* ────────────────────────────────────────────────────────────
   util: duplicate-ID detector
────────────────────────────────────────────────────────────── */
function checkDuplicateIds(arr, keyName, errMsg) {
  if (!Array.isArray(arr)) return;              // nothing to check
  const seen = new Set();
  for (const item of arr) {
    const id = item?.[keyName];
    if (id == null) continue;                   // allow empty objects
    if (seen.has(id)) {
      const error = new Error(errMsg);
      error.statusCode = 400;
      throw error;
    }
    seen.add(id);
  }
}

/* ────────────────────────────────────────────────────────────
   POST /api/media-kit/influencer
────────────────────────────────────────────────────────────── */
exports.getInfluencerDetails = catchAsync(async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  /* 1️⃣  Find influencer (mask subscription & paymentMethods) */
  const influencer = await Influencer.findOne(
    { influencerId },
    { subscription: 0, paymentMethods: 0 }
  ).lean();

  if (!influencer) {
    return res.status(404).json({ message: 'Influencer not found' });
  }

  /* 2️⃣  Fetch or seed the MediaKit */
  let kit = await MediaKit.findOne({ influencerId }).lean();

  if (!kit) {
    kit = await MediaKit.create({
      influencerId,
      name               : influencer.name            || '',
      profileImage       : influencer.profileImage    || '',
      bio                : influencer.bio             || '',
      platformName       : influencer.platformName    || '',
      categories         : influencer.categoryName    || [],
      audienceBifurcation: influencer.audienceBifurcation || {
        malePercentage   : 0,
        femalePercentage : 0
      }
      /* all other MediaKit fields start empty */
    });
    kit = kit.toObject();         // convert to plain object for consistency
  }

  /* 3️⃣  Return the MediaKit (contains latest stored data) */
  res.json(kit);
});

/* ────────────────────────────────────────────────────────────
   POST /api/media-kit/list
────────────────────────────────────────────────────────────── */
exports.getAllMediaKits = catchAsync(async (_req, res) => {
  const kits = await MediaKit.find({}).lean();
  res.json(kits);
});

/* ────────────────────────────────────────────────────────────
   POST /api/media-kit/get
────────────────────────────────────────────────────────────── */
exports.getMediaKitById = catchAsync(async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId)
    return res.status(400).json({ message: 'influencerId is required' });

  const kit = await MediaKit.findOne({ influencerId }).lean();
  if (!kit)
    return res.status(404).json({ message: 'MediaKit not found' });

  res.json(kit);
});

/* ────────────────────────────────────────────────────────────
   helpers: enrich arrays with missing names / ranges
────────────────────────────────────────────────────────────── */
async function enrichTopCountries(list = []) {
  const items = list.filter(Boolean);

  return Promise.all(
    items.map(async ({ countryId, name, percentage }) => {
      if (name) return { countryId, name, percentage };

      const doc = await Country.findById(countryId).lean();
      if (!doc) throw new Error(`Country not found for ID: ${countryId}`);
      return { countryId, name: doc.countryName, percentage };
    })
  );
}

/* ─────────────────────────────────────────────────────────────
   Helper: enrich each { audienceRangeId, percentage } ➜ +range
   • audienceRangeId in your payload is the *uuid* field
──────────────────────────────────────────────────────────────── */
async function enrichAgeBreakdown(list = []) {
  const items = list.filter(Boolean);

  return Promise.all(
    items.map(async ({ audienceRangeId, range, percentage }) => {
      /* Already complete → return as-is */
      if (range && mongoose.isValidObjectId(audienceRangeId)) {
        return { audienceRangeId, range, percentage };
      }

      let doc = null;

      /* 1️⃣  If it's a valid ObjectId, fetch by _id */
      if (mongoose.isValidObjectId(audienceRangeId)) {
        doc = await Audience.findById(audienceRangeId).lean();
      }

      /* 2️⃣  Otherwise treat it as a UUID stored in audienceId */
      if (!doc) {
        doc = await Audience.findOne({ audienceId: audienceRangeId }).lean();
      }

      if (!doc) {
        throw new Error(`Audience range not found for ID: ${audienceRangeId}`);
      }

      return {
        audienceRangeId: doc._id,   // convert to real ObjectId for schema
        range          : doc.range,
        percentage
      };
    })
  );
}
/* ────────────────────────────────────────────────────────────
   POST /api/media-kit/create
────────────────────────────────────────────────────────────── */
exports.createMediaKit = catchAsync(async (req, res) => {
  const { influencerId, topCountries = [], ageBreakdown = [] } = req.body;
  if (!influencerId)
    return res.status(400).json({ message: 'influencerId is required' });

  /* verify influencer */
  const influencer = await Influencer.findOne({ influencerId });
  if (!influencer)
    return res.status(404).json({ message: 'Influencer not found' });

  /* no duplicates allowed */
  checkDuplicateIds(topCountries, 'countryId',      'Duplicate countryId detected');
  checkDuplicateIds(ageBreakdown, 'audienceRangeId','Duplicate audienceRangeId detected');

  /* no second kit */
  if (await MediaKit.exists({ influencerId }))
    return res.status(409).json({ message: 'MediaKit already exists' });

  /* enrich + compose */
  const kitData = {
    ...req.body,
    influencerId,
    name         : req.body.name         ?? influencer.name,
    profileImage : req.body.profileImage ?? influencer.profileImage,
    bio          : req.body.bio          ?? influencer.bio,
    platformName : req.body.platformName ?? influencer.platformName,
    topCountries : await enrichTopCountries(topCountries),
    ageBreakdown : await enrichAgeBreakdown(ageBreakdown),
  };

  const kit = await MediaKit.create(kitData);
  res.status(201).json(kit);
});

/* ────────────────────────────────────────────────────────────
   POST /api/media-kit/update
────────────────────────────────────────────────────────────── */


exports.updateMediaKit = catchAsync(async (req, res) => {
  const { influencerId, topCountries, ageBreakdown, ...update } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  /* duplicate checks */
  if (topCountries) checkDuplicateIds(topCountries, 'countryId', 'Duplicate countryId detected');
  if (ageBreakdown) checkDuplicateIds(ageBreakdown, 'audienceRangeId', 'Duplicate audienceRangeId detected');

  /* enrich arrays if supplied */
  if (topCountries)  update.topCountries  = await enrichTopCountries(topCountries);
  if (ageBreakdown)  update.ageBreakdown  = await enrichAgeBreakdown(ageBreakdown);

  /* ensure default fields on an upsert */
  let kit = await MediaKit.findOne({ influencerId });
  if (!kit) {
    const influencer = await Influencer.findOne({ influencerId });
    if (!influencer) return res.status(404).json({ message: 'Influencer not found' });

    update.name         ??= influencer.name;
    update.profileImage ??= influencer.profileImage;
    update.bio          ??= influencer.bio;
    update.platformName ??= influencer.platformName;
  }

  kit = await MediaKit.findOneAndUpdate(
    { influencerId },
    update,
    { new: true, upsert: true, runValidators: true }
  );

  res.json(kit);
});
