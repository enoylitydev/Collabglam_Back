// controllers/campaignController.js
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const multer = require('multer');

const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Category = require('../models/categories'); // categories collection with subcategories[]
const ApplyCampaign = require('../models/applyCampaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const SubscriptionPlan = require('../models/subscription');
const getFeature = require('../utils/getFeature');
const Milestone = require('../models/milestone');
const Country = require('../models/country');

// ===============================
//  Multer setup
// ===============================
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    cb(null, `${baseName}_${timestamp}${ext}`);
  }
});

async function buildSubToParentNumMap() {
  const rows = await Category.find({}, 'id subcategories').lean();
  const subIdToParentNum = new Map(); // uuid -> Number

  for (const r of rows) {
    for (const s of (r.subcategories || [])) {
      subIdToParentNum.set(String(s.subcategoryId), r.id);
    }
  }
  return subIdToParentNum;
}

function buildSearchOr(q) {
  return [
    { brandName: { $regex: q, $options: 'i' } },
    { productOrServiceName: { $regex: q, $options: 'i' } },
    { description: { $regex: q, $options: 'i' } },
    { 'categories.categoryName': { $regex: q, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: q, $options: 'i' } }
  ];
}


// Basic search fields (fallback if you already have a builder, keep yours)
function buildSearchOr(q) {
  return [
    { brandName: { $regex: q, $options: 'i' } },
    { productOrServiceName: { $regex: q, $options: 'i' } },
    { description: { $regex: q, $options: 'i' } },
    { 'categories.categoryName': { $regex: q, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: q, $options: 'i' } }
  ];
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB per file
}).fields([
  { name: 'image', maxCount: 10 },
  { name: 'creativeBrief', maxCount: 10 }
]);

// ===============================
//  Helpers
// ===============================
function computeIsActive(timeline) {
  if (!timeline || !timeline.endDate) return 1;
  const now = new Date();
  return timeline.endDate < now ? 0 : 1;
}

