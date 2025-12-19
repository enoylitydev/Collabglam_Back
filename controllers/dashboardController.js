// controllers/dashboardController.js
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { JWT_SECRET } = process.env;

const Brand = require("../models/brand");
const Campaign = require("../models/campaign");
const Influencer = require("../models/influencer"); // (kept in case used elsewhere)
const Milestone = require("../models/milestone");
const Contract = require("../models/contract");
const ApplyCampaign = require("../models/applyCampaign");

const { CONTRACT_STATUS } = require("../constants/contract");

/**
 * Generic JWT verifier — populates req.user with the decoded token.
 */
exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(403).json({ message: "Token required" });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

/**
 * ✅ Robust contract guards
 * Handles isRejected/isAccepted/isAssigned stored as:
 * - number (1/0)
 * - boolean (true/false)
 * - string ("1"/"0"/"true"/"false")
 */
const REJECT_STATUSES = [
  CONTRACT_STATUS.REJECTED,
  CONTRACT_STATUS.SUPERSEDED,

  // safety for string variants coming from older data
  "REJECTED",
  "Rejected",
  "rejected",
  "SUPERSEDED",
  "Superseded",
  "superseded",
];

function notRejectedGuard() {
  return {
    $or: [
      { isRejected: { $exists: false } },
      { isRejected: null },
      { isRejected: 0 },
      { isRejected: false },
      { isRejected: "0" },
      { isRejected: "" },
      { isRejected: "false" },
    ],
  };
}

function notSupersededGuard() {
  return {
    $or: [
      { supersededBy: { $exists: false } },
      { supersededBy: null },
      { supersededBy: "" },
    ],
  };
}

function baseActiveContractGuard() {
  return {
    $and: [
      notRejectedGuard(),
      notSupersededGuard(),
      { status: { $nin: REJECT_STATUSES } },
    ],
  };
}

function acceptedContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: { $in: [1, true, "1", "true"] },
    isAccepted: { $in: [1, true, "1", "true"] },
    ...baseActiveContractGuard(),
  };
}

function pendingContractFilter(extra = {}) {
  return {
    ...extra,
    isAssigned: { $in: [1, true, "1", "true"] },
    isAccepted: { $in: [0, false, null, "0", "false", ""] },
    ...baseActiveContractGuard(),
  };
}

/**
 * Brand dashboard (basic):
 */
