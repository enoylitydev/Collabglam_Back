// controllers/campaignController.js

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const multer = require('multer');

const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Interest = require('../models/categories');
const ApplyCampaign = require('../models/applyCampaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const SubscriptionPlan = require('../models/subscription');
const getFeature = require('../utils/getFeature');
const Milestone = require('../models/milestone');
const Country = require('../models/country');


// ===============================
//  Multer setup for two fields:
//   • "image"         → for image uploads (stored in `images` array)
//   • "creativeBrief" → for PDF/document uploads (stored in `creativeBrief` array)
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

// Accept up to 10 images under 'image' and up to 10 docs under 'creativeBrief'
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB per file
}).fields([
  { name: 'image', maxCount: 10 },
  { name: 'creativeBrief', maxCount: 10 }
]);

// Helper to compute isActive from timeline
function computeIsActive(timeline) {
  if (!timeline || !timeline.endDate) {
    // If no endDate provided, default to active
    return 1;
  }
  const now = new Date();
  // If endDate is in the past, mark inactive (0). Otherwise active (1).
  return (timeline.endDate < now) ? 0 : 1;
}

const toStr = v => (v == null ? '' : String(v));

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
  docs.forEach(d => {
    d.milestoneHistory.forEach(e => {
      if (
        toStr(e.influencerId) === toStr(influencerId) &&
        campaignIds.includes(toStr(e.campaignId))
      ) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

// =======================================
//  CREATE CAMPAIGN (with isActive logic)
// =======================================
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
      // 1) Pull & validate incoming fields
      let {
        brandId,
        productOrServiceName,
        description = '',
        targetAudience,
        interestId,
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

      // 2) Load Brand & its current plan
      const brand = await Brand.findOne({ brandId });
      if (!brand) return res.status(404).json({ message: 'Brand not found.' });

      const plan = await SubscriptionPlan.findOne({ planId: brand.subscription.planId }).lean();
      if (!plan) {
        return res.status(500).json({ message: 'Subscription plan not found.' });
      }

      // 3) Enforce “live_campaigns_limit” per subscription cycle
      const liveCap = getFeature.getFeature(brand.subscription, 'live_campaigns_limit');
      const limit = liveCap ? liveCap.limit : 0;
      const used = liveCap ? liveCap.used : 0;
      if (limit > 0 && used >= limit) {
        return res.status(403).json({
          message: `You have reached this cycle’s campaign quota ${limit}. `
        });
      }

      // 4) Parse & normalize targetAudience JSON, now handling multiple locations
      let audienceData = { age: { MinAge: 0, MaxAge: 0 }, gender: 2, locations: [] };
      if (targetAudience) {
        let ta = targetAudience;
        if (typeof ta === 'string') {
          try { ta = JSON.parse(ta); }
          catch { return res.status(400).json({ message: 'Invalid JSON in targetAudience.' }); }
        }
        const { age, gender, locations } = ta;
        if (age?.MinAge != null) audienceData.age.MinAge = Number(age.MinAge) || 0;
        if (age?.MaxAge != null) audienceData.age.MaxAge = Number(age.MaxAge) || 0;
        if ([0, 1, 2].includes(gender)) audienceData.gender = gender;

        // Fetch country names for each provided countryId
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

      // 5) Parse & validate interestId array
      let validIds = [], names = [];
      if (interestId) {
        let arr = interestId;
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); }
          catch { return res.status(400).json({ message: 'Invalid JSON in interestId.' }); }
        }
        if (!Array.isArray(arr)) {
          return res.status(400).json({ message: 'interestId must be an array.' });
        }
        for (let id of arr) {
          if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: `Invalid interestId: ${id}` });
          }
          const doc = await Interest.findById(id);
          if (!doc) return res.status(404).json({ message: `Interest not found: ${id}` });
          validIds.push(doc._id);
          names.push(doc.name);
        }
      }

      // 6) Parse timeline JSON
      let tlData = {};
      if (timeline) {
        let tl = timeline;
        if (typeof tl === 'string') {
          try { tl = JSON.parse(tl); }
          catch { return res.status(400).json({ message: 'Invalid JSON in timeline.' }); }
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

      // 7) Compute isActive flag
      const isActiveFlag = computeIsActive(tlData);

      // 8) Gather uploaded file paths
      const images = (req.files.image || []).map(f => path.join('uploads', path.basename(f.path)));
      const creativePDFs = (req.files.creativeBrief || []).map(f => path.join('uploads', path.basename(f.path)));

      // 9) Build & save the new Campaign
      const newCampaign = new Campaign({
        brandId,
        brandName: brand.name,
        productOrServiceName,
        description,
        targetAudience: audienceData,
        interestId: validIds,
        interestName: names.join(','),
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

      // 10) Update usage count if needed
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
    const campaigns = await Campaign.find(filter)
      .sort({ createdAt: -1 })
      .populate('interestId', 'name');

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

    const campaign = await Campaign.findOne({ campaignsId }).populate('interestId', 'name');
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
//  UPDATE CAMPAIGN (with locations fix)
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

      // Copy all fields from req.body
      const updates = { ...req.body };

      // Remove protected fields
      delete updates.brandId;
      delete updates.brandName;
      delete updates.campaignsId;
      delete updates.createdAt;

      // Parse and validate targetAudience if present (KEEP `locations` array shape)
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

        // age
        if (ta.age && typeof ta.age === 'object') {
          const { MinAge, MaxAge } = ta.age;
          if (!isNaN(Number(MinAge))) audienceData.age.MinAge = Number(MinAge);
          if (!isNaN(Number(MaxAge))) audienceData.age.MaxAge = Number(MaxAge);
        }

        // gender
        const g = Number(ta.gender);
        if ([0, 1, 2].includes(g)) audienceData.gender = g;

        // locations: support both "locations" (array) and legacy "location" (single)
        const rawLocations = Array.isArray(ta.locations)
          ? ta.locations
          : (ta.location ? [ta.location] : []);

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

      // Parse and validate interestId if present
      if (updates.interestId) {
        let parsedInterests = updates.interestId;
        if (typeof updates.interestId === 'string') {
          try {
            parsedInterests = JSON.parse(updates.interestId);
          } catch {
            return res.status(400).json({ message: 'Invalid JSON in interestId.' });
          }
        }
        if (!Array.isArray(parsedInterests)) {
          return res.status(400).json({ message: 'interestId must be an array.' });
        }
        let validInterestIds = [];
        let interestNames = [];
        for (const id of parsedInterests) {
          if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: `Invalid interestId: ${id}` });
          }
          const interestDoc = await Interest.findById(id);
          if (!interestDoc) {
            return res.status(404).json({ message: `Interest not found: ${id}` });
          }
          validInterestIds.push(interestDoc._id);
          interestNames.push(interestDoc.name);
        }
        updates.interestId = validInterestIds;
        updates.interestName = interestNames.join(',');
      }

      // Parse timeline if present
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
        let timelineData = {};
        if (startDate) {
          const sd = new Date(startDate);
          if (!isNaN(sd)) timelineData.startDate = sd;
        }
        if (endDate) {
          const ed = new Date(endDate);
          if (!isNaN(ed)) timelineData.endDate = ed;
        }
        updates.timeline = timelineData;

        // Recompute isActive based on new timeline
        updates.isActive = computeIsActive(timelineData);
      }

      // If new image files were uploaded, overwrite `images`
      if (Array.isArray(req.files['image']) && req.files['image'].length > 0) {
        updates.images = req.files['image'].map(file => {
          return path.join('uploads', path.basename(file.path));
        });
      }

      // If new PDF files were uploaded, overwrite `creativeBrief`
      if (Array.isArray(req.files['creativeBrief']) && req.files['creativeBrief'].length > 0) {
        updates.creativeBrief = req.files['creativeBrief'].map(file => {
          return path.join('uploads', path.basename(file.path));
        });
      }

      // Perform the update
      const updatedCampaign = await Campaign.findOneAndUpdate(
        { campaignsId },
        updates,
        {
          new: true,
          runValidators: true
        }
      ).populate('interestId', 'name');

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