const toStr = (v) => (v == null ? '' : String(v));

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    {
      'milestoneHistory.influencerId': influencerId,
      'milestoneHistory.campaignId': { $in: campaignIds }
    },
    'milestoneHistory.campaignId milestoneHistory.influencerId'
  ).lean();

  const set = new Set();
  docs.forEach((d) => {
    d.milestoneHistory.forEach((e) => {
      if (toStr(e.influencerId) === toStr(influencerId) && campaignIds.includes(toStr(e.campaignId))) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

/**
 * Expand & validate categories payload into:
 * [{ categoryId(ObjectId), categoryName, subcategoryId(string), subcategoryName }]
 */
async function normalizeCategoriesPayload(raw) {
  if (!raw) return [];

  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { throw new Error('Invalid JSON in categories.'); }
  }
  if (!Array.isArray(items)) throw new Error('categories must be an array.');

  // collect unique numeric category ids from payload
  const catNums = [...new Set(
    items.map(it => Number(it?.categoryId)).filter(n => Number.isFinite(n))
  )];
  if (!catNums.length) throw new Error('categories must contain numeric categoryId.');

  // fetch categories by numeric id (NOT _id)
  const cats = await Category.find({ id: { $in: catNums } }, 'id name subcategories').lean();
  const byNum = new Map(cats.map(c => [c.id, c]));

  const out = [];
  for (const it of items) {
    const catNum = Number(it?.categoryId);
    const subId = String(it?.subcategoryId || '');

    if (!Number.isFinite(catNum)) throw new Error(`Invalid categoryId: ${it?.categoryId}`);
    if (!subId) throw new Error('subcategoryId is required');

    const catDoc = byNum.get(catNum);
    if (!catDoc) throw new Error(`Category not found (id: ${catNum})`);

    const sub = (catDoc.subcategories || []).find(s => String(s.subcategoryId) === subId);
    if (!sub) throw new Error(`Subcategory ${subId} not under category id ${catNum}`);

    out.push({
      categoryId: catDoc.id,        // ✅ numeric
      categoryName: catDoc.name,
      subcategoryId: sub.subcategoryId,
      subcategoryName: sub.name
    });
  }
  return out;
}

/**
 * Try to extract influencer-selected subcategoryIds from multiple shapes.
 * Returns Set<string> of subcategoryId.
 */
function extractSubcategoryIdsFromInfluencerDoc(inf) {
  const out = new Set();

  // Common shapes we might see:
  // 1) inf.subcategories: [{ subcategoryId, name, ... }]
  if (Array.isArray(inf?.subcategories)) {
    inf.subcategories.forEach((s) => {
      if (s?.subcategoryId) out.add(String(s.subcategoryId));
    });
  }

  // 2) inf.categories: could be array of string subcategoryIds or objects
  if (Array.isArray(inf?.categories)) {
    inf.categories.forEach((c) => {
      if (typeof c === 'string') out.add(c);
      else if (c?.subcategoryId) out.add(String(c.subcategoryId));
    });
  }

  // 3) inf.socialProfiles?.categories: [{ subcategoryId, ... }]
  if (Array.isArray(inf?.socialProfiles)) {
    inf.socialProfiles.forEach((sp) => {
      if (Array.isArray(sp?.categories)) {
        sp.categories.forEach((c) => {
          if (c?.subcategoryId) out.add(String(c.subcategoryId));
        });
      }
    });
  }

  // 4) inf.onboarding?.categories or .subcategories
  if (inf?.onboarding) {
    if (Array.isArray(inf.onboarding.categories)) {
      inf.onboarding.categories.forEach((c) => {
        if (typeof c === 'string') out.add(c);
        else if (c?.subcategoryId) out.add(String(c.subcategoryId));
      });
    }
    if (Array.isArray(inf.onboarding.subcategories)) {
      inf.onboarding.subcategories.forEach((s) => {
        if (s?.subcategoryId) out.add(String(s.subcategoryId));
      });
    }
  }

  return out;
}

/**
 * Build case-insensitive $or for text search across brand name, product, subcategory/category names.
 */
function buildSearchOr(term) {
  const or = [
    { brandName: { $regex: term, $options: 'i' } },
    { productOrServiceName: { $regex: term, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: term, $options: 'i' } },
    { 'categories.categoryName': { $regex: term, $options: 'i' } }
  ];
  const num = Number(term);
  if (!isNaN(num)) or.push({ budget: { $lte: num } });
  return or;
}

// ===============================
//  CREATE CAMPAIGN  (uses categories)
// ===============================
exports.createCampaign = (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer Error:', err);
      return res.status(400).json({ message: err.message });
    }
    if (err) {
      console.error('Upload Error:', err);
      return res.status(500).json({ message: 'Error uploading files.' });
    }

    try {
      let {
        brandId,
        productOrServiceName,
        description = '',
        targetAudience,
        categories, // [{categoryId, subcategoryId}]
        goal,
        creativeBriefText,
        budget = 0,
        timeline,
        additionalNotes = ''
      } = req.body;

      if (!brandId) return res.status(400).json({ message: 'brandId is required.' });
      if (!productOrServiceName || !goal) {
        return res.status(400).json({ message: 'productOrServiceName and goal are required.' });
      }

      // Brand & plan
      const brand = await Brand.findOne({ brandId });
      if (!brand) return res.status(404).json({ message: 'Brand not found.' });

      const plan = await SubscriptionPlan.findOne({ planId: brand.subscription.planId }).lean();
      if (!plan) return res.status(500).json({ message: 'Subscription plan not found.' });

      const liveCap = getFeature.getFeature(brand.subscription, 'live_campaigns_limit');
      const limit = liveCap ? liveCap.limit : 0;
      const used = liveCap ? liveCap.used : 0;
      if (limit > 0 && used >= limit) {
        return res.status(403).json({
          message: `You have reached this cycle’s campaign quota ${limit}. `
        });
      }

      // targetAudience
      let audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
      if (targetAudience) {
        let ta = targetAudience;
        if (typeof ta === 'string') {
          try {
            ta = JSON.parse(ta);
          } catch {
            return res.status(400).json({ message: 'Invalid JSON in targetAudience.' });
          }
        }
        const { age, gender, locations } = ta;
        if (age?.MinAge != null) audienceData.age.MinAge = Number(age.MinAge) || 0;
        if (age?.MaxAge != null) audienceData.age.MaxAge = Number(age.MaxAge) || 0;
        if ([0, 1, 2].includes(gender)) audienceData.gender = gender;

        if (Array.isArray(locations)) {
          for (const countryId of locations) {
            if (!mongoose.Types.ObjectId.isValid(countryId)) {
              return res.status(400).json({ message: `Invalid countryId: ${countryId}` });
            }
            const country = await Country.findById(countryId);
            if (!country) {
              return res.status(404).json({ message: `Country not found: ${countryId}` });
            }
            audienceData.locations.push({
              countryId: country._id,
              countryName: country.countryName
            });
          }
        }
      }

      // categories
      let categoriesData = [];
      try {
        categoriesData = await normalizeCategoriesPayload(categories);
      } catch (e) {
        return res.status(400).json({ message: e.message || 'Invalid categories payload.' });
      }

      // timeline
      let tlData = {};
      if (timeline) {
        let tl = timeline;
        if (typeof tl === 'string') {
          try {
            tl = JSON.parse(tl);
          } catch {
            return res.status(400).json({ message: 'Invalid JSON in timeline.' });
          }
        }
        if (tl.startDate) {
          const sd = new Date(tl.startDate);
          if (!isNaN(sd)) tlData.startDate = sd;
        }
        if (tl.endDate) {
          const ed = new Date(tl.endDate);
          if (!isNaN(ed)) tlData.endDate = ed;
        }
      }

      const isActiveFlag = computeIsActive(tlData);

      // files
      const images = (req.files.image || []).map((f) => path.join('uploads', path.basename(f.path)));
      const creativePDFs = (req.files.creativeBrief || []).map((f) =>
        path.join('uploads', path.basename(f.path))
      );

      // save
      const newCampaign = new Campaign({
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        categories: categoriesData,
        goal,
        creativeBriefText,
        budget,
        timeline: tlData,
        images,
        creativeBrief: creativePDFs,
        additionalNotes,
        isActive: isActiveFlag
      });

      await newCampaign.save();

      // update usage
      if (limit > 0) {
        await Brand.updateOne(
          { brandId, 'subscription.features.key': 'live_campaigns_limit' },
          { $inc: { 'subscription.features.$.used': 1 } }
        );
      }

      return res.status(201).json({ message: 'Campaign created successfully.' });
    } catch (error) {
      console.error('Error in createCampaign:', error);
      return res.status(500).json({ message: 'Internal server error while creating campaign.' });
    }
  });
};

