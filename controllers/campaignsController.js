const mongoose = require('mongoose');
const multer = require('multer');
const { uploadToGridFS } = require('../utils/gridfs');

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
const Modash = require('../models/modash'); // adjust path if needed


// ✅ persisted notifications helper (creates DB row + emits via socket.io)
const { createAndEmit } = require('../utils/notifier');

// ===============================
//  Multer setup (memory) + MIME filters
// ===============================
const storage = multer.memoryStorage();
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml']);
const DOC_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);

// ===============================
//  Subscription / Quota helpers
// ===============================

function readLimit(featureRow) {
  if (!featureRow) return 0;
  const raw = featureRow.limit ?? featureRow.value ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureMonthlyWindow(influencerId, featureKey, featureRow) {
  return featureRow;
}

async function countActiveCollaborationsForInfluencer(influencerId) {
  if (!influencerId) return 0;

  const filter = {
    influencerId: String(influencerId),
    isRejected: { $ne: 1 },
    isAccepted: 1
  };

  return Contract.countDocuments(filter);
}

function fileFilter(req, file, cb) {
  if (file.fieldname === 'image') return cb(null, IMAGE_MIMES.has(file.mimetype));
  if (file.fieldname === 'creativeBrief') return cb(null, DOC_MIMES.has(file.mimetype));
  return cb(null, false);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter
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

/** Expand & validate categories payload into uniform shape */
async function normalizeCategoriesPayload(raw) {
  if (!raw) return [];

  let items = raw;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { throw new Error('Invalid JSON in categories.'); }
  }
  if (!Array.isArray(items)) throw new Error('categories must be an array.');

  const catNums = [...new Set(
    items.map(it => Number(it?.categoryId)).filter(n => Number.isFinite(n))
  )];
  if (!catNums.length) throw new Error('categories must contain numeric categoryId.');

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
      categoryId: catDoc.id,
      categoryName: catDoc.name,
      subcategoryId: sub.subcategoryId,
      subcategoryName: sub.name
    });
  }
  return out;
}

function buildSearchOr(term) {
  const or = [
    { brandName: { $regex: term, $options: 'i' } },
    { productOrServiceName: { $regex: term, $options: 'i' } },
    { description: { $regex: term, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: term, $options: 'i' } },
    { 'categories.categoryName': { $regex: term, $options: 'i' } }
  ];
  const num = Number(term);
  if (!isNaN(num)) or.push({ budget: { $lte: num } });
  return or;
}

async function buildSubToParentNumMap() {
  const rows = await Category.find({}, 'id subcategories').lean();
  const subIdToParentNum = new Map();
  for (const r of rows) {
    for (const s of (r.subcategories || [])) {
      subIdToParentNum.set(String(s.subcategoryId), r.id);
    }
  }
  return subIdToParentNum;
}

async function findMatchingInfluencers({ subIds = [], catNumIds = [] }) {
  if (!subIds.length && !catNumIds.length) return [];

  const or = [];
  if (subIds.length) {
    or.push(
      { 'onboarding.subcategories.subcategoryId': { $in: subIds } },
      { 'subcategories.subcategoryId': { $in: subIds } },
      { 'categories.subcategoryId': { $in: subIds } },
      { 'socialProfiles.categories.subcategoryId': { $in: subIds } },
      { 'categories': { $in: subIds } }
    );
  }
  if (catNumIds.length) {
    or.push(
      { 'onboarding.categoryId': { $in: catNumIds } },
      { 'categories.categoryId': { $in: catNumIds } }
    );
  }

  const filter = or.length ? { $or: or } : {};
  const influencers = await Influencer.find(
    filter,
    'influencerId name primaryPlatform handle onboarding socialProfiles'
  ).lean();

  return influencers || [];
}

