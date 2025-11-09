// controllers/milestoneController.js
const Milestone = require('../models/milestone');
const Campaign = require('../models/campaign');
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
        .map(e => ({
          ...e,
          brandId: doc.brandId,
          milestoneId: doc.milestoneId,
          walletBalance: doc.walletBalance
        }))
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

    doc.walletBalance -= entry.amount;
    entry.released = true;
    entry.releasedAt = new Date();

    await doc.save();

    // Notifications (non-blocking)
    // Influencer → campaign view
    createAndEmit({
      influencerId: entry.influencerId,
      type: 'milestone.released',
      title: `Milestone released${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ''}`,
      message: `You received $${Number(entry.amount).toFixed(2)}.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch(e => console.error('notify influencer (released) failed:', e));

    // Brand → milestone history
    createAndEmit({
      brandId: doc.brandId,
      type: 'milestone.released',
      title: `Released $${Number(entry.amount).toFixed(2)}`,
      message: `${entry.milestoneTitle || 'Milestone'} marked as released.`,
      entityType: 'campaign',
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch(e => console.error('notify brand (released) failed:', e));

    return res.status(200).json({
      message: 'Milestone released successfully.',
      releasedAmount: entry.amount
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
        .filter(e => e.influencerId === influencerId && e.released)
        .forEach(e => { totalPaid += e.amount; });
    });
    return res.json({ influencerId, totalPaid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