// ===============================
//  GET ALL CAMPAIGNS
// ===============================
exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.brandId) {
      filter.brandId = req.query.brandId;
    }
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
    return res.json(campaigns);
  } catch (error) {
    console.error('Error in getAllCampaigns:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error while fetching campaigns.' });
  }
};

// =======================================
//  GET A SINGLE CAMPAIGN BY campaignsId
// =======================================
exports.getCampaignById = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) {
      return res
        .status(400)
        .json({ message: 'Query parameter id (campaignsId) is required.' });
    }

    const campaign = await Campaign.findOne({ campaignsId }).lean();
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }
    return res.json(campaign);
  } catch (error) {
    console.error('Error in getCampaignById:', error);
    return res
      .status(500)
      .json({ message: 'Internal server error while fetching campaign.' });
  }
};

// =====================================
//  UPDATE CAMPAIGN (uses categories)
// =====================================
exports.updateCampaign = (req, res) => {
  upload(req, res, async function (err) {
    if (err instanceof multer.MulterError) {
      console.error('Multer Error:', err);
      return res.status(400).json({ message: err.message });
    } else if (err) {
      console.error('Unknown Upload Error:', err);
      return res.status(500).json({ message: 'Error uploading files.' });
    }

    try {
      const campaignsId = req.query.id;
      if (!campaignsId) {
        return res
          .status(400)
          .json({ message: 'Query parameter id (campaignsId) is required.' });
      }

      const updates = { ...req.body };

      // Protected fields
      delete updates.brandId;
      delete updates.brandName;
      delete updates.campaignsId;
      delete updates.createdAt;
      // scrub any legacy interest fields if present
      delete updates.interestId;
      delete updates.interestName;

      // targetAudience
      if (updates.targetAudience) {
        let ta = updates.targetAudience;
        if (typeof ta === 'string') {
          try {
            ta = JSON.parse(ta);
          } catch {
            return res.status(400).json({ message: 'Invalid JSON in targetAudience.' });
          }
        }

        const audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };

        if (ta.age && typeof ta.age === 'object') {
          const { MinAge, MaxAge } = ta.age;
          if (!isNaN(Number(MinAge))) audienceData.age.MinAge = Number(MinAge);
          if (!isNaN(Number(MaxAge))) audienceData.age.MaxAge = Number(MaxAge);
        }

        const g = Number(ta.gender);
        if ([0, 1, 2].includes(g)) audienceData.gender = g;

        const rawLocations = Array.isArray(ta.locations) ? ta.locations : ta.location ? [ta.location] : [];

        for (const loc of rawLocations) {
          const idCandidate = typeof loc === 'string' ? loc : loc?.countryId;
          if (!mongoose.Types.ObjectId.isValid(idCandidate)) {
            return res.status(400).json({ message: `Invalid countryId: ${idCandidate}` });
          }
          const country = await Country.findById(idCandidate).lean();
          if (!country) {
            return res.status(404).json({ message: `Country not found: ${idCandidate}` });
          }
          audienceData.locations.push({
            countryId: country._id,
            countryName: country.countryName
          });
        }

        updates.targetAudience = audienceData;
      }

      // categories
      if (updates.categories !== undefined) {
        try {
          updates.categories = await normalizeCategoriesPayload(updates.categories);
        } catch (e) {
          return res.status(400).json({ message: e.message || 'Invalid categories payload.' });
        }
      }

      // timeline
      if (updates.timeline) {
        let parsedTL = updates.timeline;
        if (typeof updates.timeline === 'string') {
          try {
            parsedTL = JSON.parse(updates.timeline);
          } catch {
            return res.status(400).json({ message: 'Invalid JSON in timeline.' });
          }
        }
        const { startDate, endDate } = parsedTL;
        const timelineData = {};
        if (startDate) {
          const sd = new Date(startDate);
          if (!isNaN(sd)) timelineData.startDate = sd;
        }
        if (endDate) {
          const ed = new Date(endDate);
          if (!isNaN(ed)) timelineData.endDate = ed;
        }
        updates.timeline = timelineData;
        updates.isActive = computeIsActive(timelineData);
      }

      // files
      if (Array.isArray(req.files['image']) && req.files['image'].length > 0) {
        updates.images = req.files['image'].map((file) => path.join('uploads', path.basename(file.path)));
      }
      if (Array.isArray(req.files['creativeBrief']) && req.files['creativeBrief'].length > 0) {
        updates.creativeBrief = req.files['creativeBrief'].map((file) =>
          path.join('uploads', path.basename(file.path))
        );
      }

      const updatedCampaign = await Campaign.findOneAndUpdate({ campaignsId }, updates, {
        new: true,
        runValidators: true
      }).lean();

      if (!updatedCampaign) {
        return res.status(404).json({ message: 'Campaign not found.' });
      }

      return res.json({
        message: 'Campaign updated successfully.',
        campaign: updatedCampaign
      });
    } catch (error) {
      console.error('Error in updateCampaign:', error);
      return res.status(500).json({ message: 'Internal server error while updating campaign.' });
    }
  });
};

