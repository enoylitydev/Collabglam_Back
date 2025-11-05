// controllers/ApplyCampaignsController.js

const ApplyCampaign = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const Category = require('../models/categories');

async function buildSubToParentNameMap() {
  const rows = await Category.find({}, 'name subcategories').lean();
  const map = new Map();
  for (const r of rows) {
    for (const s of (r.subcategories || [])) {
      map.set(String(s.subcategoryId), r.name);
    }
  }
  return map;
}

exports.applyToCampaign = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    // ── 0) Load influencer & quota feature ────────────────────────
    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const applyFeature = inf.subscription.features.find(f => f.key === 'apply_to_campaigns_quota');
    if (!applyFeature) {
      return res.status(403).json({
        message: 'Your subscription plan does not permit campaign applications. Please upgrade.'
      });
    }

    if (applyFeature.limit > 0 && applyFeature.used >= applyFeature.limit) {
      return res.status(403).json({
        message: `Application limit reached (${applyFeature.limit}). Please upgrade your plan to apply more.`
      });
    }

    applyFeature.used += 1;
    await inf.save();

    // ── 1) record the application ──────────────────────────────────
    const name = inf.name;
    let record = await ApplyCampaign.findOne({ campaignId });
    if (!record) {
      record = new ApplyCampaign({
        campaignId,
        applicants: [{ influencerId, name }]
      });
    } else {
      if (record.applicants.some(a => a.influencerId === influencerId)) {
        return res.status(400).json({ message: 'You have already applied to this campaign' });
      }
      record.applicants.push({ influencerId, name });
    }
    await record.save();

    // ── 2) sync applicantCount + hasApplied back to Campaign ──────
    const applicantCount = record.applicants.length;
    await Campaign.findOneAndUpdate(
      { campaignsId: campaignId },
      {
        applicantCount,
        hasApplied: 1      // ← set flag on Campaign document
      }
    );

    // ── 3) respond with remaining quota ───────────────────────────
    return res.status(200).json({
      message:                'Application recorded',
      campaignId,
      applicantCount,
      applicationsRemaining:  applyFeature.limit - applyFeature.used,
      hasApplied:             1
    });

  } catch (err) {
    console.error('Error in applyToCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


// POST /ApplyCampaigns/list
// body: { campaignId: String }
exports.getListByCampaign = async (req, res) => {
  const {
    campaignId,
    page = 1,
    limit = 10,
    search,
    sortField,
    sortOrder = 0 // 0 = asc, 1 = desc
  } = req.body;

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    // 1) Application record (we’ll use its createdAt)
    const record = await ApplyCampaign.findOne({ campaignId }).lean();
    if (!record) {
      return res.status(200).json({
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
        applicantCount: 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    // 2) subcategory -> parent category name map
    const subIdToCatName = await (async function buildSubToParentNameMap() {
      const rows = await Category.find({}, 'name subcategories').lean();
      const map = new Map();
      for (const r of rows) {
        for (const s of (r.subcategories || [])) {
          map.set(String(s.subcategoryId), r.name);
        }
      }
      return map;
    })();

    // 3) Filter
    const influencerIds = record.applicants.map(a => a.influencerId);
    const filter = { influencerId: { $in: influencerIds } };
    if (search?.trim()) {
      filter.name = { $regex: search.trim(), $options: 'i' };
    }

    // 4) Fetch only needed fields (NOTE: no influencer.createdAt here)
    const projection = [
      'influencerId',
      'name',
      'primaryPlatform',
      'onboarding.categoryName',
      'onboarding.subcategories',
      'socialProfiles.provider',
      'socialProfiles.handle',
      'socialProfiles.username',
      'socialProfiles.followers'
    ].join(' ');

    const influencersRaw = await Influencer.find(filter).select(projection).lean();

    // 5) Contracts for flags
    const contracts = await Contract.find({ campaignId }).lean();
    const isContractedCampaign = contracts.length > 0 ? 1 : 0;
    const contractByInf = new Map(contracts.map(c => [String(c.influencerId), c]));
    const approvedId = record.approved?.[0]?.influencerId || null;

    // Helper: choose profile for handle
    function pickProfileForHandle(profiles = [], primary) {
      if (!Array.isArray(profiles) || profiles.length === 0) return null;
      if (primary) {
        const hit = profiles.find(p => p?.provider === primary);
        if (hit) return hit;
      }
      return profiles
        .slice()
        .sort((a, b) => (Number(b?.followers) || 0) - (Number(a?.followers) || 0))[0] || null;
    }

    // 6) Shape response rows — use ApplyCampaign.createdAt
    const applicationCreatedAt = record.createdAt || record._id?.getTimestamp?.() || null;

    const condensed = influencersRaw.map(inf => {
      // category name
      let categoryName = inf?.onboarding?.categoryName || '';
      if (!categoryName && Array.isArray(inf?.onboarding?.subcategories)) {
        for (const s of inf.onboarding.subcategories) {
          const cat = subIdToCatName.get(String(s?.subcategoryId));
          if (cat) { categoryName = cat; break; }
        }
      }

      // audience size
      const audienceSize = Array.isArray(inf.socialProfiles)
        ? inf.socialProfiles.reduce((sum, p) => sum + (Number(p?.followers) || 0), 0)
        : 0;

      // handle
      const chosen = pickProfileForHandle(inf.socialProfiles, inf.primaryPlatform);
      let handle = (chosen?.handle || chosen?.username || '').trim() || null;
      if (handle && !handle.startsWith('@')) handle = '@' + handle;

      // contract flags
      const c = contractByInf.get(String(inf.influencerId));
      const isAssigned   = approvedId === inf.influencerId ? 1 : 0;
      const isContracted = c ? 1 : 0;
      const isAccepted   = c?.isAccepted === 1 ? 1 : 0;
      const isRejected   = c?.isRejected === 1 ? 1 : 0;

      return {
        influencerId: inf.influencerId,
        name: inf.name || '',
        primaryPlatform: inf.primaryPlatform || null,
        handle,
        category: categoryName || null,
        audienceSize,
        createdAt: applicationCreatedAt, // 👈 use ApplyCampaign.createdAt

        isAssigned,
        isContracted,
        contractId: c?.contractId || null,
        feeAmount: c?.feeAmount || 0,
        isAccepted,
        isRejected,
        rejectedReason: isRejected ? (c?.rejectedReason || '') : ''
      };
    });

    // 7) Sorting (supports createdAt)
    const dir = sortOrder === 1 ? -1 : 1;
    if (sortField) {
      const allowed = new Set(['name', 'primaryPlatform', 'category', 'audienceSize', 'handle', 'createdAt']);
      if (allowed.has(sortField)) {
        condensed.sort((a, b) => {
          const av = a[sortField];
          const bv = b[sortField];

          if (sortField === 'createdAt') {
            const ta = av ? new Date(av).getTime() : 0;
            const tb = bv ? new Date(bv).getTime() : 0;
            return dir * (ta - tb);
          }
          if (typeof av === 'number' && typeof bv === 'number') {
            return dir * (av - bv);
          }
          return dir * String(av ?? '').localeCompare(String(bv ?? ''));
        });
      }
    }

    // 8) Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum  = Math.max(1, parseInt(limit, 10));
    const start   = (pageNum - 1) * limNum;
    const end     = start + limNum;

    const total = condensed.length;
    const paged = condensed.slice(start, end);

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      applicantCount: record.applicants.length,
      isContracted: isContractedCampaign,
      contractId: null,
      influencers: paged
    });

  } catch (err) {
    console.error("Error in getListByCampaign:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};





exports.approveInfluencer = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    const record = await ApplyCampaign.findOne({ campaignId });
    if (!record) {
      return res.status(404).json({ message: 'No applications found for this campaign' });
    }

    const applicant = record.applicants.find(a => a.influencerId === influencerId);
    if (!applicant) {
      return res.status(400).json({ message: 'Influencer did not apply for this campaign' });
    }

    if (record.approved && record.approved.length > 0) {
      return res.status(400).json({ message: 'An influencer is already approved for this campaign' });
    }

    record.approved = [{ influencerId: applicant.influencerId, name: applicant.name }];
    await record.save();

    return res.status(200).json({
      message: 'Influencer approved successfully',
      campaignId,
      approved: record.approved[0]
    });
  } catch (err) {
    console.error('Error in approveInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};