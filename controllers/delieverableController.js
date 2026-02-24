
const mongoose = require("mongoose");
const Delieverable = require("../models/delieverable");
const CampaignInvite = require("../models/campaignInvitation"); 
const Campaign = require("../models/campaign");
exports.createDeliverableApproval = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId, title, description, url } = req.body;

    if (!brandId || !influencerId || !campaignId || !title) {
      return res.status(400).json({
        success: false,
        message: "brandId, influencerId, campaignId, and title are required.",
      });
    }
    const doc = await Delieverable.create({
      brandId,
      influencerId,
      campaignId,
      title,
      description: description || "",
      url: Array.isArray(url) ? url : [],
      status: "pending",
      approvedRole: "",
      comments: "",
      approvalId: "",
    });

    return res.status(201).json({
      success: true,
      message: "Deliverable approval created (pending).",
      data: doc,
    });
  } catch (err) {
    // duplicate UUID or other errors
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

    if (!["approved", "changes"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be either 'approved' or 'changes'.",
      });
    }

    const update = {
      status,
    };

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
    );

    if (!doc) {
      return res.status(404).json({
        success: false,
        message: "Deliverable approval not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Deliverable status updated to '${status}'.`,
      data: doc,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to update deliverable status.",
      error: err.message,
    });
  }
};


exports.listDeliverablesByCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { status } = req.query; 

    const query = { campaignId };
    if (status) query.status = status; 

    const docs = await Delieverable.find(query).sort({ createdAt: -1 });

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

exports.listInfluencerDeliverablesByCampaign = async (req, res) => {
  try {
    const { influencerId } = req.params;

    // 1) Get invites (no populate)
    const invites = await CampaignInvite.find({ influencerId })
      .select("campaignId platform createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // 2) Collect ONLY campaignId values
    const campaignIds = invites
      .map((x) => x.campaignId)
      .filter(Boolean)
      .map((id) => new mongoose.Types.ObjectId(id));

    // 3) Fetch campaigns manually (single query)
    console.log(campaignIds)
    const campaigns = await Campaign.find({ _id: { $in: campaignIds } }).select("productOrServiceName").lean();

    // 4) Map campaigns by id
    const campaignMap = new Map(campaigns.map((c) => [String(c._id), c]));

    // 5) Attach campaign object to each invite
    const docs = invites.map((inv) => ({
      ...inv,
      campaign: campaignMap.get(String(inv.campaignId)) || null,
    }));

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