// ===============================
//  CREATE CAMPAIGN
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
        return res.status(403).json({ message: `You have reached this cycle’s campaign quota ${limit}.` });
      }


      // targetAudience
      let audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
      if (targetAudience) {
        let ta = targetAudience;
        if (typeof ta === 'string') {
          try { ta = JSON.parse(ta); } catch { return res.status(400).json({ message: 'Invalid JSON in targetAudience.' }); }
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
            if (!country) return res.status(404).json({ message: `Country not found: ${countryId}` });
            audienceData.locations.push({ countryId: country._id, countryName: country.countryName });
          }
        }
      }

      // categories
      let categoriesData = [];
      try { categoriesData = await normalizeCategoriesPayload(categories); }
      catch (e) { return res.status(400).json({ message: e.message || 'Invalid categories payload.' }); }

      // timeline
      let tlData = {};
      if (timeline) {
        let tl = timeline;
        if (typeof tl === 'string') {
          try { tl = JSON.parse(tl); } catch { return res.status(400).json({ message: 'Invalid JSON in timeline.' }); }
        }
        if (tl.startDate) {
          const sd = new Date(tl.startDate); if (!isNaN(sd)) tlData.startDate = sd;
        }
        if (tl.endDate) {
          const ed = new Date(tl.endDate); if (!isNaN(ed)) tlData.endDate = ed;
        }
      }

      const isActiveFlag = computeIsActive(tlData);

      // files → GridFS
      const imagesUploaded = await uploadToGridFS(req.files.image || [], {
        prefix: 'campaign_image',
        metadata: { kind: 'campaign_image', brandId },
        req
      });
      const creativeUploaded = await uploadToGridFS(req.files.creativeBrief || [], {
        prefix: 'campaign_brief',
        metadata: { kind: 'campaign_brief', brandId },
        req
      });
      const images = imagesUploaded.map((f) => f.filename);
      const creativePDFs = creativeUploaded.map((f) => f.filename);

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

      // ==== Notifications to matching influencers ====
      try {
        const subIds = Array.from(new Set((categoriesData || []).map(c => String(c.subcategoryId))));
        const catNumIds = Array.from(new Set((categoriesData || []).map(c => Number(c.categoryId)).filter(Number.isFinite)));

        if (subIds.length || catNumIds.length) {
          const influencers = await findMatchingInfluencers({ subIds, catNumIds });

          if (Array.isArray(influencers) && influencers.length) {
            const campaignIdForUrl = newCampaign.campaignsId || String(newCampaign._id);
            const actionPath = `/influencer/dashboard/view-campaign?id=${campaignIdForUrl}`;
            const title = 'New campaign matches your profile';
            const message = `${newCampaign.brandName} posted "${newCampaign.productOrServiceName}".`;

            await Promise.all(
              influencers.map((inf) =>
                createAndEmit({
                  influencerId: String(inf.influencerId),
                  type: 'campaign.match',
                  title,
                  message,
                  entityType: 'campaign',
                  entityId: String(campaignIdForUrl),
                  actionPath
                }).catch(e => console.warn('notify influencer failed', inf.influencerId, e.message))
              )
            );
          }
        }
      } catch (notifErr) {
        console.warn('createCampaign: notification flow failed (non-fatal)', notifErr.message);
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
    if (req.query.brandId) filter.brandId = req.query.brandId;
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).lean();
    return res.json(campaigns);
  } catch (error) {
    console.error('Error in getAllCampaigns:', error);
    return res.status(500).json({ message: 'Internal server error while fetching campaigns.' });
  }
};