exports.getDashboard = async (req, res) => {
  try {
    const { brandId } = req.body || {};
    if (!brandId) return res.status(400).json({ error: "brandId is required" });

    // 1) Brand
    const brand = await Brand.findOne({ brandId }).lean();
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    // 2) All campaigns
    const campaigns = await Campaign.find({ brandId }, "campaignsId isActive").lean();

    const totalCreatedCampaigns = campaigns.length;

    const activeCampaignIds = campaigns
      .filter((c) => Number(c.isActive) === 1)
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    // 3) Total hired influencers from ACTIVE campaigns (distinct)
    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            brandId,
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);

      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 4) Total milestone influencers
    const milestoneAgg = await Milestone.aggregate([
      { $match: { brandId } },
      { $unwind: "$milestoneHistory" },
      { $group: { _id: "$milestoneHistory.influencerId" } },
      { $count: "total" },
    ]);
    const totalMilestoneInfluencers = milestoneAgg?.[0]?.total || 0;

    // 5) Budget remaining
    const milestoneDoc = await Milestone.findOne({ brandId }, "walletBalance").lean();
    const budgetRemaining = Number(milestoneDoc?.walletBalance ?? 0);

    return res.status(200).json({
      brandName: brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalMilestoneInfluencers,
      budgetRemaining,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/**
 * Influencer dashboard:
 */
exports.getDashboardInf = async (req, res) => {
  try {
    const { influencerId } = req.user || {};
    if (!influencerId) return res.status(403).json({ message: "Forbidden" });

    const now = new Date();

    // 1) Pending approvals (assigned but not accepted)
    // ✅ Won't count rejected/superseded even if isRejected is boolean true
    const pendingApprovals = await Contract.countDocuments(
      pendingContractFilter({ influencerId })
    );

    // 2) Accepted contracts (still active-valid)
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ influencerId }),
      "campaignId"
    ).lean();

    const acceptedCampaignIds = acceptedContracts
      .map((c) => String(c.campaignId || ""))
      .filter(Boolean);

    // 3) Active campaigns by timeline
    const activeCampaigns = acceptedCampaignIds.length
      ? await Campaign.countDocuments({
          campaignsId: { $in: acceptedCampaignIds },
          "timeline.startDate": { $lte: now },
          $or: [
            { "timeline.endDate": { $exists: false } },
            { "timeline.endDate": null },
            { "timeline.endDate": { $gte: now } },
          ],
        })
      : 0;

    // 4a) Total earnings (released)
    const [releasedAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": true,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    // 4b) Upcoming payouts (unreleased)
    const [upcomingAgg] = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": influencerId,
          "milestoneHistory.released": false,
        },
      },
      { $group: { _id: null, total: { $sum: "$milestoneHistory.amount" } } },
    ]);

    return res.status(200).json({
      influencerId,
      activeCampaigns,
      pendingApprovals,
      totalEarnings: releasedAgg?.total || 0,
      upcomingPayouts: upcomingAgg?.total || 0,
    });
  } catch (err) {
    console.error("Error in getDashboardInf:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getBrandDashboardHome = async (req, res) => {
  try {
    const { brandId } = req.body || {};
    if (!brandId) return res.status(400).json({ error: "brandId is required" });

    // 1) Brand
    const brand = await Brand.findOne({ brandId }, "name brandId").lean();
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    // 2) Campaigns (non-draft)
    const allCampaigns = await Campaign.find(
      { brandId, isDraft: { $ne: 1 } },
      "campaignsId productOrServiceName goal budget isActive createdAt"
    )
      .sort({ createdAt: -1 })
      .lean();

    const totalCreatedCampaigns = allCampaigns.length;

    const campaignIds = allCampaigns
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    // 3) Accepted contracts → latest per campaign
    const acceptedContracts = await Contract.find(
      acceptedContractFilter({ brandId }),
      "campaignId contractId influencerId lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const contractByCampaign = new Map();
    for (const c of acceptedContracts) {
      const key = String(c.campaignId || "");
      if (!key) continue;
      if (!contractByCampaign.has(key)) {
        contractByCampaign.set(key, {
          contractId: c.contractId || null,
          influencerId: c.influencerId || null,
        });
      }
    }

    const acceptedCampaignIds = new Set(Array.from(contractByCampaign.keys()));
    const acceptedCount = acceptedCampaignIds.size;

    // 4) Applied influencers per campaign + total sum
    const appliedCountMap = new Map();
    let totalAppliedInfluencers = 0;

    if (campaignIds.length) {
      const agg = await ApplyCampaign.aggregate([
        { $match: { campaignId: { $in: campaignIds } } },
        { $unwind: "$applicants" },

        {
          $group: {
            _id: {
              campaignId: "$campaignId",
              influencerId: "$applicants.influencerId",
            },
          },
        },
        {
          $group: {
            _id: "$_id.campaignId",
            appliedInfluencersCount: { $sum: 1 },
          },
        },
        {
          $facet: {
            perCampaign: [{ $project: { _id: 1, appliedInfluencersCount: 1 } }],
            total: [
              {
                $group: {
                  _id: null,
                  totalAppliedInfluencers: { $sum: "$appliedInfluencersCount" },
                },
              },
            ],
          },
        },
      ]);

      const perCampaign = agg?.[0]?.perCampaign || [];
      totalAppliedInfluencers = Number(agg?.[0]?.total?.[0]?.totalAppliedInfluencers || 0) || 0;

      perCampaign.forEach((row) => {
        appliedCountMap.set(String(row._id), Number(row.appliedInfluencersCount || 0));
      });
    }

    // 5) Show list rule
    const anyUnaccepted = allCampaigns.some((camp) => {
      const id = String(camp.campaignsId || "");
      return id && !acceptedCampaignIds.has(id);
    });

    const showAll = acceptedCount === 0 || anyUnaccepted;
    const campaignsMode = showAll ? "all" : "accepted";

    const baseList = showAll
      ? allCampaigns
      : allCampaigns.filter((c) => acceptedCampaignIds.has(String(c.campaignsId || "")));

    const campaigns = baseList.map((c) => {
      const id = String(c.campaignsId || "");
      const meta = contractByCampaign.get(id) || {};
      return {
        id,
        campaignsId: id,
        productOrServiceName: c.productOrServiceName || "",
        goal: c.goal || "",
        budget: Number(c.budget || 0),
        isActive: Number(c.isActive || 0),
        createdAt: c.createdAt || null,

        hasAcceptedInfluencer: acceptedCampaignIds.has(id),
        influencerId: meta.influencerId ?? null,
        contractId: meta.contractId ?? null,

        appliedInfluencersCount: appliedCountMap.get(id) || 0,
      };
    });

    // 6) Total hired influencers (distinct) from ACTIVE campaigns only
    const activeCampaignIds = allCampaigns
      .filter((c) => Number(c.isActive) === 1)
      .map((c) => String(c.campaignsId || ""))
      .filter(Boolean);

    let totalHiredInfluencers = 0;
    if (activeCampaignIds.length) {
      const hiredAgg = await Contract.aggregate([
        {
          $match: acceptedContractFilter({
            brandId,
            campaignId: { $in: activeCampaignIds },
          }),
        },
        { $group: { _id: "$influencerId" } },
        { $count: "total" },
      ]);
      totalHiredInfluencers = hiredAgg?.[0]?.total || 0;
    }

    // 7) Budget remaining
    const milestone = await Milestone.findOne({ brandId }, "walletBalance").lean();
    const budgetRemaining = Number(milestone?.walletBalance ?? 0);

    return res.status(200).json({
      brandName: brand.name || "",
      totalCreatedCampaigns,
      totalHiredInfluencers,
      totalAppliedInfluencers,
      budgetRemaining,
      campaignsMode,
      campaigns,
    });
  } catch (err) {
    console.error("getBrandDashboardHome error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
