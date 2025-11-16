// controllers/milestoneController.js
const Milestone = require('../models/milestone');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');           // 👈 NEW
const Influencer = require('../models/influencer'); // 👈 NEW
const { createAndEmit } = require('../utils/notifier'); // ⬅️ use centralized notifier

// POST /milestone/create
// body: { brandId, influencerId, campaignId, milestoneTitle, amount, milestoneDescription }
exports.createMilestone = async (req, res) => {
  const {
    brandId,
    influencerId,
    campaignId,
    milestoneTitle,
    amount,
    milestoneDescription = ''
  } = req.body;

  const amountNum = Number(amount);
  if (isNaN(amountNum)) {
    return res.status(400).json({ message: 'amount must be a valid number' });
  }
  if (!brandId || !influencerId || !campaignId || !milestoneTitle || amount == null) {
    return res.status(400).json({
      message: 'brandId, influencerId, campaignId, milestoneTitle and amount are required'
    });
  }

  try {
    // 1) Verify the campaign exists
    const camp = await Campaign.findOne({ campaignsId: campaignId });
    if (!camp) {
      return res.status(404).json({ message: 'Campaign not found' });
    }

    // 2) Find or create the brand’s Milestone document
    let doc = await Milestone.findOne({ brandId });
    if (!doc) {
      doc = new Milestone({ brandId });
    }

    // 2a) Check previous milestone for this influencer+campaign
    const prev = doc.milestoneHistory
      .filter(e => e.influencerId === influencerId && e.campaignId === campaignId);

    if (prev.length > 0) {
      prev.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const last = prev[0];
      if (!last.released) {
        return res.status(400).json({
          message: 'Cannot create new milestone until the previous milestone is released'
        });
      }
    }

    // 3) Append a new history entry
    const entry = {
      influencerId,
      campaignId,
      milestoneTitle,
      amount: amountNum,
      milestoneDescription,
      released: false,
      createdAt: new Date()
    };
    doc.milestoneHistory.push(entry);

    // 4) Update walletBalance
    doc.walletBalance = (doc.walletBalance || 0) + amountNum;

    // 5) Save
    await doc.save();

    // 6) Notifications (non-blocking)
    // Influencer → campaign view
    createAndEmit({
      influencerId,
      type: 'milestone.created',
      title: `New milestone: ${milestoneTitle}`,
      message: `An amount of $${amountNum.toFixed(2)} was created for this campaign.`,
      entityType: 'campaign',
      entityId: String(campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch(e => console.error('notify influencer (created) failed:', e));

    // Brand → milestone history
    createAndEmit({
      brandId,
      type: 'milestone.created',
      title: `Milestone created for influencer ${influencerId}`,
      message: `${milestoneTitle} • $${amountNum.toFixed(2)}`,
      entityType: 'campaign',
      entityId: String(campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch(e => console.error('notify brand (created) failed:', e));

    // 7) Respond
    return res.status(201).json({
      message: 'Milestone created',
      milestoneId: doc.milestoneId,
      walletBalance: doc.walletBalance,
      entry
    });
  } catch (err) {
    console.error('Error in createMilestone:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /milestone/listByCampaign
// body: { campaignId }
exports.getMilestonesByCampaign = async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).json({ message: 'campaignId is required' });
  }

  try {
    const docs = await Milestone.find({ 'milestoneHistory.campaignId': campaignId }).lean();

    const entries = docs.flatMap(doc =>
      doc.milestoneHistory
        .filter(e => e.campaignId === campaignId)
        .map(e => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
          walletBalance: doc.walletBalance
        }))
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by campaign',
      milestones: entries
    });
  } catch (err) {
    console.error('Error in getMilestonesByCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/listByInfluencerAndCampaign
 * body: { influencerId, campaignId }
 */
exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  const { influencerId, campaignId } = req.body;
  if (!influencerId || !campaignId) {
    return res.status(400).json({ message: 'influencerId and campaignId are required' });
  }

  try {
    const docs = await Milestone.find({
      'milestoneHistory.influencerId': influencerId,
      'milestoneHistory.campaignId': campaignId
    }).lean();

    const entries = docs.flatMap(doc =>
      doc.milestoneHistory
        .filter(e => e.influencerId === influencerId && e.campaignId === campaignId)
        .map(e => {
          // --------- Derive influencer-facing payout status ---------
          // If you already added a field like `payoutStatus` on each entry
          // (set by adminMarkMilestonePaid), we prefer that.
          let payoutStatus = e.payoutStatus;

          // Fallback logic if not explicitly stored:
          // - Not released at all  -> "pending"
          // - Released by brand    -> "initiated"
          // - Admin later should set `payoutStatus: 'paid'`
          if (!payoutStatus) {
            if (!e.released) {
              payoutStatus = 'pending';
            } else {
              // brand has released; waiting for admin
              payoutStatus = 'initiated';
            }
          }

          return {
            ...e,
            payoutStatus,               // 👈 use this on influencer UI
            brandId: doc.brandId,
            milestoneId: doc.milestoneId,
            walletBalance: doc.walletBalance
          };
        })
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by influencer and campaign',
      milestones: entries
    });
  } catch (err) {
    console.error('Error in getMilestonesByInfluencerAndCampaign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/listByInfluencer
 * body: { influencerId }
 */
exports.getMilestonesByInfluencer = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    const docs = await Milestone.find({ 'milestoneHistory.influencerId': influencerId }).lean();

    const entries = docs.flatMap(doc =>
      doc.milestoneHistory
        .filter(e => e.influencerId === influencerId)
        .map(e => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
          walletBalance: doc.walletBalance
        }))
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by influencer',
      milestones: entries
    });
  } catch (err) {
    console.error('Error in getMilestonesByInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /milestone/listByBrand
 * body: { brandId }
 */
exports.getMilestonesByBrand = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    const doc = await Milestone.findOne({ brandId }).lean();
    if (!doc) {
      return res.status(200).json({
        message: 'No milestones found for this brand',
        milestones: []
      });
    }

    const entries = doc.milestoneHistory.map(e => ({
      ...e,
      brandId: doc.brandId,
      milestoneId: doc.milestoneId,
      walletBalance: doc.walletBalance
    }));

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: 'Milestones fetched by brand',
      milestones: entries
    });
  } catch (err) {
    console.error('Error in getMilestonesByBrand:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /milestone/balance
// body: { brandId }
exports.getWalletBalance = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    const doc = await Milestone.findOne({ brandId }).lean();
    const balance = doc ? doc.walletBalance : 0;
    return res.status(200).json({
      message: 'Wallet balance fetched',
      brandId,
      balance
    });
  } catch (err) {
    console.error('Error in getWalletBalance:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /milestone/release
// body: { milestoneId, milestoneHistoryId }
exports.releaseMilestone = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;
  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({ message: 'milestoneId and milestoneHistoryId are required.' });
  }

  try {
    const doc = await Milestone.findOne({ milestoneId });
    if (!doc) {
      return res.status(404).json({ message: 'Milestone not found.' });
    }

    const entry = doc.milestoneHistory.find(h => h.milestoneHistoryId === milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: 'Milestone history entry not found.' });
    }
    if (entry.released) {
      return res.status(400).json({ message: 'This milestone has already been released.' });
    }

    // brand releases funds from its wallet
    doc.walletBalance -= entry.amount;
    entry.released = true;
    entry.releasedAt = new Date();

    // NEW: admin flow → mark payout as INITIATED
    entry.payoutStatus = 'initiated';

    await doc.save();

    // Notifications (non-blocking)
    // Influencer → they see "Initiated"
    createAndEmit({
      influencerId: entry.influencerId,
      type: 'milestone.initiated',
      title: `Milestone payout initiated${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''}`,
      message: `Brand has released $${Number(entry.amount).toFixed(2)} for this campaign. `
        + `It should be received within 24 - 48 hrs.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch(e => console.error('notify influencer (initiated) failed:', e));

    // Brand → they see release in their own history
    createAndEmit({
      brandId: doc.brandId,
      type: 'milestone.released',
      title: `Milestone released${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''}`,
      message: `You released $${Number(entry.amount).toFixed(2)} for this campaign.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch(e => console.error('notify brand (released) failed:', e));

    return res.status(200).json({
      message: 'Milestone released successfully (payout initiated).',
      releasedAmount: entry.amount,
      payoutStatus: entry.payoutStatus
    });
  } catch (err) {
    console.error('Error in releaseMilestone:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// POST /milestone/paidTotal
// body: { influencerId }
exports.getInfluencerPaidTotal = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required.' });
  }
  try {
    const docs = await Milestone.find({ 'milestoneHistory.influencerId': influencerId });
    let totalPaid = 0;
    docs.forEach(d => {
      d.milestoneHistory
        .filter(e =>
          e.influencerId === influencerId &&
          e.payoutStatus === 'paid'          // 👈 changed
        )
        .forEach(e => { totalPaid += e.amount; });
    });
    return res.json({ influencerId, totalPaid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};


exports.adminListPayouts = async (req, res) => {
  try {
    // status can be: "all" | "initiated" | "paid" | ["initiated","paid",...]
    const {
      status = 'all',
      page = 1,
      limit = 20,
    } = req.body || {};

    const pageNum = Number(page) || 1;
    const limitNum = Math.max(1, Number(limit) || 20);

    // Normalize status into either "all" or an array of strings
    let statusFilter;
    if (
      status === 'all' ||
      status === undefined ||
      status === null ||
      status === ''
    ) {
      statusFilter = 'all';
    } else if (Array.isArray(status)) {
      statusFilter = status.map(String);
    } else {
      statusFilter = [String(status)];
    }

    const baseQuery = { 'milestoneHistory.released': true };
    const docs = await Milestone.find(baseQuery).lean();

    let entries = docs.flatMap(doc =>
      doc.milestoneHistory
        .filter(e => e.released)
        .map(e => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
        }))
    );

    // If statusFilter is not "all", filter by payoutStatus
    if (statusFilter !== 'all') {
      entries = entries.filter(e =>
        statusFilter.includes(e.payoutStatus || 'initiated')
      );
    }

    // latest first
    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = entries.length;
    const totalPages = Math.ceil(total / limitNum);
    const start = (pageNum - 1) * limitNum;
    const dataPage = entries.slice(start, start + limitNum);

    // collect ids for lookups
    const brandIds = [...new Set(dataPage.map(e => e.brandId))];
    const influencerIds = [...new Set(dataPage.map(e => e.influencerId))];
    const campaignIds = [...new Set(dataPage.map(e => e.campaignId))];

    const [brands, influencers, campaigns] = await Promise.all([
      Brand.find({ brandId: { $in: brandIds } }, 'brandId name').lean(),
      Influencer.find(
        { influencerId: { $in: influencerIds } },
        'influencerId name email'
      ).lean(),
      Campaign.find(
        { campaignsId: { $in: campaignIds } },
        'campaignsId productOrServiceName'
      ).lean(),
    ]);

    const brandMap = new Map(brands.map(b => [b.brandId, b.name]));
    const influencerMap = new Map(
      influencers.map(i => [i.influencerId, { name: i.name, email: i.email }])
    );
    const campaignMap = new Map(
      campaigns.map(c => [c.campaignsId, c.productOrServiceName])
    );

    const items = dataPage.map(e => {
      const inf = influencerMap.get(e.influencerId) || {};
      return {
        milestoneId: e.milestoneId,
        milestoneHistoryId: e.milestoneHistoryId,
        brandId: e.brandId,
        brandName: brandMap.get(e.brandId) || null,
        influencerId: e.influencerId,
        influencerName: inf.name || null,
        influencerEmail: inf.email || null,
        campaignId: e.campaignId,
        campaignTitle: campaignMap.get(e.campaignId) || null,
        amount: e.amount,
        payoutStatus: e.payoutStatus,   // "initiated" | "paid"
        releasedAt: e.releasedAt,
        createdAt: e.createdAt,
      };
    });

    return res.status(200).json({
      message: 'Milestone payouts for admin',
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      items,
    });
  } catch (err) {
    console.error('Error in adminListPayouts:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};




exports.adminMarkMilestonePaid = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: 'milestoneId and milestoneHistoryId are required.'
    });
  }

  try {
    const doc = await Milestone.findOne({ milestoneId });
    if (!doc) {
      return res.status(404).json({ message: 'Milestone not found.' });
    }

    const entry = doc.milestoneHistory.find(h => h.milestoneHistoryId === milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: 'Milestone history entry not found.' });
    }

    if (!entry.released) {
      return res.status(400).json({ message: 'Milestone not released yet.' });
    }

    if (entry.payoutStatus === 'paid') {
      return res.status(400).json({ message: 'This milestone is already marked as paid.' });
    }

    entry.payoutStatus = 'paid';
    entry.paidAt = new Date();

    await doc.save();

    // notify influencer → PAID
    createAndEmit({
      influencerId: entry.influencerId,
      type: 'milestone.paid',
      title: `Milestone paid${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''}`,
      message: `Your payout of $${Number(entry.amount).toFixed(2)} has been approved and marked as paid.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch(e => console.error('notify influencer (paid) failed:', e));

    // notify brand
    createAndEmit({
      brandId: doc.brandId,
      type: 'milestone.paid',
      title: `Payout completed`,
      message: `${entry.milestoneTitle || 'Milestone'} of $${Number(entry.amount).toFixed(2)} has been marked as paid.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch(e => console.error('notify brand (paid) failed:', e));

    return res.status(200).json({
      message: 'Milestone marked as paid.',
      payoutStatus: entry.payoutStatus
    });
  } catch (err) {
    console.error('Error in adminMarkMilestonePaid:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