// =======================================
//  GET A SINGLE CAMPAIGN BY campaignsId
// =======================================
exports.getCampaignById = async (req, res) => {
  try {
    const campaignsId = req.query.id;
    if (!campaignsId) {
      return res.status(400).json({ message: 'Query parameter id (campaignsId) is required.' });
    }

    const campaign = await Campaign.findOne({ campaignsId }).lean();
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });
    return res.json(campaign);
  } catch (error) {
    console.error('Error in getCampaignById:', error);
    return res.status(500).json({ message: 'Internal server error while fetching campaign.' });
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
        return res.status(400).json({ message: 'Query parameter id (campaignsId) is required.' });
      }

      const updates = { ...req.body };

      // Protected fields
      delete updates.brandId;
      delete updates.brandName;
      delete updates.campaignsId;
      delete updates.createdAt;
      delete updates.interestId;
      delete updates.interestName;

      // targetAudience
      if (updates.targetAudience) {
        let ta = updates.targetAudience;
        if (typeof ta === 'string') {
          try { ta = JSON.parse(ta); } catch { return res.status(400).json({ message: 'Invalid JSON in targetAudience.' }); }
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
          if (!country) return res.status(404).json({ message: `Country not found: ${idCandidate}` });
          audienceData.locations.push({ countryId: country._id, countryName: country.countryName });
        }

        updates.targetAudience = audienceData;
      }

      // categories
      if (updates.categories !== undefined) {
        try { updates.categories = await normalizeCategoriesPayload(updates.categories); }
        catch (e) { return res.status(400).json({ message: e.message || 'Invalid categories payload.' }); }
      }

      // timeline
      if (updates.timeline) {
        let parsedTL = updates.timeline;
        if (typeof updates.timeline === 'string') {
          try { parsedTL = JSON.parse(updates.timeline); } catch { return res.status(400).json({ message: 'Invalid JSON in timeline.' }); }
        }
        const { startDate, endDate } = parsedTL;
        const timelineData = {};
        if (startDate) { const sd = new Date(startDate); if (!isNaN(sd)) timelineData.startDate = sd; }
        if (endDate) { const ed = new Date(endDate); if (!isNaN(ed)) timelineData.endDate = ed; }
        updates.timeline = timelineData;
        updates.isActive = computeIsActive(timelineData);
      }

      // files → GridFS
      if (Array.isArray(req.files['image']) && req.files['image'].length > 0) {
        const uploadedImages = await uploadToGridFS(req.files['image'], {
          prefix: 'campaign_image',
          metadata: { kind: 'campaign_image', campaignsId },
          req
        });
        updates.images = uploadedImages.map((f) => f.filename);
      }
      if (Array.isArray(req.files['creativeBrief']) && req.files['creativeBrief'].length > 0) {
        const uploadedBriefs = await uploadToGridFS(req.files['creativeBrief'], {
          prefix: 'campaign_brief',
          metadata: { kind: 'campaign_brief', campaignsId },
          req
        });
        updates.creativeBrief = uploadedBriefs.map((f) => f.filename);
      }

      const updatedCampaign = await Campaign.findOneAndUpdate({ campaignsId }, updates, {
        new: true,
        runValidators: true
      }).lean();

      if (!updatedCampaign) return res.status(404).json({ message: 'Campaign not found.' });

      return res.json({ message: 'Campaign updated successfully.', campaign: updatedCampaign });
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
    if (!campaignsId) return res.status(400).json({ message: 'Query parameter id (campaignsId) is required.' });

    const deleted = await Campaign.findOneAndDelete({ campaignsId });
    if (!deleted) return res.status(404).json({ message: 'Campaign not found.' });
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
    const { brandId, page = 1, limit = 10, search = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    if (!brandId) return res.status(400).json({ message: 'Query parameter brandId is required.' });

    const filter = { brandId, isActive: 1 };
    if (search) filter.$or = buildSearchOr(search);

    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const skip = (pageNum - 1) * perPage;

    const sortDir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDir };

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter)
        .select('-description') // ← exclude description
        .sort(sortObj)
        .skip(skip)
        .limit(perPage)
        .lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({
      data: campaigns,
      pagination: { total: totalCount, page: pageNum, limit: perPage, totalPages: Math.ceil(totalCount / perPage) }
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
    const { brandId, page = 1, limit = 10, search = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    if (!brandId) return res.status(400).json({ message: 'Query parameter brandId is required.' });

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
      pagination: { total: totalCount, page: pageNum, limit: perPage, totalPages: Math.ceil(totalCount / perPage) }
    });
  } catch (error) {
    console.error('Error in getPreviousCampaigns:', error);
    return res.status(500).json({ message: 'Internal server error while fetching previous campaigns.' });
  }
};

