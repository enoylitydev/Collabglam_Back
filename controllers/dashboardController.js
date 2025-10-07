// controllers/dashboardController.js
require('dotenv').config();
const jwt         = require('jsonwebtoken');
const { JWT_SECRET } = process.env;
const mongoose   = require('mongoose');  
const Brand       = require('../models/brand');
const Campaign    = require('../models/campaign');
const Influencer  = require('../models/influencer');
const Milestone   = require('../models/milestone');
const Contract   = require('../models/contract');


/**
 * Generic JWT verifier — populates req.user with the decoded token.
 */

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(403).json({ message: 'Token required' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};


/**
 * Brand dashboard:
 * - Requires req.user.brandId === body.brandId
 */
exports.getDashboard = async (req, res) => {
  try {
    const { brandId } = req.body || {};

    // 1) Fetch brand name
    const brand = await Brand.findOne({ brandId });
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // 2) Count active campaigns
    const totalActiveCampaigns = await Campaign.countDocuments({
      brandId,
      isActive: 1
    });

    // 3) Total influencers
    const totalInfluencers = await Influencer.countDocuments();

    // 4) Budget remaining
    const milestone = await Milestone.findOne({ brandId });
    const budgetRemaining = milestone?.walletBalance ?? 0;

    return res.status(200).json({
      brandName:            brand.name,
      totalActiveCampaigns,
      totalInfluencers,
      budgetRemaining
    });

  } catch (err) {
    console.error('Dashboard error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};


/**
 * Influencer dashboard:
 * - Requires req.user.influencerId === body.influencerId
 */
exports.getDashboardInf = async (req, res) => {
  try {
    /* 0. Auth-guard */
    const { influencerId } = req.user || {};
    if (!influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    /* 1. Convenience dates */
    const now              = new Date();
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    /* 2. Pending approvals  = contracts *assigned* but not yet accepted */
    const pendingApprovals = await Contract.countDocuments({
      influencerId,
      isAssigned: 1,
      isAccepted: 0
    });

    /* 3. Accepted contracts → decide “active” by campaign timeline */
    const acceptedContracts = await Contract.find(
      { influencerId, isAccepted: 1 },
      'campaignId'
    ).lean();

    const activeCampaigns = await Campaign.countDocuments({
      campaignsId: { $in: acceptedContracts.map(c => c.campaignId) },
      'timeline.startDate': { $lte: now },
      $or: [
        { 'timeline.endDate': { $exists: false } },
        { 'timeline.endDate': { $gte: now } }
      ]
    });

    /* 4a. Total earnings from all released milestones */
    const [releasedAgg] = await Milestone.aggregate([
      { $unwind: '$milestoneHistory' },
      { $match: {
          'milestoneHistory.influencerId': influencerId,
          'milestoneHistory.released': true
      }},
      { $group: { _id: null, total: { $sum: '$milestoneHistory.amount' } } }
    ]);

    /* 4b. Upcoming payouts = sum of all _unreleased_ milestones */
    const [upcomingAgg] = await Milestone.aggregate([
      { $unwind: '$milestoneHistory' },
      { $match: {
          'milestoneHistory.influencerId': influencerId,
          'milestoneHistory.released': false
      }},
      { $group: { _id: null, total: { $sum: '$milestoneHistory.amount' } } }
    ]);

    const totalEarnings   = releasedAgg?.total   || 0;
    const upcomingPayouts = upcomingAgg?.total   || 0;

    /* 5. Response */
    return res.status(200).json({
      influencerId,
      activeCampaigns,
      pendingApprovals,
      totalEarnings,
      upcomingPayouts
    });

  } catch (err) {
    console.error('Error in getDashboardInf:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};