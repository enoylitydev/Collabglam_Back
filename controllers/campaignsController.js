// controllers/campaign.js
const mongoose = require('mongoose');
const multer = require('multer');
const { uploadToGridFS } = require('../utils/gridfs');

const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Category = require('../models/categories');
const ApplyCampaign = require('../models/applyCampaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const SubscriptionPlan = require('../models/subscription');
const getFeature = require('../utils/getFeature');
const Milestone = require('../models/milestone');
const Country = require('../models/country');
const Modash = require('../models/modash');
const { CONTRACT_STATUS } = require("../constants/contract");

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
async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) {
    throw new Error('brandId is required for quota checks');
  }

  // Only fetch subscription; keep it light
  const brand = await Brand.findOne({ brandId }, 'subscription').lean();
  if (!brand || !brand.subscription) {
    throw new Error('Brand subscription not configured');
  }

  const feature = getFeature.getFeature(brand.subscription, featureKey);

  // If feature is missing → treat as unlimited (same semantics as influencer quotas)
  if (!feature) {
    return { limit: 0, used: 0, remaining: Infinity };
  }

  // value OR limit can hold the numeric cap
  const limit = readLimit(feature); // 0 or NaN -> unlimited
  const used = Number(feature.used || 0) || 0;

  // If limit is 0 => unlimited, just return
  if (limit === 0) {
    return { limit: 0, used, remaining: Infinity };
  }

  // Enforce limit
  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = 'QUOTA_EXCEEDED';
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }

  // Persist usage
  await Brand.updateOne(
    {
      brandId,
      'subscription.features.key': featureKey
    },
    {
      $inc: { 'subscription.features.$.used': amount }
    }
  );

  return {
    limit,
    used: used + amount,
    remaining: limit - (used + amount)
  };
}

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
function activeAcceptedFilter() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [
      { supersededBy: { $exists: false } },
      { supersededBy: null },
      { supersededBy: "" }
    ]
  };
}

function campaignIdFilter(campaignId) {
  const id = String(campaignId);
  const or = [{ campaignId: id }, { campaignsId: id }];

  // optional robustness if some rows stored ObjectId
  if (mongoose.Types.ObjectId.isValid(id)) {
    or.push({ campaignId: new mongoose.Types.ObjectId(id) });
  }
  return { $or: or };
}

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

function addInfluencerOpenStatusGate(filter) {
  filter.$and = filter.$and || [];
  filter.$and.push({
    $or: [{ campaignStatus: 'open' },
    { campaignStatus: { $exists: false } }]
  });
  return filter;
}

// ✅ STATUS: closed removed
const CAMPAIGN_STATUS = Object.freeze({
  OPEN: "open",
  PAUSED: "paused",
});

const ALLOWED_CAMPAIGN_STATUSES = new Set([
  CAMPAIGN_STATUS.OPEN,
  CAMPAIGN_STATUS.PAUSED,
]);

function normalizeStatus(v) {
  return String(v || "").toLowerCase().trim();
}

exports.updateCampaignStatus = async (req, res) => {
  try {
    const { brandId, campaignId, status } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required." });
    }
    if (!campaignId) {
      return res.status(400).json({ message: "campaignId is required." });
    }

    const next = normalizeStatus(status);
    if (!ALLOWED_CAMPAIGN_STATUSES.has(next)) {
      return res.status(400).json({
        message: "Invalid status. Use: open | paused",
      });
    }

    // ✅ Robust: supports campaignsId / campaignId / ObjectId (via helper you already have)
    const campaign = await Campaign.findOne({
      brandId,
      ...campaignIdFilter(campaignId),
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found." });
    }

    // ✅ Legacy cleanup: if DB has "closed", treat it as "paused"
    const current = normalizeStatus(campaign.campaignStatus || CAMPAIGN_STATUS.OPEN);
    if (current === "closed") {
      campaign.campaignStatus = CAMPAIGN_STATUS.PAUSED;
    }

    // ✅ If opening, ensure timeline not ended
    if (next === CAMPAIGN_STATUS.OPEN) {
      const activeFlag = computeIsActive(campaign.timeline);
      if (activeFlag === 0) {
        return res.status(400).json({
          message: "Campaign timeline ended. Extend endDate to reopen.",
        });
      }
      // optional: clear pausedAt when opening
      campaign.pausedAt = undefined;
    }

    // ✅ Update status (no closed / no isActive changes)
    campaign.campaignStatus = next;
    campaign.statusUpdatedAt = new Date();

    if (next === CAMPAIGN_STATUS.PAUSED) {
      campaign.pausedAt = new Date();
    }

    await campaign.save();

    return res.json({
      message: "Campaign status updated successfully.",
      campaign,
    });
  } catch (error) {
    console.error("Error in updateCampaignStatus:", error);
    return res.status(500).json({
      message: "Internal server error while updating campaign status.",
    });
  }
};