// ===============================
//  ACTIVE CAMPAIGNS BY SUBCATEGORIES
// ===============================
exports.getActiveCampaignsByCategories = async (req, res) => {
  try {
    let { subcategoryIds, search, page = 1, limit = 10 } = req.body;

    if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) {
      return res.status(400).json({ message: 'You must provide at least one subcategoryId' });
    }
    subcategoryIds = subcategoryIds.map((s) => String(s));

    const filter = { isActive: 1, 'categories.subcategoryId': { $in: subcategoryIds } };
    if (search && typeof search === 'string' && search.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    return res.json({ meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) }, campaigns });
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
  if (!campaignId || !influencerId) return res.status(400).json({ message: 'campaignId and influencerId are required' });

  try {
    const campaign = await Campaign.findOne({ campaignsId: campaignId }).lean();
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });

    const applied = await ApplyCampaign.exists({ campaignId, 'applicants.influencerId': influencerId });

    campaign.hasApplied = applied ? 1 : 0;
    return res.json(campaign);
  } catch (err) {
    console.error('Error in checkApplied:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: DISCOVER CAMPAIGNS
// ===============================
exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const subIdToParentNum = await buildSubToParentNumMap();

    const selectedSubIds = new Set((inf.onboarding?.subcategories || [])
      .map(s => s?.subcategoryId).filter(Boolean).map(String));

    const selectedCatNumIds = new Set();
    if (typeof inf.onboarding?.categoryId === 'number') selectedCatNumIds.add(inf.onboarding.categoryId);

    for (const subId of selectedSubIds) {
      const parentNum = subIdToParentNum.get(subId);
      if (typeof parentNum === 'number') selectedCatNumIds.add(parentNum);
    }

    if (selectedSubIds.size === 0 && selectedCatNumIds.size === 0) {
      return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });
    }

    const subIdsArr = Array.from(selectedSubIds);
    const catNumArr = Array.from(selectedCatNumIds);

    const orClauses = [];
    if (subIdsArr.length) orClauses.push({ 'categories.subcategoryId': { $in: subIdsArr } });
    if (catNumArr.length) orClauses.push({ 'categories.categoryId': { $in: catNumArr } });

    const filter = { isActive: 1, $or: orClauses };
    if (search?.trim()) filter.$and = [{ $or: buildSearchOr(search.trim()) }];

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    let canApply = true;
    const applyF = (inf.subscription?.features || []).find(f => f.key === 'apply_to_campaigns_quota');
    if (applyF) {
      const fReset = await ensureMonthlyWindow(influencerId, 'apply_to_campaigns_quota', applyF);
      const lim = readLimit(fReset);
      if (lim > 0 && Number(fReset.used || 0) >= lim) canApply = false;
    }
    const capF = (inf.subscription?.features || []).find(f => f.key === 'active_collaborations_limit');
    const cap = readLimit(capF);
    if (cap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= cap) canApply = false;
    }

    const totalPages = Math.ceil(total / limNum);
    const annotated = campaigns.map((c) => ({ ...c, hasApplied: 0, hasApproved: 0, isContracted: 0, contractId: null, isAccepted: 0, canApply }));

    return res.json({ meta: { total, page: pageNum, limit: limNum, totalPages }, campaigns: annotated });
  } catch (err) {
    console.error('Error in getCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  INFLUENCER: APPROVED (milestone + contract)
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
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const milestoneIds = await milestoneSetForInfluencer(influencerId, campaignIds);
    campaignIds = campaignIds.filter((id) => milestoneIds.has(id));
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

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
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

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

    return res.json({ meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) }, campaigns });
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
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const applyRecs = await ApplyCampaign.find(
      { 'applicants.influencerId': influencerId },
      'campaignId'
    ).lean();

    let campaignIds = applyRecs.map((r) => r.campaignId);
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    const contracted = await Contract.find(
      { influencerId, campaignId: { $in: campaignIds }, $or: [{ isAssigned: 1 }, { isAccepted: 1 }] },
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
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    // Projection explicitly excludes "description"
    const projection = '-description';

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter, projection).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    // Defensive omit of description if it slipped through from any source
    const campaigns = rawCampaigns.map(({ description, ...c }) => ({
      ...c,
      hasApplied: 1,
      isContracted: 0,
      isAccepted: 0
    }));

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      campaigns
    });
  } catch (err) {
    console.error('Error in getAppliedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  BRAND: ACCEPTED CAMPAIGNS
// ===============================
exports.getAcceptedCampaigns = async (req, res) => {
  const { brandId, search, page = 1, limit = 10 } = req.body;
  if (!brandId) return res.status(400).json({ message: 'brandId is required' });

  try {
    const contracts = await Contract.find(
      { brandId, isAccepted: 1 },
      'campaignId contractId influencerId feeAmount'
    ).lean();

    const campaignIds = contracts.map((c) => c.campaignId);
    if (campaignIds.length === 0) return res.status(200).json({ meta: { total: 0, page, limit, totalPages: 0 }, campaigns: [] });

    const contractMap = new Map();
    const influencerMap = new Map();
    const feeMap = new Map();
    contracts.forEach((c) => {
      contractMap.set(c.campaignId, c.contractId);
      influencerMap.set(c.campaignId, c.influencerId);
      feeMap.set(c.campaignId, c.feeAmount);
    });

    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    const annotated = campaigns.map((c) => ({
      ...c,
      contractId: contractMap.get(c.campaignsId),
      influencerId: influencerMap.get(c.campaignsId),
      feeAmount: feeMap.get(c.campaignsId),
      isAccepted: 1
    }));

    return res.json({ meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) }, campaigns: annotated });
  } catch (err) {
    console.error('Error in getAcceptedCampaigns:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  ACCEPTED INFLUENCERS (per Campaign)
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
    if (!influencerIds.length) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        influencers: []
      });
    }

    const contractMap = new Map();
    const feeMap = new Map();
    contracts.forEach((c) => {
      contractMap.set(String(c.influencerId), c.contractId);
      feeMap.set(String(c.influencerId), c.feeAmount);
    });

    const filter = { influencerId: { $in: influencerIds } };
    if (search && search.trim()) {
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
      feeAmount: 'feeAmount'
    };
    const sortField = SORT_WHITELIST[sortBy] || 'createdAt';
    const sortDir = order === 'asc' ? 1 : -1;
    const needPostSort = sortField === 'feeAmount';
    const mongoSort = needPostSort ? {} : { [sortField]: sortDir };

    // 1️⃣ Fetch influencers (paged)
    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .sort(mongoSort)
        .skip(skip)
        .limit(limNum)
        .select('-passwordHash -__v')
        .lean()
    ]);

    if (!rawInfluencers.length) {
      return res.json({
        meta: { total: 0, page: pageNum, limit: limNum, totalPages: 0 },
        influencers: []
      });
    }

    // 2️⃣ Fetch Modash profiles for ONLY these paged influencers
    const pageInfluencerIds = rawInfluencers.map((i) => String(i.influencerId));
    const modashProfiles = await Modash.find(
      { influencerId: { $in: pageInfluencerIds } },
      'influencerId username handle followers provider'
    ).lean();

    // Group Modash docs by influencerId
    const modashByInfluencerId = new Map();
    modashProfiles.forEach((m) => {
      const key = String(m.influencerId);
      if (!modashByInfluencerId.has(key)) {
        modashByInfluencerId.set(key, []);
      }
      modashByInfluencerId.get(key).push(m);
    });

    const ALLOWED_PROVIDERS = ['youtube', 'instagram', 'tiktok'];

    // Helper: pick "primary" Modash profile
    function pickPrimaryProfile(influencerDoc, profilesForInfluencer) {
      if (!Array.isArray(profilesForInfluencer) || profilesForInfluencer.length === 0) {
        return null;
      }

      const primaryPlatform = (influencerDoc.primaryPlatform || '').toLowerCase();

      if (ALLOWED_PROVIDERS.includes(primaryPlatform)) {
        const direct = profilesForInfluencer.find(
          (p) => (p.provider || '').toLowerCase() === primaryPlatform
        );
        if (direct) return direct;
      }

      // Fallback → profile with highest followers
      return profilesForInfluencer.reduce((best, current) => {
        if (!best) return current;
        const bestFollowers =
          typeof best.followers === 'number' ? best.followers : 0;
        const currentFollowers =
          typeof current.followers === 'number' ? current.followers : 0;
        return currentFollowers > bestFollowers ? current : best;
      }, null);
    }

    // 3️⃣ Merge in contract info + **primary** social handle + **primary** audience size
    let influencers = rawInfluencers.map((inf) => {
      const key = String(inf.influencerId);
      const profiles = modashByInfluencerId.get(key) || [];
      const primaryProfile = pickPrimaryProfile(inf, profiles);

      const socialHandle =
        (primaryProfile && (primaryProfile.username || primaryProfile.handle)) ||
        inf.handle ||
        null;

      const audienceSize =
        primaryProfile && typeof primaryProfile.followers === 'number'
          ? primaryProfile.followers
          : typeof inf.followerCount === 'number'
          ? inf.followerCount
          : 0;

      return {
        ...inf,
        contractId: contractMap.get(key) || null,
        feeAmount: feeMap.get(key) || 0,
        isAccepted: 1,
        socialHandle,        // handle of primary account
        audienceSize,        // followers of primary account
        primaryPlatform: inf.primaryPlatform || null,
        primaryProvider: primaryProfile ? primaryProfile.provider : null
      };
    });

    // 4️⃣ Optional post-sort by feeAmount (unchanged)
    if (needPostSort) {
      influencers.sort((a, b) =>
        sortDir === 1 ? a.feeAmount - b.feeAmount : b.feeAmount - a.feeAmount
      );
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
    return res
      .status(500)
      .json({ message: 'Internal server error' });
  }
};


