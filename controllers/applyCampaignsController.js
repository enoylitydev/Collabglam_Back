// controllers/ApplyCampaignsController.js

const ApplyCampaign = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');
const Category = require('../models/categories');
const { createAndEmit } = require('../utils/notifier');

const ACTIVE_CONTRACT_STATUSES = [
  'draft', 'sent', 'viewed', 'negotiation', 'finalize', 'signing', 'locked', 'rejected'
];

// Optional socket.io emitters if app has them set
function getEmitter(req, key) {
  try { return req.app?.get?.(key) || (() => { }); } catch { return () => { }; }
}

async function countActiveCollaborationsForInfluencer(influencerId) {
  return Contract.countDocuments({
    influencerId: String(influencerId),
    isRejected: { $ne: 1 },
    $or: [
      { isAssigned: 1 },
      { isAccepted: 1 },
      { status: { $in: ACTIVE_CONTRACT_STATUSES } }
    ]
  });
}

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

async function ensureMonthlyWindow(influencerId, featureKey, featureObj) {
  const isMonthly = /per\s*month/i.test(String(featureObj?.note || '')) || featureObj?.resetsEvery === 'monthly';
  if (!isMonthly) return featureObj;

  const now = new Date();
  const resetsAt = featureObj?.resetsAt ? new Date(featureObj.resetsAt) : null;

  // If never set, or already past, roll a new monthly window and zero usage
  if (!resetsAt || now > resetsAt) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);

    await Influencer.updateOne(
      { influencerId, 'subscription.features.key': featureKey },
      {
        $set: {
          'subscription.features.$.used': 0,
          'subscription.features.$.resetsAt': next
        }
      }
    );

    return { ...featureObj, used: 0, resetsAt: next };
  }
  return featureObj;
}