// ================================
//  DELETE CAMPAIGN BY campaignsId
// ================================
exports.deleteCampaign = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) {
      return res.status(400).json({ message: 'Query parameter id (campaignsId) is required.' });
    }

    const deleted = await Campaign.findOneAndDelete({ campaignsId });
    if (!deleted) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }
    return res.json({ message: 'Campaign deleted successfully.' });
  } catch (error) {
    console.error('Error in deleteCampaign:', error);
    return res.status(500).json({ message: 'Internal server error while deleting campaign.' });
  }
};

// ===============================
//  BRAND: ACTIVE CAMPAIGNS (paginated)
// ===============================
exports.getActiveCampaignsByBrand = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    if (!brandId) {
      return res.status(400).json({ message: 'Query parameter brandId is required.' });
    }

    const filter = { brandId, isActive: 1 };

    if (search) filter.$or = buildSearchOr(search);

    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const skip = (pageNum - 1) * perPage;

    const sortDir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDir };

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).sort(sortObj).skip(skip).limit(perPage).lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({
      data: campaigns,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: perPage,
        totalPages: Math.ceil(totalCount / perPage)
      }
    });
  } catch (error) {
    console.error('Error in getActiveCampaignsByBrand:', error);
    return res.status(500).json({ message: 'Internal server error while fetching active campaigns.' });
  }
};

// ===============================
//  BRAND: PREVIOUS (INACTIVE) CAMPAIGNS (paginated)
// ===============================
exports.getPreviousCampaigns = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    if (!brandId) {
      return res.status(400).json({ message: 'Query parameter brandId is required.' });
    }

    const filter = { brandId, isActive: 0 };
    if (search) filter.$or = buildSearchOr(search);

    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const skip = (pageNum - 1) * perPage;

    const sortDir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDir };

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).sort(sortObj).skip(skip).limit(perPage).lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({
      data: campaigns,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: perPage,
        totalPages: Math.ceil(totalCount / perPage)
      }
    });
  } catch (error) {
    console.error('Error in getPreviousCampaigns:', error);
    return res.status(500).json({ message: 'Internal server error while fetching previous campaigns.' });
  }
};

