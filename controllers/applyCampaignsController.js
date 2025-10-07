// controllers/applyCampaingsController.js

const ApplyCampaing = require('../models/applyCampaign');
const Campaign = require('../models/campaign');
const Influencer = require('../models/influencer');
const Contract = require('../models/contract');


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
    let record = await ApplyCampaing.findOne({ campaignId });
    if (!record) {
      record = new ApplyCampaing({
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


// POST /applyCampaings/list
// body: { campaignId: String }
exports.getListByCampaign = async (req, res) => {
  const {
    campaignId,
    page = 1,
    limit = 10,
    search,
    sortField,
    sortOrder = 0
  } = req.body;

  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    // 1) Application record
    const record = await ApplyCampaing.findOne({ campaignId });
    if (!record) {
      return res.status(200).json({
        meta: { total: 0, page, limit, totalPages: 0 },
        applicantCount: 0,
        isContracted: 0,
        contractId: null,
        influencers: []
      });
    }

    // 2) Build influencer filter
    const influencerIds = record.applicants.map(a => a.influencerId);
    const filter = { influencerId: { $in: influencerIds } };
    if (search?.trim()) {
      filter.name = { $regex: search.trim(), $options: 'i' };
    }

    // 3) Pagination / sorting
    const total = await Influencer.countDocuments(filter);
    const skip  = (Math.max(1, page) - 1) * Math.max(1, limit);
    let query   = Influencer.find(filter).select('-password -__v');

    if (sortField) {
      const dir = sortOrder === 1 ? -1 : 1;
      query = query.sort({ [sortField]: dir });
    }

    const influencers = await query.skip(skip).limit(Math.max(1, limit)).lean();

    // 4) Load ALL contracts for this campaign
    const contracts = await Contract.find({ campaignId }).lean();

    // campaign‑level info (optional)
    const isContractedCampaign = contracts.length > 0 ? 1 : 0;

    // Build per‑influencer maps
    const contractByInf   = new Map();
    contracts.forEach(c => contractByInf.set(c.influencerId, c));

    // Approved influencer (from ApplyCampaing doc)
    const approvedId = record.approved?.[0]?.influencerId || null;

    // 5) Annotate each influencer row
    const annotated = influencers.map(inf => {
      const c = contractByInf.get(inf.influencerId);

      const isAssigned = approvedId === inf.influencerId ? 1 : 0;
      const isContracted = c ? 1 : 0;
      const isAccepted   = c?.isAccepted === 1 ? 1 : 0;
      const isRejected   = c?.isRejected === 1 ? 1 : 0;

      return {
        ...inf,
        isAssigned,
        isContracted,
        contractId:     c?.contractId || null,
        feeAmount:      c?.feeAmount  || 0,
        isAccepted,
        isRejected,
        rejectedReason: isRejected ? (c?.rejectedReason || '') : ''
      };
    });

    return res.status(200).json({
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit)
      },
      applicantCount: record.applicants.length,
      isContracted:   isContractedCampaign,   // campaign-level flag (keep if you need it)
      contractId:     null,                   // no single global contract anymore
      influencers:    annotated
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
    const record = await ApplyCampaing.findOne({ campaignId });
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