// ===============================
//  INFLUENCER: CONTRACTED (assigned but no milestone)
// ===============================
exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const CONTRACTED_STATUSES = ['sent', 'viewed', 'negotiation', 'finalize', 'signing', 'locked'];

    const contracts = await Contract.find(
      { influencerId, isRejected: { $ne: 1 }, status: { $in: CONTRACTED_STATUSES } },
      'campaignId contractId feeAmount isAccepted status'
    ).lean();

    const campaignIds = [...new Set(contracts.map(c => String(c.campaignId)).filter(Boolean))];
    if (!campaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const contractByCampaign = new Map();
    contracts.forEach(c => { contractByCampaign.set(String(c.campaignId), { contractId: c.contractId || null, feeAmount: Number(c.feeAmount || 0), isAccepted: c.isAccepted === 1 ? 1 : 0, status: c.status }); });

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
      return { ...c, hasApplied: 1, isContracted: 1, isAccepted: details.isAccepted || 0, hasMilestone: c.hasMilestone ?? 0, contractId: details.contractId, feeAmount: details.feeAmount };
    });

    return res.json({ meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) }, campaigns });
  } catch (err) {
    console.error('Error in getContractedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ===============================
//  GENERIC FILTER (subcategory-based)
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

    if (Array.isArray(subcategoryIds) && subcategoryIds.length) {
      filter['categories.subcategoryId'] = { $in: subcategoryIds.map(String) };
    }
    if (Array.isArray(categoryIds) && categoryIds.length) {
      const nums = categoryIds.map(v => Number(v)).filter(n => Number.isFinite(n));
      const maybeObjIds = categoryIds.filter(v => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v));
      let fromObj = [];
      if (maybeObjIds.length) {
        const rows = await Category.find({ _id: { $in: maybeObjIds } }, 'id').lean();
        fromObj = rows.map(r => r.id).filter(n => Number.isFinite(n));
      }
      const combined = [...new Set([...nums, ...fromObj])];
      if (combined.length) filter['categories.categoryId'] = { $in: combined };
    }

    if ([0, 1].includes(Number(gender))) filter['targetAudience.gender'] = Number(gender);

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

    if (Array.isArray(countryId) && countryId.length) {
      const validIds = countryId.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
      if (validIds.length) filter['targetAudience.locations'] = { $elemMatch: { countryId: { $in: validIds } } };
    } else if (countryId && mongoose.Types.ObjectId.isValid(countryId)) {
      filter['targetAudience.locations'] = { $elemMatch: { countryId: new mongoose.Types.ObjectId(countryId) } };
    }

    if (goal && ALLOWED_GOALS.includes(goal)) filter.goal = goal;

    const minB = Number(minBudget);
    const maxB = Number(maxBudget);
    if (!isNaN(minB) || !isNaN(maxB)) {
      filter.budget = {};
      if (!isNaN(minB)) filter.budget.$gte = minB;
      if (!isNaN(maxB)) filter.budget.$lte = maxB;
    }

    if (typeof search === 'string' && search.trim()) filter.$or = buildSearchOr(search.trim());

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

    return res.json({ data: campaigns, pagination: { total, page: pageNum, limit: perPage, totalPages: Math.ceil(total / perPage) } });
  } catch (err) {
    console.error('Error in getCampaignsByFilter:', err);
    return res.status(500).json({ message: 'Internal server error while filtering campaigns.' });
  }
};