// ===============================
//  ACTIVE CAMPAIGNS BY SUBCATEGORIES
//      • POST body: { subcategoryIds: string[], search?, page?, limit? }
// ===============================
exports.getActiveCampaignsByCategories = async (req, res) => {
  try {
    let { subcategoryIds, search, page = 1, limit = 10 } = req.body;

    if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) {
      return res.status(400).json({ message: 'You must provide at least one subcategoryId' });
    }
    // subcategoryIds are strings (UUIDs), validate shape lightly
    subcategoryIds = subcategoryIds.map((s) => String(s));

    const filter = {
      isActive: 1,
      'categories.subcategoryId': { $in: subcategoryIds }
    };

    if (search && typeof search === 'string' && search.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      campaigns
    });
  } catch (err) {
    console.error('Error in getActiveCampaignsByCategories:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  CHECK APPLIED FLAG
// ===============================
exports.checkApplied = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'campaignId and influencerId are required' });
  }

  try {
    const campaign = await Campaign.findOne({ campaignsId: campaignId }).lean();
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    const applied = await ApplyCampaign.exists({
      campaignId,
      'applicants.influencerId': influencerId
    });

    campaign.hasApplied = applied ? 1 : 0;
    return res.json(campaign);
  } catch (err) {
    console.error('Error in checkApplied:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: DISCOVER CAMPAIGNS (by influencer's subcategories)
//      • POST body: { influencerId, search?, page?, limit? }
// ===============================
exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // 1) Influencer
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 2) Build subcategory -> parent numeric categoryId map
    const subIdToParentNum = await buildSubToParentNumMap();

    // 3) Gather influencer selections
    const selectedSubIds = new Set(
      (inf.onboarding?.subcategories || [])
        .map(s => s?.subcategoryId)
        .filter(Boolean)
        .map(String)
    );

    // Start with explicitly selected category
    const selectedCatNumIds = new Set();
    if (typeof inf.onboarding?.categoryId === 'number') {
      selectedCatNumIds.add(inf.onboarding.categoryId);
    }

    // Also include parent categories of selected subcategories
    for (const subId of selectedSubIds) {
      const parentNum = subIdToParentNum.get(subId);
      if (typeof parentNum === 'number') selectedCatNumIds.add(parentNum);
    }

    // If nothing selected, short-circuit
    if (selectedSubIds.size === 0 && selectedCatNumIds.size === 0) {
      return res.json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    const subIdsArr = Array.from(selectedSubIds);
    const catNumArr = Array.from(selectedCatNumIds);

    // 4) Build filter using NUMERIC categoryId
    const orClauses = [];
    if (subIdsArr.length) {
      orClauses.push({ 'categories.subcategoryId': { $in: subIdsArr } });
    }
    if (catNumArr.length) {
      orClauses.push({ 'categories.categoryId': { $in: catNumArr } });
    }

    const filter = { isActive: 1, $or: orClauses };

    if (search?.trim()) {
      filter.$and = [{ $or: buildSearchOr(search.trim()) }];
    }

    // 5) Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    // 6) Query
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const totalPages = Math.ceil(total / limNum);

    // annotate minimal flags (parity with previous structure)
    const annotated = campaigns.map((c) => ({
      ...c,
      hasApplied: 0,
      hasApproved: 0,
      isContracted: 0,
      contractId: null,
      isAccepted: 0
    }));

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages },
      campaigns: annotated
    });
  } catch (err) {
    console.error('Error in getCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: APPROVED (has milestone + contract mapping)
// ===============================
exports.getApprovedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const contracts = await Contract.find(
      { influencerId, isAssigned: 1 },
      'campaignId contractId isAccepted feeAmount'
    ).lean();

    let campaignIds = contracts.map((c) => toStr(c.campaignId));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    const applyRecs = await ApplyCampaign.find(
      { campaignId: { $in: campaignIds }, 'applicants.influencerId': influencerId },
      'campaignId'
    ).lean();
    const appliedIds = new Set(applyRecs.map((r) => toStr(r.campaignId)));
    campaignIds = campaignIds.filter((id) => appliedIds.has(id));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    const milestoneIds = await milestoneSetForInfluencer(influencerId, campaignIds);
    campaignIds = campaignIds.filter((id) => milestoneIds.has(id));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    const contractIdMap = new Map();
    const feeMap = new Map();
    const acceptedMap = new Map();
    contracts.forEach((c) => {
      const cid = toStr(c.campaignId);
      if (campaignIds.includes(cid)) {
        contractIdMap.set(cid, c.contractId);
        feeMap.set(cid, c.feeAmount);
        acceptedMap.set(cid, c.isAccepted === 1 ? 1 : 0);
      }
    });

    const filter = { campaignsId: { $in: campaignIds }, isActive: 1 };
    if (search?.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, raw] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const campaigns = raw.map((c) => ({
      ...c,
      hasApplied: 1,
      isContracted: 1,
      isAccepted: acceptedMap.get(c.campaignsId) || 0,
      hasMilestone: 1,
      contractId: contractIdMap.get(c.campaignsId) || null,
      feeAmount: feeMap.get(c.campaignsId) || 0
    }));

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      campaigns
    });
  } catch (err) {
    console.error('Error in getApprovedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: APPLIED (but NOT contracted/accepted)
// ===============================
exports.getAppliedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    const applyRecs = await ApplyCampaign.find({ 'applicants.influencerId': influencerId }, 'campaignId').lean();
    let campaignIds = applyRecs.map((r) => r.campaignId);
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    const contracted = await Contract.find(
      {
        influencerId,
        campaignId: { $in: campaignIds },
        $or: [{ isAssigned: 1 }, { isAccepted: 1 }]
      },
      'campaignId'
    ).lean();

    const excludedIds = new Set(contracted.map((c) => c.campaignId));
    campaignIds = campaignIds.filter((id) => !excludedIds.has(id));
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const campaigns = rawCampaigns.map((c) => ({
      ...c,
      hasApplied: 1,
      isContracted: 0,
      isAccepted: 0
    }));

    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      campaigns
    });
  } catch (err) {
    console.error('Error in getAppliedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  BRAND: ACCEPTED CAMPAIGNS (has accepted contracts)
//      • POST body: { brandId, search?, page?, limit? }
// ===============================
exports.getAcceptedCampaigns = async (req, res) => {
  const { brandId, search, page = 1, limit = 10 } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    const contracts = await Contract.find(
      { brandId, isAccepted: 1 },
      'campaignId contractId influencerId feeAmount'
    ).lean();

    const campaignIds = contracts.map((c) => c.campaignId);
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        campaigns: []
      });
    }

    const contractMap = new Map(); // campaignId → contractId
    const influencerMap = new Map(); // campaignId → influencerId
    const feeMap = new Map(); // campaignId → feeAmount
    contracts.forEach((c) => {
      contractMap.set(c.campaignId, c.contractId);
      influencerMap.set(c.campaignId, c.influencerId);
      feeMap.set(c.campaignId, c.feeAmount);
    });

    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const annotated = campaigns.map((c) => {
      const cid = c.campaignsId;
      return {
        ...c,
        contractId: contractMap.get(cid),
        influencerId: influencerMap.get(cid),
        feeAmount: feeMap.get(cid),
        isAccepted: 1
      };
    });

    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      campaigns: annotated
    });
  } catch (err) {
    console.error('Error in getAcceptedCampaigns:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  ACCEPTED INFLUENCERS (per Campaign)
//      • POST body: { campaignId, search?, page?, limit?, sortBy?, order? }
// ===============================
exports.getAcceptedInfluencers = async (req, res) => {
  const {
    campaignId,
    search = '',
    page = 1,
    limit = 10,
    sortBy = 'createdAt',
    order = 'desc'
  } = req.body;

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    const contracts = await Contract.find(
      { campaignId, isAccepted: 1 },
      'influencerId contractId feeAmount'
    ).lean();

    const influencerIds = contracts.map((c) => c.influencerId);
    if (influencerIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        influencers: []
      });
    }

    const contractMap = new Map();
    const feeMap = new Map();
    contracts.forEach((c) => {
      contractMap.set(c.influencerId, c.contractId);
      feeMap.set(c.influencerId, c.feeAmount);
    });

    const filter = { influencerId: { $in: influencerIds } };
    if (search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term, 'i');
      filter.$or = [{ name: regex }, { handle: regex }, { email: regex }];
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const SORT_WHITELIST = {
      createdAt: 'createdAt',
      name: 'name',
      followerCount: 'followerCount',
      feeAmount: 'feeAmount' // client-side sort after join
    };
    const sortField = SORT_WHITELIST[sortBy] || 'createdAt';
    const sortDir = order === 'asc' ? 1 : -1;
    const needPostSort = sortField === 'feeAmount';
    const mongoSort = needPostSort ? {} : { [sortField]: sortDir };

    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter).sort(mongoSort).skip(skip).limit(limNum).select('-passwordHash -__v').lean()
    ]);

    let influencers = rawInfluencers.map((i) => ({
      ...i,
      contractId: contractMap.get(i.influencerId),
      feeAmount: feeMap.get(i.influencerId),
      isAccepted: 1
    }));

    if (needPostSort) {
      influencers.sort((a, b) => (sortDir === 1 ? a.feeAmount - b.feeAmount : b.feeAmount - a.feeAmount));
    }

    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      influencers
    });
  } catch (err) {
    console.error('Error in getAcceptedInfluencers:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: CONTRACTED (assigned but no milestone)
// ===============================
exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // Consider these statuses as "contracted" and visible to the influencer
    const CONTRACTED_STATUSES = ['sent', 'viewed', 'negotiation', 'finalize', 'signing', 'locked'];

    // Pull every non-rejected contract for this influencer in a contracted-ish state
    const contracts = await Contract.find(
      {
        influencerId,
        isRejected: { $ne: 1 },
        status: { $in: CONTRACTED_STATUSES }
        // NOTE: we do NOT require isAssigned anymore to avoid filtering out older data
      },
      'campaignId contractId feeAmount isAccepted status'
    ).lean();

    const campaignIds = [...new Set(contracts.map(c => String(c.campaignId)).filter(Boolean))];
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // Build quick map from campaignId -> contract details
    const contractByCampaign = new Map();
    contracts.forEach(c => {
      const key = String(c.campaignId);
      contractByCampaign.set(key, {
        contractId: c.contractId || null,
        feeAmount: Number(c.feeAmount || 0),
        isAccepted: c.isAccepted === 1 ? 1 : 0,
        status: c.status
      });
    });

    // Query campaigns for these IDs (we keep it simple & inclusive)
    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const campaigns = rawCampaigns.map(c => {
      const key = String(c.campaignsId);
      const details = contractByCampaign.get(key) || {};
      return {
        ...c,
        // UI flags the table expects
        hasApplied: 1,
        isContracted: 1,
        isAccepted: details.isAccepted || 0,
        hasMilestone: c.hasMilestone ?? 0, // leave as-is if you store it, else default 0
        contractId: details.contractId,
        feeAmount: details.feeAmount
      };
    });

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      campaigns
    });
  } catch (err) {
    console.error('Error in getContractedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  GENERIC FILTER (subcategory-based)
//      • POST body supports:
//          subcategoryIds?: string[]
//          categoryIds?: string[] (ObjectId strings)
//          gender?: 0|1
//          minAge?, maxAge?, ageMode?: 'containment'|'overlap'
//          countryId?: string|string[] (ObjectId)
//          goal?: 'Brand Awareness'|'Sales'|'Engagement'
//          minBudget?, maxBudget?
//          search?, page?, limit?, sortBy?, sortOrder?
// ===============================
const ALLOWED_GOALS = ['Brand Awareness', 'Sales', 'Engagement'];
const SORT_WHITELIST = ['createdAt', 'budget', 'goal', 'brandName'];

exports.getCampaignsByFilter = async (req, res) => {
  try {
    const {
      subcategoryIds = [],
      categoryIds = [],
      gender,
      minAge,
      maxAge,
      ageMode = 'containment',
      countryId,
      goal,
      minBudget,
      maxBudget,
      search = '',
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.body;

    const filter = {};

    // Category/Subcategory filters
    if (Array.isArray(subcategoryIds) && subcategoryIds.length) {
      filter['categories.subcategoryId'] = { $in: subcategoryIds.map(String) };
    }
    if (Array.isArray(categoryIds) && categoryIds.length) {
      // primary path: numeric Category.id (number or numeric string)
      const nums = categoryIds
        .map(v => Number(v))
        .filter(n => Number.isFinite(n));

      // backward-compat: if client accidentally sent ObjectIds, resolve to numeric ids
      const maybeObjIds = categoryIds
        .filter(v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v));

      let fromObj = [];
      if (maybeObjIds.length) {
        const rows = await Category.find({ _id: { $in: maybeObjIds } }, 'id').lean();
        fromObj = rows.map(r => r.id).filter(n => Number.isFinite(n));
      }

      const combined = [...new Set([...nums, ...fromObj])];
      if (combined.length) {
        filter['categories.categoryId'] = { $in: combined }; // ✅ numeric match
      }
    }

    // gender
    if ([0, 1].includes(Number(gender))) filter['targetAudience.gender'] = Number(gender);

    // age
    const minA = Number(minAge);
    const maxA = Number(maxAge);
    if (!isNaN(minA) || !isNaN(maxA)) {
      if (ageMode === 'containment') {
        if (!isNaN(minA)) filter['targetAudience.age.MinAge'] = { $gte: minA };
        if (!isNaN(maxA)) filter['targetAudience.age.MaxAge'] = { $lte: maxA };
      } else {
        if (!isNaN(maxA)) filter['targetAudience.age.MinAge'] = { $lte: maxA };
        if (!isNaN(minA)) filter['targetAudience.age.MaxAge'] = { $gte: minA };
      }
    }

    // country
    if (Array.isArray(countryId) && countryId.length) {
      const validIds = countryId
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      if (validIds.length) {
        filter['targetAudience.locations'] = { $elemMatch: { countryId: { $in: validIds } } };
      }
    } else if (countryId && mongoose.Types.ObjectId.isValid(countryId)) {
      filter['targetAudience.locations'] = {
        $elemMatch: { countryId: new mongoose.Types.ObjectId(countryId) }
      };
    }

    // goal
    if (goal && ALLOWED_GOALS.includes(goal)) filter.goal = goal;

    // budget
    const minB = Number(minBudget);
    const maxB = Number(maxBudget);
    if (!isNaN(minB) || !isNaN(maxB)) {
      filter.budget = {};
      if (!isNaN(minB)) filter.budget.$gte = minB;
      if (!isNaN(maxB)) filter.budget.$lte = maxB;
    }

    // text search
    if (typeof search === 'string' && search.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    // pagination & sorting
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * perPage;

    const sortField = SORT_WHITELIST.includes(sortBy) ? sortBy : 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortField]: sortDir };

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort(sortObj).skip(skip).limit(perPage).lean()
    ]);

    return res.json({
      data: campaigns,
      pagination: {
        total,
        page: pageNum,
        limit: perPage,
        totalPages: Math.ceil(total / perPage)
      }
    });
  } catch (err) {
    console.error('Error in getCampaignsByFilter:', err);
    return res.status(500).json({ message: 'Internal server error while filtering campaigns.' });
  }
};