exports.getActiveCampaignsByBrand = async (req, res) => {
  try {
    // Extract and validate query parameters
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

    // Build the base filter
    const filter = { brandId, isActive: 1 };

    // Add text search if provided
    if (search) {
      filter.$or = [
        { brandName: { $regex: search, $options: 'i' } },
        { productOrServiceName: { $regex: search, $options: 'i' } }
      ];
    }

    // Parse pagination params
    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const skip = (pageNum - 1) * perPage;

    // Build sort object dynamically
    const sortDir = sortOrder.toLowerCase() === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDir };

    // Execute queries in parallel: paginated data and total count
    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter)
        .populate('interestId', 'name')
        .sort(sortObj)
        .skip(skip)
        .limit(perPage)
        .lean(),
      Campaign.countDocuments(filter)
    ]);

    // Calculate total pages
    const totalPages = Math.ceil(totalCount / perPage);

    // Respond with data and pagination metadata
    return res.json({
      data: campaigns,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: perPage,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error in getActiveCampaignsByBrand:', error);
    return res.status(500).json({ message: 'Internal server error while fetching active campaigns.' });
  }
};

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

    // Build filter for previous (inactive) campaigns
    const filter = { brandId, isActive: 0 };
    if (search) {
      filter.$or = [
        { brandName: { $regex: search, $options: 'i' } },
        { productOrServiceName: { $regex: search, $options: 'i' } }
      ];
    }

    // Pagination calculations
    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const skip = (pageNum - 1) * perPage;

    // Sorting
    const sortDir = sortOrder.toLowerCase() === 'asc' ? 1 : -1;
    const sortObj = { [sortBy]: sortDir };

    // Fetch data and count in parallel
    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter)
        .populate('interestId', 'name')
        .sort(sortObj)
        .skip(skip)
        .limit(perPage)
        .lean(),
      Campaign.countDocuments(filter)
    ]);

    const totalPages = Math.ceil(totalCount / perPage);
    return res.json({
      data: campaigns,
      pagination: { total: totalCount, page: pageNum, limit: perPage, totalPages }
    });
  } catch (error) {
    console.error('Error in getPreviousCampaigns:', error);
    return res.status(500).json({ message: 'Internal server error while fetching previous campaigns.' });
  }
};