// ===============================
//  INFLUENCER: REJECTED CAMPAIGNS
// ===============================
exports.getRejectedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search = '', page = 1, limit = 10 } = req.body || {};
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const candFilter = {
      influencerId: String(influencerId),
      $or: [{ status: 'rejected' }, { isRejected: 1 }],
      $and: [{ $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: '' }] }]
    };

    const candidates = await Contract.find(candFilter, 'contractId campaignId feeAmount createdAt audit supersededBy').lean();
    if (!candidates.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const candidateIds = candidates.map(c => String(c.contractId));
    const children = await Contract.find({ resendOf: { $in: candidateIds } }, 'resendOf').lean();
    const parentsWithChildren = new Set(children.map(ch => String(ch.resendOf)));

    const finalRejected = candidates.filter(c => !parentsWithChildren.has(String(c.contractId)));
    if (!finalRejected.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const latestByCampaign = new Map();
    for (const c of finalRejected) {
      const key = String(c.campaignId);
      const prev = latestByCampaign.get(key);
      if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) latestByCampaign.set(key, c);
    }

    const campaignIds = Array.from(latestByCampaign.keys());

    const campFilter = { campaignsId: { $in: campaignIds } };
    if (typeof search === 'string' && search.trim()) campFilter.$or = buildSearchOr(search.trim());

    const allMatched = await Campaign.find(campFilter).sort({ createdAt: -1 }).lean();
    const total = allMatched.length;

    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = Math.max(1, parseInt(limit, 10));
    const start = (pageNum - 1) * perPage;
    const slice = allMatched.slice(start, start + perPage);

    const campaigns = slice.map((camp) => {
      const parent = latestByCampaign.get(String(camp.campaignsId)) || {};
      let rejectedAt = parent.createdAt || null;
      let reason = '';

      if (Array.isArray(parent.audit)) {
        const rejEvents = parent.audit.filter(e => e?.type === 'REJECTED');
        if (rejEvents.length) {
          rejEvents.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
          const last = rejEvents[rejEvents.length - 1];
          rejectedAt = last.at || rejectedAt;
          reason = (last.details && last.details.reason) || '';
        }
      }

      return { ...camp, hasApplied: 1, isContracted: 0, isAccepted: 0, isRejected: 1, contractId: parent.contractId || null, feeAmount: Number(parent.feeAmount || 0), rejectedAt, rejectionReason: reason };
    });

    return res.json({ meta: { total, page: pageNum, limit: perPage, totalPages: Math.ceil(total / perPage) }, campaigns });
  } catch (err) {
    console.error('Error in getRejectedCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error while fetching rejected campaigns.' });
  }
};

exports.getCampaignSummary = async (req, res) => {
  try {
    const campaignsId = req.query.id || req.params?.id;
    if (!campaignsId) return res.status(400).json({ message: 'Query parameter id (campaignsId) is required.' });

    const campaign = await Campaign.findOne({ campaignsId }, 'productOrServiceName budget timeline').lean();
    if (!campaign) return res.status(404).json({ message: 'Campaign not found.' });

    return res.json({ campaignName: campaign.productOrServiceName, budget: campaign.budget ?? 0, timeline: campaign.timeline || {} });
  } catch (error) {
    console.error('Error in getCampaignSummary:', error);
    return res.status(500).json({ message: 'Internal server error while fetching campaign summary.' });
  }
};