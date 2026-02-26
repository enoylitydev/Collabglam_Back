const mongoose = require("mongoose");
const Delieverable = require("../models/delieverable");
const CampaignInvite = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const Influencer = require("../models/influencer");
const milestone = require("../models/milestone");

// helper to remove mongo fields from any object
const stripMongo = (obj) => {
  if (!obj) return obj;
  const { _id, __v, ...rest } = obj;
  return rest;
};

// 1) POST: Create deliverable approval (PENDING) - using campaignsId (UUID)
exports.createDeliverableApproval = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,   // ✅ use campaignId
      title,
      description,
      url,
      milestoneId,
    } = req.body;

    if (!brandId || !influencerId || !campaignId || !title) {
      return res.status(400).json({
        success: false,
        message: "brandId, influencerId, campaignId, and title are required.",
      });
    }

    const doc = await Delieverable.create({
      brandId,
      influencerId,
      campaignId, // ✅ now schema requirement is satisfied
      title,
      milestoneId,
      description: description || "",
      url: Array.isArray(url) ? url : url ? [url] : [],
      status: "pending",
      approvedRole: "",
      comments: "",
      approvalId: "",
    });

    return res.status(201).json({
      success: true,
      message: "Deliverable approval created (pending).",
      data: stripMongo(doc.toObject()),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to create deliverable approval.",
      error: err.message,
    });
  }
};