function readLimit(f) {
  const raw = f?.limit ?? f?.value ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * POST /apply
 * Body: { campaignId, influencerId }
 * - Records application
 * - Increments influencer plan usage (apply_to_campaigns_quota)
 * - Updates Campaign applicantCount & hasApplied
 * - Sends:
 *    • Brand notification (apply.submitted) + socket push
 *    • Influencer receipt notification (apply.submitted.self)
 */
exports.applyToCampaign = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    // 0) Influencer & feature checks
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    let applyFeature = (inf.subscription?.features || []).find(f => f.key === 'apply_to_campaigns_quota');
    if (!applyFeature) {
      return res.status(403).json({
        message: 'Your subscription plan does not permit campaign applications. Please upgrade.'
      });
    }
    applyFeature = await ensureMonthlyWindow(influencerId, 'apply_to_campaigns_quota', applyFeature);
    const applyLimit = readLimit(applyFeature); // 0 => unlimited
    if (applyLimit > 0 && Number(applyFeature.used || 0) >= applyLimit) {
      return res.status(403).json({
        message: `Application limit reached (${applyLimit}). Please upgrade your plan to apply more.`
      });
    }

    // (Suggested) Also gate on active collaborations cap before letting them apply
    const activeCapFeature = (inf.subscription?.features || []).find(f => f.key === 'active_collaborations_limit');
    const activeCap = readLimit(activeCapFeature);
    if (activeCap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= activeCap) {
        return res.status(403).json({
          message: `You’ve reached your active collaborations limit (${activeCap}). Finish/close one or upgrade your plan.`
        });
      }
    }

    // 1) Create/update application (dedupe)
    let record = await ApplyCampaign.findOne({ campaignId }).lean();
    if (record?.applicants?.some(a => String(a.influencerId) === String(influencerId))) {
      return res.status(400).json({ message: 'You have already applied to this campaign' });
    }

    if (!record) {
      await ApplyCampaign.create({
        campaignId,
        applicants: [{ influencerId, name: inf.name || '' }]
      });
    } else {
      await ApplyCampaign.updateOne(
        { campaignId },
        { $push: { applicants: { influencerId, name: inf.name || '' } } }
      );
    }

    // 2) Increment influencer quota usage
    await Influencer.updateOne(
      { influencerId },
      { $inc: { 'subscription.features.$[feat].used': 1 } },
      { arrayFilters: [{ 'feat.key': 'apply_to_campaigns_quota' }] }
    );

    // 3) Sync applicantCount + hasApplied on Campaign
    const fresh = await ApplyCampaign.findOne({ campaignId }, 'applicants').lean();
    const applicantCount = fresh?.applicants?.length || 0;

    await Campaign.findOneAndUpdate(
      { campaignsId: campaignId },
      { $set: { applicantCount, hasApplied: 1 } }
    );

    // 4) Campaign basic data
    const camp = await Campaign
      .findOne({ campaignsId: campaignId }, 'campaignsId brandId brandName productOrServiceName')
      .lean();

    // 5A) ✅ Notify brand (persist + live)
    if (camp?.brandId) {
      try {
        await createAndEmit({
          recipientType: 'brand',
          brandId: String(camp.brandId),
          type: 'apply.submitted',
          title: `New applicant: ${inf.name || 'Influencer'}`,
          message: `${inf.name || 'An influencer'} applied to "${camp.productOrServiceName || 'your campaign'}".`,
          entityType: 'apply',
          entityId: String(campaignId),
          actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
          meta: {
            influencerId,
            influencerName: inf.name || '',
            applicantCount
          }
        });
      } catch (e) {
        console.warn('createAndEmit failed (brand apply.submitted):', e?.message || e);
      }

      // Socket.IO (best-effort)
      const emitToBrand = getEmitter(req, 'emitToBrand');
      try {
        emitToBrand(String(camp.brandId), 'application:new', {
          campaignId: String(camp.campaignsId),
          brandId: String(camp.brandId),
          title: camp.productOrServiceName || '',
          applicant: { influencerId, name: inf.name || '' },
          applicantCount,
          actionPath: `/brand/campaigns/${campaignId}/applicants`
        });
      } catch (e) {
        console.warn('emitToBrand failed:', e?.message || e);
      }
    }

    // 5B) ✅ Notify influencer (receipt) — appears in their bell immediately
    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.submitted.self',
        title: `Application sent`,
        message: `You applied to "${camp?.productOrServiceName || 'Campaign'}" by ${camp?.brandName || 'Brand'}.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/dashboard/view-campaign?id=${campaignId}`,
        meta: {
          brandId: camp?.brandId || null,
          brandName: camp?.brandName || '',
          productOrServiceName: camp?.productOrServiceName || ''
        }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.submitted.self):', e?.message || e);
    }

    const newUsed = Number(applyFeature.used || 0) + 1;
    return res.status(200).json({
      message: 'Application recorded',
      campaignId,
      applicantCount,
      applicationsRemaining: (applyLimit > 0)
        ? Math.max(0, applyLimit - newUsed)
        : 0,
      hasApplied: 1
    });
  } catch (err) {
    console.error('Error in applyToCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /ApplyCampaigns/list — body: { campaignId, ...pagination/sort }
exports.getListByCampaign = async (req, res) => {
  const {
    campaignId,
    page = 1,
    limit = 10,
    search,
    sortField,
    sortOrder = 0 // 0 = asc, 1 = desc
  } = req.body || {};

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
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

    const subIdToCatName = await buildSubToParentNameMap();

    const influencerIds = record.applicants.map(a => a.influencerId);
    const filter = { influencerId: { $in: influencerIds } };
    if (search?.trim()) filter.name = { $regex: search.trim(), $options: 'i' };

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

    const contracts = await Contract.find({ campaignId }).lean();
    const isContractedCampaign = contracts.length > 0 ? 1 : 0;
    const contractByInf = new Map(contracts.map(c => [String(c.influencerId), c]));
    const approvedId = record.approved?.[0]?.influencerId || null;

    function pickProfileForHandle(profiles = [], primary) {
      if (!Array.isArray(profiles) || profiles.length === 0) return null;
      if (primary) {
        const hit = profiles.find(p => p?.provider === primary);
        if (hit) return hit;
      }
      return profiles.slice()
        .sort((a, b) => (Number(b?.followers) || 0) - (Number(a?.followers) || 0))[0] || null;
    }

    const applicationCreatedAt = record.createdAt || record._id?.getTimestamp?.() || null;

    const condensed = influencersRaw.map(inf => {
      let categoryName = inf?.onboarding?.categoryName || '';
      if (!categoryName && Array.isArray(inf?.onboarding?.subcategories)) {
        for (const s of inf.onboarding.subcategories) {
          const cat = subIdToCatName.get(String(s?.subcategoryId));
          if (cat) { categoryName = cat; break; }
        }
      }

      const audienceSize = Array.isArray(inf.socialProfiles)
        ? inf.socialProfiles.reduce((sum, p) => sum + (Number(p?.followers) || 0), 0)
        : 0;

      const chosen = pickProfileForHandle(inf.socialProfiles, inf.primaryPlatform);
      let handle = (chosen?.handle || chosen?.username || '').trim() || null;
      if (handle && !handle.startsWith('@')) handle = '@' + handle;

      const c = contractByInf.get(String(inf.influencerId));
      const isAssigned = approvedId === inf.influencerId ? 1 : 0;
      const isContracted = c ? 1 : 0;
      const isAccepted = c?.isAccepted === 1 ? 1 : 0;
      const isRejected = c?.isRejected === 1 ? 1 : 0;

      return {
        influencerId: inf.influencerId,
        name: inf.name || '',
        primaryPlatform: inf.primaryPlatform || null,
        handle,
        category: categoryName || null,
        audienceSize,
        createdAt: applicationCreatedAt,

        isAssigned,
        isContracted,
        contractId: c?.contractId || null,
        feeAmount: c?.feeAmount || 0,
        isAccepted,
        isRejected,
        rejectedReason: isRejected ? (c?.rejectedReason || '') : ''
      };
    });

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

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const start = (pageNum - 1) * limNum;
    const end = start + limNum;

    const total = condensed.length;
    const paged = condensed.slice(start, end);

    return res.status(200).json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      applicantCount: record.applicants.length,
      isContracted: isContractedCampaign,
      contractId: null,
      influencers: paged
    });

  } catch (err) {
    console.error('Error in getListByCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /ApplyCampaigns/approve
 * Body: { campaignId, influencerId }
 * - Marks the influencer as approved in ApplyCampaign
 * - Notifies influencer
 */
exports.approveInfluencer = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) {
    return res.status(400).json({ message: 'Both campaignId and influencerId are required' });
  }

  try {
    const inf = await Influencer.findOne({ influencerId }).lean();
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });
    const activeCapFeature = (inf.subscription?.features || []).find(f => f.key === 'active_collaborations_limit');
    const activeCap = readLimit(activeCapFeature);
    if (activeCap > 0) {
      const activeNow = await countActiveCollaborationsForInfluencer(influencerId);
      if (activeNow >= activeCap) {
        return res.status(403).json({
          message: `Cannot approve — influencer already has ${activeNow}/${activeCap} active collaborations.`
        });
      }
    }

    const record = await ApplyCampaign.findOne({ campaignId });
    if (!record) {
      return res.status(404).json({ message: 'No applications found for this campaign' });
    }

    const applicant = record.applicants.find(a => String(a.influencerId) === String(influencerId));
    if (!applicant) {
      return res.status(400).json({ message: 'Influencer did not apply for this campaign' });
    }

    if (record.approved && record.approved.length > 0) {
      return res.status(400).json({ message: 'An influencer is already approved for this campaign' });
    }

    record.approved = [{ influencerId: applicant.influencerId, name: applicant.name }];
    await record.save();

    // Notify influencer
    const camp = await Campaign.findOne(
      { campaignsId: campaignId },
      'campaignsId productOrServiceName brandName brandId'
    ).lean();

    try {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'apply.approved',
        title: `Approved for "${camp?.productOrServiceName || 'Campaign'}"`,
        message: `Brand ${camp?.brandName || ''} approved your application.`,
        entityType: 'campaign',
        entityId: String(campaignId),
        actionPath: `/influencer/campaigns/${campaignId}`,
        meta: { brandId: camp?.brandId || null }
      });
    } catch (e) {
      console.warn('createAndEmit failed (influencer apply.approved):', e?.message || e);
    }

    // Socket.IO (best-effort)
    const emitToInfluencer = getEmitter(req, 'emitToInfluencer');
    try {
      emitToInfluencer(String(influencerId), 'application:approved', {
        campaignId: String(campaignId),
        title: camp?.productOrServiceName || '',
        brandName: camp?.brandName || '',
        actionPath: `/influencer/campaigns/${campaignId}`
      });
    } catch (e) {
      console.warn('emitToInfluencer failed:', e?.message || e);
    }

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