// ===============================
//  CREATE CAMPAIGN
// ===============================
exports.createCampaign = (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      console.error("Multer Error:", err);
      return res.status(400).json({ message: err.message });
    }
    if (err) {
      console.error("Upload Error:", err);
      return res.status(500).json({ message: "Error uploading files." });
    }

    try {
      let {
        _id, // 🔹 NEW: when present, we will promote/update that draft
        brandId,
        productOrServiceName,
        description = "",
        targetAudience,
        categories, // [{categoryId, subcategoryId}]
        goal,
        campaignType, // optional
        creativeBriefText,
        budget = 0,
        timeline,
        additionalNotes = "",
      } = req.body;

      if (!brandId)
        return res.status(400).json({ message: "brandId is required." });
      if (!productOrServiceName || !goal) {
        return res
          .status(400)
          .json({ message: "productOrServiceName and goal are required." });
      }

      // Brand & plan
      const brand = await Brand.findOne({ brandId });
      if (!brand)
        return res.status(404).json({ message: "Brand not found." });

      const plan = await SubscriptionPlan.findOne({
        planId: brand.subscription.planId,
      }).lean();
      if (!plan)
        return res
          .status(500)
          .json({ message: "Subscription plan not found." });

      // Enforce ACTIVE CAMPAIGNS LIMIT (concurrent)
      const campFeat = getFeature.getFeature(
        brand.subscription,
        "active_campaigns_limit"
      );
      const campLimit = readLimit(campFeat); // 0 => unlimited / enterprise

      if (campLimit > 0) {
        const currentActive = await Campaign.countDocuments({
          brandId,
          isActive: 1,
        });
        if (currentActive >= campLimit) {
          return res.status(403).json({
            message: `You have reached your active campaign limit (${campLimit}).`,
          });
        }
      }

      // ---------- targetAudience ----------
      let audienceData = {
        age: { MinAge: 0, MaxAge: 0 },
        gender: 2,
        locations: [],
      };
      if (targetAudience) {
        let ta = targetAudience;
        if (typeof ta === "string") {
          try {
            ta = JSON.parse(ta);
          } catch {
            return res
              .status(400)
              .json({ message: "Invalid JSON in targetAudience." });
          }
        }
        const { age, gender, locations } = ta || {};
        if (age?.MinAge != null)
          audienceData.age.MinAge = Number(age.MinAge) || 0;
        if (age?.MaxAge != null)
          audienceData.age.MaxAge = Number(age.MaxAge) || 0;
        if ([0, 1, 2].includes(gender)) audienceData.gender = gender;

        if (Array.isArray(locations)) {
          for (const countryId of locations) {
            if (!mongoose.Types.ObjectId.isValid(countryId)) {
              return res
                .status(400)
                .json({ message: `Invalid countryId: ${countryId}` });
            }
            const country = await Country.findById(countryId);
            if (!country) {
              return res
                .status(404)
                .json({ message: `Country not found: ${countryId}` });
            }
            audienceData.locations.push({
              countryId: country._id,
              countryName: country.countryName,
            });
          }
        }
      }

      // ---------- categories ----------
      let categoriesData = [];
      try {
        categoriesData = await normalizeCategoriesPayload(categories);
      } catch (e) {
        return res.status(400).json({
          message: e.message || "Invalid categories payload.",
        });
      }

      // ---------- timeline ----------
      let tlData = {};
      if (timeline) {
        let tl = timeline;
        if (typeof tl === "string") {
          try {
            tl = JSON.parse(tl);
          } catch {
            return res
              .status(400)
              .json({ message: "Invalid JSON in timeline." });
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

      // ---------- files → GridFS ----------
      const imagesUploaded = await uploadToGridFS(req.files.image || [], {
        prefix: "campaign_image",
        metadata: { kind: "campaign_image", brandId },
        req,
      });
      const creativeUploaded = await uploadToGridFS(
        req.files.creativeBrief || [],
        {
          prefix: "campaign_brief",
          metadata: { kind: "campaign_brief", brandId },
          req,
        }
      );
      const newImages = imagesUploaded.map((f) => f.filename);
      const newCreativePDFs = creativeUploaded.map((f) => f.filename);

      // ---------- shared base data ----------
      const baseData = {
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        categories: categoriesData,
        goal,
        campaignType: campaignType || "",
        creativeBriefText,
        budget,
        timeline: tlData,
        additionalNotes,
        isActive: isActiveFlag,
        isDraft: 0, // 🔹 mark as final campaign

        // ✅ NEW: open by default
        campaignStatus: 'open',
        statusUpdatedAt: new Date(),
      };

      let campaignDoc;

      // ==========================================
      // CASE 1: _id provided → promote that DRAFT
      // ==========================================
      if (_id) {
        const existingDraft = await Campaign.findOne({
          _id,
          brandId,
          isDraft: 1,
        });

        if (!existingDraft) {
          return res.status(404).json({
            message: "Draft campaign not found for this brand.",
          });
        }

        // overwrite main fields from baseData
        Object.assign(existingDraft, baseData);

        // Only overwrite files if new ones are uploaded
        if (newImages.length) {
          existingDraft.images = newImages;
        }
        if (newCreativePDFs.length) {
          existingDraft.creativeBrief = newCreativePDFs;
        }

        campaignDoc = await existingDraft.save();
      }
      // ==========================================
      // CASE 2: no _id → create a fresh campaign
      // ==========================================
      else {
        const newCampaign = new Campaign({
          ...baseData,
          images: newImages,
          creativeBrief: newCreativePDFs,
        });

        campaignDoc = await newCampaign.save();
      }

      // ==== Notifications to matching influencers ====
      try {
        const subIds = Array.from(
          new Set(
            (campaignDoc.categories || []).map((c) =>
              String(c.subcategoryId)
            )
          )
        );
        const catNumIds = Array.from(
          new Set(
            (campaignDoc.categories || [])
              .map((c) => Number(c.categoryId))
              .filter(Number.isFinite)
          )
        );

        if (subIds.length || catNumIds.length) {
          const influencers = await findMatchingInfluencers({
            subIds,
            catNumIds,
          });

          if (Array.isArray(influencers) && influencers.length) {
            const campaignIdForUrl =
              campaignDoc.campaignsId || String(campaignDoc._id);
            const actionPath = `/influencer/dashboard/view-campaign?id=${campaignIdForUrl}`;
            const title = "New campaign matches your profile";
            const message = `${campaignDoc.brandName} posted "${campaignDoc.productOrServiceName}".`;

            await Promise.all(
              influencers.map((inf) =>
                createAndEmit({
                  influencerId: String(inf.influencerId),
                  type: "campaign.match",
                  title,
                  message,
                  entityType: "campaign",
                  entityId: String(campaignIdForUrl),
                  actionPath,
                }).catch((e) =>
                  console.warn(
                    "notify influencer failed",
                    inf.influencerId,
                    e.message
                  )
                )
              )
            );
          }
        }
      } catch (notifErr) {
        console.warn(
          "createCampaign: notification flow failed (non-fatal)",
          notifErr.message
        );
      }

      return res
        .status(201)
        .json({ message: "Campaign created successfully.", campaign: campaignDoc });
    } catch (error) {
      console.error("Error in createCampaign:", error);
      return res.status(500).json({
        message: "Internal server error while creating campaign.",
      });
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

      // ✅ NEW: protect status fields (must use updateCampaignStatus)
      delete updates.campaignStatus;
      delete updates.statusUpdatedAt;
      delete updates.pausedAt;
      delete updates.closedAt;

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

    // ✅ NEW: open only + exclude drafts (influencer side)
    const filter = addInfluencerOpenStatusGate({
      isActive: 1,
      isDraft: { $ne: 1 },
      'categories.subcategoryId': { $in: subcategoryIds }
    });

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
//  INFLUENCER: DISCOVER CAMPAIGNS (3 latest)
// ===============================
exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search } = req.body;
  if (!influencerId) return res.status(400).json({ message: "influencerId is required" });

  try {
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: "Influencer not found" });

    const FIXED_LIMIT = 5;

    // ✅ NEW: open only (and legacy open) + exclude drafts
    const filter = addInfluencerOpenStatusGate({
      isActive: 1,
      isDraft: { $ne: 1 }, // exclude drafts
    });

    if (search?.trim()) {
      filter.$or = buildSearchOr(search.trim());
    }

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .limit(FIXED_LIMIT)
        .lean(),
    ]);

    // ---- canApply calculation (same as your current code) ----
    let canApply = true;

    const applyF = (inf.subscription?.features || []).find(
      (f) => f.key === "apply_to_campaigns_quota"
    );
    if (applyF) {
      const fReset = await ensureMonthlyWindow(influencerId, "apply_to_campaigns_quota", applyF);
      const lim = readLimit(fReset);
      if (lim > 0 && Number(fReset.used || 0) >= lim) canApply = false;
    }

    const capF = (inf.subscription?.features || []).find(
      (f) => f.key === "active_collaborations_limit"
    );
    const cap = readLimit(capF);
    if (cap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= cap) canApply = false;
    }

    const annotated = campaigns.map((c) => ({
      ...c,
      hasApplied: 0,
      hasApproved: 0,
      isContracted: 0,
      contractId: null,
      isAccepted: 0,
      canApply,
    }));

    return res.json({
      meta: {
        total,
        page: 1,
        limit: FIXED_LIMIT,
        totalPages: Math.ceil(total / FIXED_LIMIT),
      },
      campaigns: annotated,
    });
  } catch (err) {
    console.error("Error in getCampaignsByInfluencer:", err);
    return res.status(500).json({ message: "Internal server error" });
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
      { brandId, ...activeAcceptedFilter() },
      "campaignId contractId influencerId feeAmount lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

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
    // ✅ Only contracts that represent an active / working collaboration
    const workingStatuses = [
      CONTRACT_STATUS.INFLUENCER_ACCEPTED,
      CONTRACT_STATUS.BRAND_ACCEPTED,
      CONTRACT_STATUS.READY_TO_SIGN,
      CONTRACT_STATUS.CONTRACT_SIGNED,
      CONTRACT_STATUS.MILESTONES_CREATED
    ];

    const contracts = await Contract.find(
      {
        ...campaignIdFilter(campaignId),
        isRejected: { $ne: 1 },             // not rejected
        status: { $in: workingStatuses }    // only working statuses
      },
      "influencerId contractId feeAmount lastActionAt createdAt status isAccepted isAssigned isRejected"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const influencerIds = contracts.map((c) => c.influencerId);
    if (!influencerIds.length) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        influencers: []
      });
    }

    // Keep latest contract per influencer (because of sort above)
    const contractMap = new Map();
    const feeMap = new Map();
    contracts.forEach((c) => {
      const key = String(c.influencerId);
      if (!contractMap.has(key)) {
        contractMap.set(key, c.contractId);
        feeMap.set(key, c.feeAmount);
      }
    });

    const filter = { influencerId: { $in: Array.from(contractMap.keys()) } };
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

    const pageInfluencerIds = rawInfluencers.map((i) => String(i.influencerId));

    const modashProfiles = await Modash.find(
      { influencerId: { $in: pageInfluencerIds } },
      'influencerId username handle followers provider'
    ).lean();

    const modashByInfluencerId = new Map();
    modashProfiles.forEach((m) => {
      const key = String(m.influencerId);
      if (!modashByInfluencerId.has(key)) {
        modashByInfluencerId.set(key, []);
      }
      modashByInfluencerId.get(key).push(m);
    });

    const ALLOWED_PROVIDERS = ['youtube', 'instagram', 'tiktok'];

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
      return profilesForInfluencer.reduce((best, current) => {
        if (!best) return current;
        const bestFollowers =
          typeof best.followers === 'number' ? best.followers : 0;
        const currentFollowers =
          typeof current.followers === 'number' ? current.followers : 0;
        return currentFollowers > bestFollowers ? current : best;
      }, null);
    }

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
        socialHandle,
        audienceSize,
        primaryPlatform: inf.primaryPlatform || null,
        primaryProvider: primaryProfile ? primaryProfile.provider : null
      };
    });

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

exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: "influencerId is required" });

  try {
    // ✅ Canonical statuses (what your schema normalizes to)
    const CANONICAL_CONTRACTED = [
      CONTRACT_STATUS.BRAND_SENT_DRAFT,
      CONTRACT_STATUS.BRAND_EDITED,
      CONTRACT_STATUS.INFLUENCER_EDITED,
      CONTRACT_STATUS.BRAND_ACCEPTED,
      CONTRACT_STATUS.INFLUENCER_ACCEPTED,
      CONTRACT_STATUS.READY_TO_SIGN,
      CONTRACT_STATUS.CONTRACT_SIGNED,
      CONTRACT_STATUS.MILESTONES_CREATED,
    ];

    // ✅ Optional: include legacy values for older rows that haven't been resaved/migrated
    const LEGACY_CONTRACTED = ["sent", "viewed", "negotiation", "finalize", "signing", "locked"];

    const contracts = await Contract.find(
      {
        influencerId: String(influencerId),
        isRejected: { $ne: 1 },
        status: { $in: Array.from(new Set([...CANONICAL_CONTRACTED, ...LEGACY_CONTRACTED])) },
      },
      "campaignId contractId feeAmount isAccepted status lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    if (!contracts.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // Keep the newest contract per campaign
    const contractByCampaign = new Map();
    for (const c of contracts) {
      const key = String(c.campaignId);
      if (!key) continue;
      if (!contractByCampaign.has(key)) {
        contractByCampaign.set(key, {
          contractId: c.contractId || null,
          feeAmount: Number(c.feeAmount || 0),
          isAccepted: c.isAccepted === 1 ? 1 : 0,
          status: c.status,
        });
      }
    }

    const campaignIds = Array.from(contractByCampaign.keys());
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // If some old contracts stored campaignId as ObjectId string, support both
    const uuidIds = [];
    const objIds = [];
    for (const id of campaignIds) {
      if (mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id) {
        objIds.push(new mongoose.Types.ObjectId(id));
      } else {
        uuidIds.push(id);
      }
    }

    let baseFilter;
    if (uuidIds.length && objIds.length) baseFilter = { $or: [{ campaignsId: { $in: uuidIds } }, { _id: { $in: objIds } }] };
    else if (uuidIds.length) baseFilter = { campaignsId: { $in: uuidIds } };
    else baseFilter = { _id: { $in: objIds } };

    let filter = baseFilter;
    if (search?.trim()) {
      filter = { $and: [baseFilter, { $or: buildSearchOr(search.trim()) }] };
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limNum).lean(),
    ]);

    const campaigns = rawCampaigns.map((c) => {
      const key = String(c.campaignsId || c._id);
      const details = contractByCampaign.get(key) || {};
      return {
        ...c,
        hasApplied: 1,
        isContracted: 1,
        isAccepted: details.isAccepted || 0,
        hasMilestone: c.hasMilestone ?? 0,
        contractId: details.contractId ?? null,
        feeAmount: details.feeAmount ?? 0,
        contractStatus: details.status ?? null,
      };
    });

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      campaigns,
    });
  } catch (err) {
    console.error("Error in getContractedCampaignsByInfluencer:", err);
    return res.status(500).json({ message: "Internal server error" });
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

    // ✅ NEW: open only + exclude drafts + active only (influencer side)
    const filter = addInfluencerOpenStatusGate({
      isActive: 1,
      isDraft: { $ne: 1 }
    });

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

exports.saveDraftCampaign = (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      console.error("Multer Error (draft):", err);
      return res.status(400).json({ message: err.message });
    }
    if (err) {
      console.error("Upload Error (draft):", err);
      return res.status(500).json({ message: "Error uploading files." });
    }

    try {
      let {
        _id,                 // 🔹 optional draft _id for updating
        brandId,
        productOrServiceName,
        description = "",
        targetAudience,
        categories,          // [{ categoryId, subcategoryId }]
        goal,
        campaignType,        // optional, same as createCampaign
        creativeBriefText,
        budget = 0,
        timeline,
        additionalNotes = "",
      } = req.body;

      // 🔹 For new drafts brandId is required (and we still use it for updates)
      if (!brandId) {
        return res.status(400).json({ message: "brandId is required." });
      }

      // For drafts we still enforce basic fields
      if (!productOrServiceName || !goal) {
        return res.status(400).json({
          message: "productOrServiceName and goal are required even for drafts.",
        });
      }

      // Brand (for brandName)
      const brand = await Brand.findOne({ brandId });
      if (!brand) {
        return res.status(404).json({ message: "Brand not found." });
      }

      // ---------- targetAudience ----------
      let audienceData = {
        age: { MinAge: 0, MaxAge: 0 },
        gender: 2,
        locations: [],
      };

      if (targetAudience) {
        let ta = targetAudience;
        if (typeof ta === "string") {
          try {
            ta = JSON.parse(ta);
          } catch {
            return res
              .status(400)
              .json({ message: "Invalid JSON in targetAudience." });
          }
        }

        const { age, gender, locations } = ta || {};
        if (age?.MinAge != null) audienceData.age.MinAge = Number(age.MinAge) || 0;
        if (age?.MaxAge != null) audienceData.age.MaxAge = Number(age.MaxAge) || 0;
        if ([0, 1, 2].includes(gender)) audienceData.gender = gender;

        if (Array.isArray(locations)) {
          for (const countryId of locations) {
            if (!mongoose.Types.ObjectId.isValid(countryId)) {
              return res
                .status(400)
                .json({ message: `Invalid countryId: ${countryId}` });
            }
            const country = await Country.findById(countryId);
            if (!country) {
              return res
                .status(404)
                .json({ message: `Country not found: ${countryId}` });
            }
            audienceData.locations.push({
              countryId: country._id,
              countryName: country.countryName,
            });
          }
        }
      }

      // ---------- categories ----------
      let categoriesData = [];
      try {
        categoriesData = await normalizeCategoriesPayload(categories);
      } catch (e) {
        return res
          .status(400)
          .json({ message: e.message || "Invalid categories payload." });
      }

      // ---------- timeline ----------
      let tlData = {};
      if (timeline) {
        let tl = timeline;
        if (typeof tl === "string") {
          try {
            tl = JSON.parse(tl);
          } catch {
            return res
              .status(400)
              .json({ message: "Invalid JSON in timeline." });
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

      // Drafts are always inactive
      const isActiveFlag = 0;

      // ---------- files → GridFS ----------
      const imagesUploaded = await uploadToGridFS(req.files.image || [], {
        prefix: "campaign_image",
        metadata: { kind: "campaign_image", brandId },
        req,
      });
      const creativeUploaded = await uploadToGridFS(
        req.files.creativeBrief || [],
        {
          prefix: "campaign_brief",
          metadata: { kind: "campaign_brief", brandId },
          req,
        }
      );

      const newImages = imagesUploaded.map((f) => f.filename);
      const newCreativePDFs = creativeUploaded.map((f) => f.filename);

      // ---------- base data used for both create/update ----------
      const baseData = {
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        categories: categoriesData,
        goal,
        campaignType: campaignType || "",
        creativeBriefText,
        budget,
        timeline: tlData,
        additionalNotes,
        isActive: isActiveFlag,
        isDraft: 1,
      };

      // ==========================================
      // NEW BEHAVIOUR:
      // If _id given → update only that draft
      // If no _id     → create new draft
      // ==========================================
      if (_id) {
        if (!mongoose.Types.ObjectId.isValid(_id)) {
          return res.status(400).json({ message: "Invalid draft _id." });
        }

        const existingDraft = await Campaign.findOne({
          _id,
          isDraft: 1,
        });

        if (!existingDraft) {
          return res
            .status(404)
            .json({ message: "Draft not found for given _id." });
        }

        // (Optional safety) brand must match
        if (existingDraft.brandId !== brandId) {
          return res.status(403).json({
            message: "You cannot update a draft that belongs to another brand.",
          });
        }

        // update existing draft
        Object.assign(existingDraft, baseData);

        // Only overwrite files if new ones are uploaded
        if (newImages.length) {
          existingDraft.images = newImages;
        }
        if (newCreativePDFs.length) {
          existingDraft.creativeBrief = newCreativePDFs;
        }

        await existingDraft.save();

        return res.status(200).json({
          message: "Campaign draft updated successfully.",
          campaign: existingDraft.toObject(),
        });
      }

      // No _id → create a new draft
      const newDraft = new Campaign({
        ...baseData,
        images: newImages,
        creativeBrief: newCreativePDFs,
      });

      await newDraft.save();

      return res.status(201).json({
        message: "Campaign draft saved successfully.",
        campaign: newDraft,
      });
    } catch (error) {
      console.error("Error in saveDraftCampaign:", error);
      return res
        .status(500)
        .json({ message: "Internal server error while saving draft." });
    }
  });
};

exports.getDraftCampaignByBrand = async (req, res) => {
  try {
    const { brandId } = req.query;

    if (!brandId) {
      return res
        .status(400)
        .json({ message: "brandId is required as a query param." });
    }

    const draft = await Campaign.findOne({
      brandId,
      isDraft: 1,          // ✅ only drafts
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (!draft) {
      return res.status(201).json({ message: "No draft found for this brand." });
    }

    return res.status(200).json(draft);
  } catch (error) {
    console.error("Error in getDraftCampaignByBrand:", error);
    return res
      .status(500)
      .json({ message: "Internal server error while fetching draft." });
  }
};