// 2) PATCH: Update status to approved/changes
exports.updateDeliverableApprovalStatus = async (req, res) => {
  try {
    const { delieverableApprovalId } = req.params;
    const { status, comments, approvedRole, approvalId } = req.body;

    if (!["approved", "revision"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be either 'approved' or 'revision'.",
      });
    }

    const update = { status };

    if (typeof comments === "string") update.comments = comments;
    if (typeof approvalId === "string") update.approvalId = approvalId;

    if (approvedRole) {
      if (!["Brand", "Admin"].includes(approvedRole)) {
        return res.status(400).json({
          success: false,
          message: "approvedRole must be 'Brand' or 'Admin'.",
        });
      }
      update.approvedRole = approvedRole;
    }

    const doc = await Delieverable.findOneAndUpdate(
      { delieverableApprovalId },
      { $set: update },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Deliverable approval not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Deliverable status updated to '${status}'.`,
      data: stripMongo(doc),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to update deliverable status.",
      error: err.message,
    });
  }
};

// 3) GET: List deliverables by campaignsId (UUID) (+ optional status)
exports.listDeliverablesByCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { status } = req.query;

    const query = { campaignId: String(campaignId) };
    if (status) query.status = status;

    // 1) Get deliverables
    const docs = await Delieverable.find(query)
      .select("-_id -__v")
      .sort({ createdAt: -1 })
      .lean();

    // 2) Collect unique influencerIds
    const influencerIds = [
      ...new Set(
        docs
          .map((d) => (d?.influencerId ? String(d.influencerId) : null))
          .filter(Boolean)
      ),
    ];

    // 3) Fetch influencers
    const influencers = influencerIds.length
      ? await Influencer.find({ influencerId: { $in: influencerIds } })
          .select("-_id influencerId name fullName username")
          .lean()
      : [];

    // 4) Map influencerId -> influencer
    const infMap = new Map(influencers.map((i) => [String(i.influencerId), i]));

    // 5) Attach influencerName + influencerHandle (optional)
    const data = docs.map((d) => {
      const inf = infMap.get(String(d.influencerId));

      const influencerName = inf?.fullName || inf?.name || inf?.username || "";
      const influencerHandle = inf?.username || ""; // if you want handle

      return {
        ...d,
        influencerName,
        influencerHandle,
        influencer: inf
          ? {
              influencerId: inf.influencerId,
              name: influencerName,
              username: inf.username || "",
              fullName: inf.fullName || "",
            }
          : null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully.",
      count: data.length,
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch deliverables.",
      error: err.message,
    });
  }
};

// 4) GET: List influencer invites + campaign name using campaignsId UUID (NO _id usage)
exports.listInfluencerDeliverablesByCampaign = async (req, res) => {
  try {
    const { influencerId } = req.params;

    // 1) Get invites (UUID only)
    const invites = await CampaignInvite.find({ influencerId })
      .select("-_id campaignsId platform createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // 2) Collect UUID campaignsId
    const campaignsIds = invites.map((x) => x.campaignsId).filter(Boolean);

    // 3) Fetch campaigns by campaignsId (UUID field)
    const campaigns = campaignsIds.length
      ? await Campaign.find({ campaignsId: { $in: campaignsIds } })
          .select("-_id campaignsId productOrServiceName")
          .lean()
      : [];

    // 4) Map campaigns by campaignsId
    const campaignMap = new Map(campaigns.map((c) => [c.campaignsId, c]));

    // 5) Response (NO _id anywhere)
    const docs = invites.map((inv) => {
      const c = campaignMap.get(inv.campaignsId) || null;
      return {
        platform: inv.platform,
        createdAt: inv.createdAt,
        campaignsId: inv.campaignsId, // ✅ UUID
        campaign: c ? { productOrServiceName: c.productOrServiceName } : null,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully.",
      count: docs.length,
      data: docs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch deliverables.",
      error: err.message,
    });
  }
};

// 5) GET: Campaign-wise invite list with influencer details (UUID campaignsId only)
exports.listInfluencerDeliverablesByCampaign2 = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const campaignIdStr = String(campaignId);

    // 1) Get invites by campaignsId (STRING) + include platform + createdAt
    const invites = await CampaignInvite.find({ campaignsId: campaignIdStr })
      .select("influencerId deliverables platform createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // 2) Collect unique influencer UUIDs (STRING)
    const influencerIds = [
      ...new Set(
        invites
          .map((x) => x.influencerId)
          .filter(Boolean)
          .map((id) => String(id))
      ),
    ];

    // 3) Fetch influencer details (unique list)
    const influencers = influencerIds.length
      ? await Influencer.find({ influencerId: { $in: influencerIds } })
          .select("name username fullName country socialLinks influencerId")
          .lean()
      : [];

    // ✅ Build map: influencerId -> { platforms:Set, createdAtLatest }
    const metaByInfluencer = new Map();

    for (const inv of invites) {
      const infId = inv?.influencerId ? String(inv.influencerId) : null;
      if (!infId) continue;

      const p = inv?.platform ? String(inv.platform) : null;
      const c = inv?.createdAt || null;

      if (!metaByInfluencer.has(infId)) {
        metaByInfluencer.set(infId, {
          platforms: new Set(),
          createdAt: c, // since invites sorted desc, first is latest
        });
      }

      const meta = metaByInfluencer.get(infId);

      if (p) meta.platforms.add(p);

      // safety: ensure latest createdAt (if sort ever changes)
      if (c && (!meta.createdAt || new Date(c) > new Date(meta.createdAt))) {
        meta.createdAt = c;
      }
    }

    // ✅ Attach platforms + createdAt to each influencer
    const influencersWithMeta = influencers.map((inf) => {
      const id = String(inf.influencerId);
      const meta = metaByInfluencer.get(id);

      return {
        ...inf,
        platforms: meta ? Array.from(meta.platforms) : [],
        createdAt: meta?.createdAt || null, // ✅ latest invite createdAt
      };
    });

    // ✅ TOTALS
    const totalInvites = invites.length;
    const totalInfluencers = influencerIds.length;

    const totalDeliverables = invites.reduce((sum, inv) => {
      const d = inv?.deliverables;
      if (Array.isArray(d)) return sum + d.length;
      if (!d) return sum;
      return sum + 1;
    }, 0);

    return res.status(200).json({
      success: true,
      total: {
        invites: totalInvites,
        influencers: totalInfluencers,
        deliverables: totalDeliverables,
      },
      influencers: influencersWithMeta, // ✅ now includes platforms + createdAt
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch totals + influencer list.",
      error: err.message,
    });
  }
};