// ===============================
//  INFLUENCER: REJECTED CAMPAIGNS (excludes any that were later resent)
//      • POST body: { influencerId, search?, page?, limit? }
// ===============================
exports.getRejectedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search = '', page = 1, limit = 10 } = req.body || {};
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    // Step 1: find rejected contracts for this influencer
    const candFilter = {
      influencerId: String(influencerId),
      $or: [{ status: 'rejected' }, { isRejected: 1 }],
      // coarse exclude of parents already marked with a successor
      $and: [
        {
          $or: [
            { supersededBy: { $exists: false } },
            { supersededBy: null },
            { supersededBy: '' }
          ]
        }
      ]
    };

    const candidates = await Contract.find(
      candFilter,
      'contractId campaignId feeAmount createdAt audit supersededBy'
    ).lean();

    if (!candidates.length) {
      return res.json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    // Step 2: exclude any rejected contract that has a child resend
    const candidateIds = candidates.map(c => String(c.contractId));
    const children = await Contract.find({ resendOf: { $in: candidateIds } }, 'resendOf').lean();
    const parentsWithChildren = new Set(children.map(ch => String(ch.resendOf)));

    const finalRejected = candidates.filter(c => !parentsWithChildren.has(String(c.contractId)));
    if (!finalRejected.length) {
      return res.json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    // Step 3: if multiple rejected entries per campaign, keep the latest
    const latestByCampaign = new Map(); // campaignId -> contract
    for (const c of finalRejected) {
      const key = String(c.campaignId);
      const prev = latestByCampaign.get(key);
      if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) {
        latestByCampaign.set(key, c);
      }
    }

    const campaignIds = Array.from(latestByCampaign.keys());

    // Step 4: fetch campaigns (+ optional text search) and paginate
    const campFilter = { campaignsId: { $in: campaignIds } };
    if (typeof search === 'string' && search.trim()) {
      campFilter.$or = buildSearchOr(search.trim());
    }

    const allMatched = await Campaign.find(campFilter).sort({ createdAt: -1 }).lean();
    const total = allMatched.length;

    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = Math.max(1, parseInt(limit, 10));
    const start = (pageNum - 1) * perPage;
    const slice = allMatched.slice(start, start + perPage);

    // Step 5: decorate campaigns with rejection details and UI flags
    const campaigns = slice.map((camp) => {
      const parent = latestByCampaign.get(String(camp.campaignsId)) || {};
      let rejectedAt = parent.createdAt || null;
      let reason = '';

      if (Array.isArray(parent.audit)) {
        const rejEvents = parent.audit.filter(e => e?.type === 'REJECTED');
        if (rejEvents.length) {
          // pick most recent REJECTED event if multiple
          rejEvents.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
          const last = rejEvents[rejEvents.length - 1];
          rejectedAt = last.at || rejectedAt;
          reason = (last.details && last.details.reason) || '';
        }
      }

      return {
        ...camp,
        hasApplied: 1,
        isContracted: 0,
        isAccepted: 0,
        isRejected: 1,
        contractId: parent.contractId || null,
        feeAmount: Number(parent.feeAmount || 0),
        rejectedAt,
        rejectionReason: reason
      };
    });

    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: perPage,
        totalPages: Math.ceil(total / perPage)
      },
      campaigns
    });
  } catch (err) {
    console.error('Error in getRejectedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error while fetching rejected campaigns.' });
  }
};