exports.getActiveCampaignsByCategories = async (req, res) => {
  let {
    categoryIds,     // now an array of Interest ObjectId strings
    search,          // optional search term
    page = 1,
    limit = 10
  } = req.body;

  // 1) validate categoryIds
  if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
    return res.status(400).json({ message: 'You must provide at least one categoryId' });
  }
  // ensure all are valid ObjectId strings
  for (const c of categoryIds) {
    if (!mongoose.Types.ObjectId.isValid(c)) {
      return res.status(400).json({ message: `Invalid categoryId: ${c}` });
    }
  }

  // 2) find influencers in any of those categories
  const influencers = await Influencer
    .find({ categories: { $in: categoryIds } }, '_id')
    .lean();
  const influencerIds = influencers.map(i => i._id);
  if (influencerIds.length === 0) {
    // no influencer matches → zero campaigns
    return res.json({
      meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
      campaigns: []
    });
  }

  // 3) build campaign filter: active + influencerId IN (...)
  const filter = {
    influencerId: { $in: influencerIds },
    isActive: 1
  };

  // 4) optional search clauses
  if (search && typeof search === 'string' && search.trim()) {
    const term = search.trim();
    const or = [
      { brandName: { $regex: term, $options: 'i' } },
      { productOrServiceName: { $regex: term, $options: 'i' } }
    ];
    // also treat numeric terms as budget ceilings
    const num = Number(term);
    if (!isNaN(num)) or.push({ budget: { $lte: num } });
    filter.$or = or;
  }

  // 5) pagination
  const pageNum = Math.max(1, parseInt(page, 10));
  const limNum = Math.max(1, parseInt(limit, 10));
  const skip = (pageNum - 1) * limNum;

  try {
    // 6) fetch total & paged results
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .populate('influencerId', 'name influencerId')  // if you want influencer info
    ]);

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
    console.error('Error in getActiveCampaignsByCategories:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.checkApplied = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'campaignId and influencerId are required' });
  }

  try {
    // fetch campaign
    const campaign = await Campaign
      .findOne({ campaignsId: campaignId })
      .populate('interestId', 'name')
      .lean();
    if (!campaign) {
      return res.status(404).json({ message: 'Campaign not found.' });
    }

    // check apply‐record
    const applied = await ApplyCampaign.exists({
      campaignId,
      'applicants.influencerId': influencerId
    });

    // attach flag
    campaign.hasApplied = applied ? 1 : 0;

    return res.json(campaign);
  } catch (err) {
    console.error('Error in checkApplied:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


// controllers/influencerController.js (left here for convenience)
exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // 1) Load influencer → get categories[]
    const inf = await Influencer.findOne({ influencerId }, 'categories').lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const categories = inf.categories || [];
    if (categories.length === 0) {
      return res.json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    // 2) Build filter → interestId in categories, active only
    const filter = {
      interestId: { $in: categories },
      isActive: 1
      // Note: do NOT filter on hasApplied here; it's not a stored field.
    };
    if (search?.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }

    // 3) Pagination math
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    // 4) Count & fetch
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .lean()
    ]);

    // 5) (Optional) Fetch contract info for annotation
    const campaignIds = campaigns.map(c => c.campaignId);
    const contractRecs = await Contract.find({
      campaignId: { $in: campaignIds },
      influencerId
    }, 'campaignId contractId isAccepted').lean();

    const contractMap = new Map();
    const acceptedMap = new Map();
    contractRecs.forEach(c => {
      contractMap.set(c.campaignId, c.contractId);
      acceptedMap.set(c.campaignId, c.isAccepted === 1 ? 1 : 0);
    });

    // 6) Annotate each campaign
    const annotated = campaigns.map(c => {
      const cid = c.campaignId;
      return {
        ...c,
        hasApplied: 0,                           // can be filled via checkApplied endpoint
        hasApproved: 0,                          // fill in if you implement approvals
        isContracted: contractMap.has(cid) ? 1 : 0,
        contractId: contractMap.get(cid) || null,
        isAccepted: acceptedMap.get(cid) || 0
      };
    });

    // 7) Build pagination meta
    const totalPages = Math.ceil(total / limNum);

    // 8) Return
    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages
      },
      campaigns: annotated
    });

  } catch (err) {
    console.error('Error in getCampaignsByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.getApprovedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    // Contracts (assigned) just to get contractId/fee; approval depends on milestone ONLY
    const contracts = await Contract.find(
      { influencerId, isAssigned: 1 },
      'campaignId contractId isAccepted feeAmount'
    ).lean();

    let campaignIds = contracts.map(c => toStr(c.campaignId));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // Must have applied
    const applyRecs = await ApplyCampaign.find(
      { campaignId: { $in: campaignIds }, 'applicants.influencerId': influencerId },
      'campaignId'
    ).lean();
    const appliedIds = new Set(applyRecs.map(r => toStr(r.campaignId)));
    campaignIds = campaignIds.filter(id => appliedIds.has(id));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // KEEP ONLY those with milestone
    const milestoneIds = await milestoneSetForInfluencer(influencerId, campaignIds);
    campaignIds = campaignIds.filter(id => milestoneIds.has(id));
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // Maps
    const contractIdMap = new Map();
    const feeMap = new Map();
    const acceptedMap = new Map();
    contracts.forEach(c => {
      const cid = toStr(c.campaignId);
      if (campaignIds.includes(cid)) {
        contractIdMap.set(cid, c.contractId);
        feeMap.set(cid, c.feeAmount);
        acceptedMap.set(cid, c.isAccepted === 1 ? 1 : 0);
      }
    });

    // Search filter
    const filter = { campaignsId: { $in: campaignIds }, isActive: 1 };
    if (search?.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, raw] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .populate('interestId', 'name')
        .lean()
    ]);

    const campaigns = raw.map(c => ({
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



exports.getAppliedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    /* ------------------------------------------------------------------
       1) All campaignIds that this influencer has APPLIED to
    ------------------------------------------------------------------ */
    const applyRecs = await ApplyCampaign
      .find({ 'applicants.influencerId': influencerId }, 'campaignId')
      .lean();

    let campaignIds = applyRecs.map(r => r.campaignId);
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    /* ------------------------------------------------------------------
       2) Find any of those campaigns that NOW have a contract
          –    isAssigned === 1   → “isContracted”
          – OR isAccepted === 1   → accepted
       ------------------------------------------------------------------ */
    const contracted = await Contract.find(
      {
        influencerId,
        campaignId: { $in: campaignIds },
        $or: [{ isAssigned: 1 }, { isAccepted: 1 }]
      },
      'campaignId'
    ).lean();

    const excludedIds = new Set(contracted.map(c => c.campaignId));

    /* Remove contracted / accepted campaigns */
    campaignIds = campaignIds.filter(id => !excludedIds.has(id));
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        campaigns: []
      });
    }

    /* ------------------------------------------------------------------
       3) Build campaign filter  (search + ids)
    ------------------------------------------------------------------ */
    const filter = { campaignsId: { $in: campaignIds } };

    if (search?.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }

    /* ------------------------------------------------------------------
       4) Pagination
    ------------------------------------------------------------------ */
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    /* ------------------------------------------------------------------
       5) Fetch paged campaigns
    ------------------------------------------------------------------ */
    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .lean()
    ]);

    /* ------------------------------------------------------------------
       6) Annotate with the fixed flags
    ------------------------------------------------------------------ */
    const campaigns = rawCampaigns.map(c => ({
      ...c,
      hasApplied: 1,
      isContracted: 0,
      isAccepted: 0
    }));

    /* ------------------------------------------------------------------
       7) Respond
    ------------------------------------------------------------------ */
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
//  GET ACCEPTED CAMPAIGNS (Brand)
//      • POST  /campaign/accepted
//      • Body: { brandId, search?, page?, limit? }
// ===============================
exports.getAcceptedCampaigns = async (req, res) => {
  const { brandId, search, page = 1, limit = 10 } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    // 1) All contracts that belong to this brand AND have been accepted
    const contracts = await Contract.find(
      { brandId, isAccepted: 1 },
      'campaignId contractId influencerId feeAmount'
    ).lean();

    const campaignIds = contracts.map(c => c.campaignId);
    if (campaignIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        campaigns: []
      });
    }

    // 2) Build helper maps for easy annotation later
    const contractMap = new Map();   // campaignId → contractId
    const influencerMap = new Map();  // campaignId → influencerId
    const feeMap = new Map();  // campaignId → feeAmount
    contracts.forEach(c => {
      contractMap.set(c.campaignId, c.contractId);
      influencerMap.set(c.campaignId, c.influencerId);
      feeMap.set(c.campaignId, c.feeAmount);
    });

    // 3) Compose campaign query
    const filter = { campaignsId: { $in: campaignIds } };
    if (search?.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }

    // 4) Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    // 5) Fetch
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .populate('interestId', 'name')
        .lean()
    ]);

    // 6) Annotate
    const annotated = campaigns.map(c => {
      const cid = c.campaignsId;
      return {
        ...c,
        contractId: contractMap.get(cid),
        influencerId: influencerMap.get(cid),
        feeAmount: feeMap.get(cid),
        isAccepted: 1               // by definition
      };
    });

    // 7) Respond
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
//  GET ACCEPTED INFLUENCERS (per Campaign)
//      • POST /campaign/accepted-influencers
//      • Body: { campaignId }
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
    /* ----------------------------------------
       1) Accepted contracts for this campaign
    ----------------------------------------- */
    const contracts = await Contract.find(
      { campaignId, isAccepted: 1 },
      'influencerId contractId feeAmount'
    ).lean();

    const influencerIds = contracts.map(c => c.influencerId);
    if (influencerIds.length === 0) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        influencers: []
      });
    }

    /* ----------------------------------------
       2) Helper maps for quick annotation
    ----------------------------------------- */
    const contractMap = new Map();
    const feeMap = new Map();
    contracts.forEach(c => {
      contractMap.set(c.influencerId, c.contractId);
      feeMap.set(c.influencerId, c.feeAmount);
    });

    /* ----------------------------------------
       3) Build Influencer query filter
    ----------------------------------------- */
    const filter = { influencerId: { $in: influencerIds } };

    if (search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term, 'i');              // case-insensitive
      filter.$or = [
        { name: regex },
        { handle: regex },
        { email: regex }
      ];
    }

    /* ----------------------------------------
       4) Pagination math
    ----------------------------------------- */
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    /* ----------------------------------------
       5) Sorting
          – allow only a safe whitelist of fields
    ----------------------------------------- */
    const SORT_WHITELIST = {
      createdAt: 'createdAt',
      name: 'name',
      followerCount: 'followerCount',
      feeAmount: 'feeAmount'      // virtual, handled later
    };
    const sortField = SORT_WHITELIST[sortBy] || 'createdAt';
    const sortDir = order === 'asc' ? 1 : -1;

    /* If sorting by feeAmount (comes from Contract, not Influencer),
       we can sort after fetching, otherwise let Mongo do it.          */
    const needPostSort = sortField === 'feeAmount';
    const mongoSort = needPostSort ? {} : { [sortField]: sortDir };

    /* ----------------------------------------
       6) Fetch total & page of influencers
    ----------------------------------------- */
    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .sort(mongoSort)
        .skip(skip)
        .limit(limNum)
        .select('-passwordHash -__v')   // omit sensitive fields
        .lean()
    ]);

    /* ----------------------------------------
       7) Attach contract info  & optional post-sort
    ----------------------------------------- */
    let influencers = rawInfluencers.map(i => ({
      ...i,
      contractId: contractMap.get(i.influencerId),
      feeAmount: feeMap.get(i.influencerId),
      isAccepted: 1
    }));

    if (needPostSort) {
      influencers.sort((a, b) =>
        order === 'asc'
          ? a.feeAmount - b.feeAmount
          : b.feeAmount - a.feeAmount
      );
    }

    /* ----------------------------------------
       8) Respond
    ----------------------------------------- */
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



exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // 1) Fetch all assigned, not-rejected contracts
    const contracts = await Contract.find(
      {
        influencerId,
        isAssigned: 1,
        isRejected: { $ne: 1 }
      },
      'campaignId contractId feeAmount isAccepted'
    ).lean();

    // 2) Filter out campaigns the influencer hasn't applied to
    const campaignIds = contracts.map(c => c.campaignId.toString());
    if (!campaignIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }
    const applyRecs = await ApplyCampaign.find(
      { campaignId: { $in: campaignIds }, 'applicants.influencerId': influencerId },
      'campaignId'
    ).lean();
    const appliedSet = new Set(applyRecs.map(r => r.campaignId.toString()));
    let remainingIds = campaignIds.filter(id => appliedSet.has(id));
    if (!remainingIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // 3) Exclude those with existing milestones
    const milestoneIds = await milestoneSetForInfluencer(influencerId, remainingIds);
    remainingIds = remainingIds.filter(id => !milestoneIds.has(id));
    if (!remainingIds.length) {
      return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });
    }

    // 4) Map contract details
    const contractMap = new Map();
    contracts.forEach(c => {
      const cid = c.campaignId.toString();
      if (remainingIds.includes(cid)) {
        contractMap.set(cid, {
          contractId: c.contractId,
          feeAmount: c.feeAmount,
          isAccepted: c.isAccepted
        });
      }
    });

    // 5) Search filter and pagination
    const filter = { campaignsId: { $in: remainingIds } };
    if (search?.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .populate('interestId', 'name')
        .lean()
    ]);

    // 6) Annotate and return
    const campaigns = rawCampaigns.map(c => {
      const details = contractMap.get(c.campaignsId.toString());
      return {
        ...c,
        hasApplied: 1,
        isContracted: 1,
        isAccepted: details?.isAccepted || 0,
        hasMilestone: 0,
        contractId: details?.contractId || null,
        feeAmount: details?.feeAmount || 0,
        canAccept: details?.isAccepted === 0 // flag indicating acceptance availability
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




const ALLOWED_GOALS = ['Brand Awareness', 'Sales', 'Engagement'];
const SORT_WHITELIST = ['createdAt', 'budget', 'goal', 'brandName'];

exports.getCampaignsByFilter = async (req, res) => {
  try {
    // 1) Extract and normalize input
    const {
      interestIds = [],
      gender,
      minAge,
      maxAge,
      ageMode = 'containment', // "overlap" or "containment"
      // users can enter single or multiple country IDs
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

    // 2) Build filter
    const filter = {};

    // interest filter
    if (Array.isArray(interestIds) && interestIds.length) {
      const valid = interestIds.filter(id => mongoose.Types.ObjectId.isValid(id));
      if (valid.length) filter.interestId = { $in: valid };
    }

    // gender filter
    if ([0, 1].includes(Number(gender))) filter['targetAudience.gender'] = Number(gender);

    // age filtering
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

    // location / countryId filtering
    if (Array.isArray(countryId) && countryId.length) {
      // filter for multiple country IDs
      const validIds = countryId
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      if (validIds.length) {
        filter['targetAudience.locations'] = {
          $elemMatch: { countryId: { $in: validIds } }
        };
      }
    } else if (countryId && mongoose.Types.ObjectId.isValid(countryId)) {
      // filter for single country ID
      filter['targetAudience.locations'] = {
        $elemMatch: { countryId: new mongoose.Types.ObjectId(countryId) }
      };
    }

    // goal filter
    if (goal && ALLOWED_GOALS.includes(goal)) filter.goal = goal;

    // budget filtering
    const minB = Number(minBudget);
    const maxB = Number(maxBudget);
    if (!isNaN(minB) || !isNaN(maxB)) {
      filter.budget = {};
      if (!isNaN(minB)) filter.budget.$gte = minB;
      if (!isNaN(maxB)) filter.budget.$lte = maxB;
    }

    // free-text search
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      const or = [
        { brandName: { $regex: term, $options: 'i' } },
        { productOrServiceName: { $regex: term, $options: 'i' } },
        { interestName: { $regex: term, $options: 'i' } }
      ];
      const num = Number(term);
      if (!isNaN(num)) or.push({ budget: { $lte: num } });
      filter.$or = or;
    }

    // 3) Pagination & sorting
    const pageNum = Math.max(1, parseInt(page, 10));
    const perPage = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * perPage;

    const sortField = SORT_WHITELIST.includes(sortBy) ? sortBy : 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const sortObj = { [sortField]: sortDir };

    // 4) Execute queries
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .populate('interestId', 'name')
        .sort(sortObj)
        .skip(skip)
        .limit(perPage)
        .lean()
    ]);

    // 5) Response
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
