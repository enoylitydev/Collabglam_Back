const mongoose = require("mongoose");
const Delieverable = require("../models/delieverable");
const CampaignInvite = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const Influencer = require("../models/influencer");
const Milestone = require("../models/milestone");
const Notification = require("../models/notification");


const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// helper to remove mongo fields from any object
const stripMongo = (obj) => {
  if (!obj) return obj;
  const { _id, __v, ...rest } = obj;
  return rest;
};

const createNotificationSafe = async (payload) => {
  try {
    await Notification.create(payload);
  } catch (err) {
    console.error("Notification create failed:", err?.message || err);
  }
};

// 1) POST: Create deliverable approval (PENDING)
exports.createDeliverableApproval = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      title,
      description,
      url,
      milestoneHistoryId, // ✅ REQUIRED (we fetch title using this)
    } = req.body;

    if (!brandId || !influencerId || !campaignId || !title || !milestoneHistoryId) {
      return res.status(400).json({
        success: false,
        message:
          "brandId, influencerId, campaignId, title, and milestoneHistoryId are required.",
      });
    }

    const mHistoryId = String(milestoneHistoryId);

    // ✅ Find milestone document that contains this milestoneHistoryId
    const msDoc = await Milestone.findOne({
      "milestoneHistory.milestoneHistoryId": mHistoryId,
    })
      .select("milestoneId milestoneHistory")
      .lean();

    if (!msDoc) {
      return res.status(404).json({
        success: false,
        message: "Milestone history not found for given milestoneHistoryId.",
      });
    }

    // ✅ Extract exact history item
    const historyItem = (msDoc.milestoneHistory || []).find(
      (h) => String(h.milestoneHistoryId) === mHistoryId
    );

    if (!historyItem) {
      return res.status(404).json({
        success: false,
        message: "Milestone history item not found.",
      });
    }

    // ✅ Safety checks (optional but recommended)
    if (String(historyItem.campaignId) !== String(campaignId)) {
      return res.status(400).json({
        success: false,
        message: "campaignId does not match milestone history campaignId.",
      });
    }

    if (String(historyItem.influencerId) !== String(influencerId)) {
      return res.status(400).json({
        success: false,
        message: "influencerId does not match milestone history influencerId.",
      });
    }

    // ✅ Store BOTH milestoneId + milestoneHistoryId in Deliverable
    const doc = await Delieverable.create({
      brandId,
      influencerId,
      campaignId,
      title,
      description: description || "",
      url: Array.isArray(url) ? url : url ? [url] : [],
      milestoneId: String(msDoc.milestoneId),      // ✅ store milestoneId (root)
      milestoneHistoryId: mHistoryId,              // ✅ store milestoneHistoryId
      status: "pending",
      approvedRole: "",
      comments: "",
      approvalId: "",
    });


    // ✅ After deliverable created, notify BRAND
    const influencerDoc = await Influencer.findOne({ influencerId: String(influencerId) })
      .select("fullName name username")
      .lean();

    const influencerName =
      influencerDoc?.fullName || influencerDoc?.name || influencerDoc?.username || "Influencer";

    // optional: campaign name
    const campaignDoc = await Campaign.findOne({ campaignsId: String(campaignId) })
      .select("productOrServiceName")
      .lean();

    const campaignName = campaignDoc?.productOrServiceName || "Campaign";

    const milestoneTitle = historyItem?.milestoneTitle || "";

    const deliverableEntityId =
      doc?.delieverableApprovalId || doc?.deliverableApprovalId || doc?.notificationId || null;

    await createNotificationSafe({
      brandId: String(brandId),
      type: "deliverable.submitted",
      title: "New deliverable submitted",
      message: `${influencerName} submitted a deliverable for ${campaignName}${milestoneTitle ? ` (Milestone: ${milestoneTitle})` : ""
        }.`,
      entityType: "deliverable",
      entityId: deliverableEntityId ? String(deliverableEntityId) : String(campaignId),
      actionPath: `brand/deleverables?campaignId=${campaignId}`,
      isRead: false,
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
    // ✅ Notify INFLUENCER when status changes
    const campaignDoc = await Campaign.findOne({ campaignsId: String(doc.campaignId) })
      .select("productOrServiceName")
      .lean();

    const campaignName = campaignDoc?.productOrServiceName || "Campaign";

    const statusLabel = status === "approved" ? "Approved" : "Revision requested";
    const notifTitle =
      status === "approved" ? "Deliverable approved ✅" : "Deliverable needs changes ✏️";

    const byRole = approvedRole || doc.approvedRole || "Brand";

    const commentLine =
      typeof comments === "string" && comments.trim()
        ? ` Comment: ${comments.trim()}`
        : "";

    const deliverableEntityId =
      doc?.delieverableApprovalId || doc?.deliverableApprovalId || doc?.notificationId || null;

    await createNotificationSafe({
      influencerId: String(doc.influencerId),
      type: "deliverable.status.updated",
      title: notifTitle,
      message: `${byRole} marked your deliverable "${doc.title}" as ${statusLabel} in ${campaignName}.${commentLine}`,
      entityType: "deliverable",
      entityId: deliverableEntityId ? String(deliverableEntityId) : String(doc.campaignId),
      actionPath: `/influencer/campaigns-invite/${doc.campaignId}`,
      isRead: false,
    });
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
// Latest deliverables on top using BOTH updatedAt + createdAt
exports.listDeliverablesByCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { status } = req.query;

    const query = { campaignId: String(campaignId) };
    if (status) query.status = status;

    // 1) Get deliverables (latest activity on top)
    // ✅ Sort by updatedDate first, then updatedAt (if exists), then createdAt
    const docs = await Delieverable.find(query)
      .select("-_id -__v")
      .sort({ updatedDate: -1, updatedAt: -1, createdAt: -1, _id: -1 })
      .lean();

    // 2) Collect unique influencerIds
    const influencerIds = [
      ...new Set(
        docs
          .map((d) => (d?.influencerId ? String(d.influencerId) : null))
          .filter(Boolean)
      ),
    ];

    // 3) Collect unique milestoneHistoryIds
    const milestoneHistoryIds = [
      ...new Set(
        docs
          .map((d) => (d?.milestoneHistoryId ? String(d.milestoneHistoryId) : null))
          .filter(Boolean)
      ),
    ];

    // 4) Fetch influencers + milestone titles in parallel
    const [influencers, rows] = await Promise.all([
      influencerIds.length
        ? Influencer.find({ influencerId: { $in: influencerIds } })
            .select("-_id influencerId name fullName username")
            .lean()
        : Promise.resolve([]),

      milestoneHistoryIds.length
        ? Milestone.aggregate([
            { $match: { "milestoneHistory.milestoneHistoryId": { $in: milestoneHistoryIds } } },
            { $unwind: "$milestoneHistory" },
            { $match: { "milestoneHistory.milestoneHistoryId": { $in: milestoneHistoryIds } } },
            {
              $project: {
                _id: 0,
                milestoneId: 1,
                milestoneHistoryId: "$milestoneHistory.milestoneHistoryId",
                milestoneTitle: "$milestoneHistory.milestoneTitle",
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    const infMap = new Map(influencers.map((i) => [String(i.influencerId), i]));
    const titleByHistoryId = new Map(
      rows.map((r) => [String(r.milestoneHistoryId), r.milestoneTitle])
    );

    // 5) Attach influencer + milestoneTitle
    const data = docs.map((d) => {
      const inf = d?.influencerId ? infMap.get(String(d.influencerId)) : null;

      const influencerName = inf?.fullName || inf?.name || inf?.username || "";
      const influencerHandle = inf?.username || "";
      const mhId = d?.milestoneHistoryId ? String(d.milestoneHistoryId) : "";

      return {
        ...d,
        milestoneTitle: titleByHistoryId.get(mhId) || "",
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


// ✅ NEW: GET ALL deliverables by brandId OR influencerId
exports.getAllDeliverables = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      status,
      campaignId,
      search, // ✅ NEW
      page = 1,
      limit = 20,
    } = req.query;

    if (!brandId && !influencerId) {
      return res.status(400).json({
        success: false,
        message: "brandId or influencerId is required.",
      });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));

    const query = {};
    if (brandId) query.brandId = String(brandId);
    if (influencerId) query.influencerId = String(influencerId);
    if (status) query.status = String(status);
    if (campaignId) query.campaignId = String(campaignId);

    // ✅ SEARCH (title/desc/comments + campaignName + milestoneTitle)
    const term = String(search || "").trim();
    if (term) {
      const rx = new RegExp(escapeRegex(term), "i");

      // 1) campaignIds where productOrServiceName matches
      const matchedCampaigns = await Campaign.find({
        productOrServiceName: rx,
      })
        .select("campaignsId -_id")
        .lean();

      const matchedCampaignIds = matchedCampaigns
        .map((c) => String(c.campaignsId))
        .filter(Boolean);

      // 2) milestoneHistoryIds where milestoneTitle matches
      const matchedMilestones = await Milestone.aggregate([
        { $unwind: "$milestoneHistory" },
        { $match: { "milestoneHistory.milestoneTitle": rx } },
        {
          $project: {
            _id: 0,
            milestoneHistoryId: "$milestoneHistory.milestoneHistoryId",
          },
        },
      ]);

      const matchedMilestoneHistoryIds = matchedMilestones
        .map((m) => String(m.milestoneHistoryId))
        .filter(Boolean);

      query.$or = [
        { title: rx },
        { description: rx },
        { comments: rx },
        { delieverableApprovalId: rx },
        ...(matchedCampaignIds.length
          ? [{ campaignId: { $in: matchedCampaignIds } }]
          : []),
        ...(matchedMilestoneHistoryIds.length
          ? [{ milestoneHistoryId: { $in: matchedMilestoneHistoryIds } }]
          : []),
      ];
    }

    // 1) Get deliverables (paginated)
    const [docs, total] = await Promise.all([
      Delieverable.find(query)
        .select("-_id -__v")
        .sort({ createdAt: -1 })
        .skip((p - 1) * l)
        .limit(l)
        .lean(),
      Delieverable.countDocuments(query),
    ]);

    // 2) Collect influencerIds
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

    const infMap = new Map(influencers.map((i) => [String(i.influencerId), i]));

    // 4) Collect campaignIds (UUIDs)
    const campaignIds = [
      ...new Set(
        docs
          .map((d) => (d?.campaignId ? String(d.campaignId) : null))
          .filter(Boolean)
      ),
    ];

    // 5) Fetch campaigns
    const campaigns = campaignIds.length
      ? await Campaign.find({ campaignsId: { $in: campaignIds } })
          .select("-_id campaignsId productOrServiceName")
          .lean()
      : [];

    const campMap = new Map(campaigns.map((c) => [String(c.campaignsId), c]));

    // 6) Collect milestoneHistoryIds
    const milestoneHistoryIds = [
      ...new Set(
        docs
          .map((d) =>
            d?.milestoneHistoryId ? String(d.milestoneHistoryId) : null
          )
          .filter(Boolean)
      ),
    ];

    // 7) Fetch milestone titles by milestoneHistoryId
    const rows = milestoneHistoryIds.length
      ? await Milestone.aggregate([
          {
            $match: {
              "milestoneHistory.milestoneHistoryId": { $in: milestoneHistoryIds },
            },
          },
          { $unwind: "$milestoneHistory" },
          {
            $match: {
              "milestoneHistory.milestoneHistoryId": { $in: milestoneHistoryIds },
            },
          },
          {
            $project: {
              _id: 0,
              milestoneHistoryId: "$milestoneHistory.milestoneHistoryId",
              milestoneTitle: "$milestoneHistory.milestoneTitle",
            },
          },
        ])
      : [];

    const titleByHistoryId = new Map(
      rows.map((r) => [String(r.milestoneHistoryId), r.milestoneTitle])
    );

    // 8) Attach influencer + campaign + milestoneTitle
    const data = docs.map((d) => {
      const inf = infMap.get(String(d.influencerId));
      const camp = campMap.get(String(d.campaignId));

      const influencerName = inf?.fullName || inf?.name || inf?.username || "";
      const influencerHandle = inf?.username || "";

      const mhId = d?.milestoneHistoryId ? String(d.milestoneHistoryId) : "";

      return {
        ...d,
        campaignName: camp?.productOrServiceName || "",
        milestoneTitle: titleByHistoryId.get(mhId) || "",
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
      page: p,
      limit: l,
      total,
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



exports.listBrandShortlistedCampaigns = async (req, res) => {
  try {
    const { brandId } = req.params;
    const { page = 1, limit = 20, search } = req.query;

    if (!brandId) {
      return res.status(400).json({ success: false, message: "brandId is required." });
    }

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.max(1, parseInt(limit, 10));
    const skip = (p - 1) * l;

    const matchCampaign = { brandId: String(brandId) }; // ⚠️ adjust if your field name differs

    const term = String(search || "").trim();
    if (term) {
      const rx = new RegExp(escapeRegex(term), "i");
      matchCampaign.productOrServiceName = rx;
    }

    const pipeline = [
      { $match: matchCampaign },

      // join invites for shortlist count
      {
        $lookup: {
          from: CampaignInvite.collection.name,
          localField: "campaignsId",
          foreignField: "campaignsId",
          as: "invites",
        },
      },

      // unique shortlisted influencers count
      {
        $addFields: {
          shortlistedInfluencersCount: {
            $size: { $setUnion: ["$invites.influencerId", []] },
          },
        },
      },

      // only campaigns where shortlisted count > 0
      { $match: { shortlistedInfluencersCount: { $gt: 0 } } },

      // table fields
      {
        $project: {
          _id: 0,
          campaignsId: 1,
          productOrServiceName: 1,
          description: { $ifNull: ["$description", ""] },
          timeline: 1,
          isActive: { $ifNull: ["$isActive", 0] },
          budget: { $ifNull: ["$budget", 0] },
          applicantCount: { $ifNull: ["$applicantCount", 0] },
          totalAcceptedMembers: { $ifNull: ["$totalAcceptedMembers", 0] },
          campaignType: { $ifNull: ["$campaignType", ""] },
          shortlistedInfluencersCount: 1,
          createdAt: 1,
        },
      },

      { $sort: { createdAt: -1 } },

      {
        $facet: {
          data: [{ $skip: skip }, { $limit: l }],
          meta: [{ $count: "total" }],
        },
      },
    ];

    const out = await Campaign.aggregate(pipeline);
    const data = out?.[0]?.data || [];
    const total = out?.[0]?.meta?.[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / l));

    return res.status(200).json({
      success: true,
      message: "Shortlisted campaigns fetched successfully.",
      meta: { total, page: p, limit: l, totalPages },
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch shortlisted campaigns.",
      error: err.message,
    });
  }
};



// ✅ ADD THIS CONTROLLER FUNCTION IN SAME CONTROLLER FILE
// controllers/delieverableController.js

exports.updateDeliverableRevision = async (req, res) => {
  try {
    const {
      delieverableApprovalId, // ✅ your model key
      deliverableApprovalId,  // ✅ support if frontend sends correct spelling
      campaignId,
      milestoneHistoryId,
      influencerId,

      title,        // frontend sends: "Revised - <old title>" (locked)
      description,
      url,
    } = req.body;

    const approvalId = String(delieverableApprovalId || deliverableApprovalId || "").trim();

    if (!approvalId && (!campaignId || !milestoneHistoryId)) {
      return res.status(400).json({
        success: false,
        message:
          "Send delieverableApprovalId (recommended) OR (campaignId + milestoneHistoryId) to update revision.",
      });
    }

    if (!description || !String(description).trim()) {
      return res.status(400).json({
        success: false,
        message: "description is required.",
      });
    }

    if (!Array.isArray(url) || url.length === 0) {
      return res.status(400).json({
        success: false,
        message: "url must be a non-empty array.",
      });
    }

    // sanitize url items
    const cleanedUrls = url.map((u) => ({
      label: String(u?.label || "").trim(), // model allows empty
      url: String(u?.url || "").trim(),
    }));

    // validate url presence (schema requires url)
    for (const u of cleanedUrls) {
      if (!u.url) {
        return res.status(400).json({
          success: false,
          message: "Each url item must include a valid url.",
        });
      }
    }

    // 1) FIND DELIVERABLE
    const query = approvalId
      ? { delieverableApprovalId: approvalId }
      : {
          campaignId: String(campaignId),
          milestoneHistoryId: String(milestoneHistoryId),
          ...(influencerId ? { influencerId: String(influencerId) } : {}),
        };

    const existing = await Delieverable.findOne(query).lean();

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Deliverable not found.",
      });
    }

    // 2) BLOCK IF APPROVED
    const st = String(existing.status || "").trim().toLowerCase();
    if (st === "approved" || st === "aproved") {
      return res.status(409).json({
        success: false,
        message: "Deliverable already approved. Revision is not allowed.",
      });
    }

    // 3) TITLE RULE (locked / always starts with "Revised -")
    const oldTitle = String(existing.title || "Deliverable").trim();
    let finalTitle = String(title || "").trim();

    if (!finalTitle) {
      finalTitle = oldTitle.toLowerCase().startsWith("revised")
        ? oldTitle
        : `Revised - ${oldTitle}`;
    } else {
      if (!finalTitle.toLowerCase().startsWith("revised")) {
        finalTitle = `Revised - ${finalTitle}`;
      }
    }

    // 4) UPDATE
    // ✅ IMPORTANT:
    // When influencer submits revision, usually status should go back to "pending" for re-review
    // If you want to keep it "revision", change pending -> revision below.
    const update = {
      title: finalTitle,
      description: String(description).trim(),
      url: cleanedUrls,

      status: "pending", // ✅ re-submitted for approval
      approvedRole: "",
      approvalId: "",

      // keep comments (brand/admin feedback) as it is:
      // comments: existing.comments,
    };

    const doc = await Delieverable.findOneAndUpdate(
      { delieverableApprovalId: existing.delieverableApprovalId },
      { $set: update },
      { new: true }
    )
      .select("-_id -__v")
      .lean();

    // 5) NOTIFY BRAND (optional but recommended)
    try {
      const influencerDoc = await Influencer.findOne({ influencerId: String(existing.influencerId) })
        .select("fullName name username")
        .lean();

      const influencerName =
        influencerDoc?.fullName || influencerDoc?.name || influencerDoc?.username || "Influencer";

      const campaignDoc = await Campaign.findOne({ campaignsId: String(existing.campaignId) })
        .select("productOrServiceName")
        .lean();

      const campaignName = campaignDoc?.productOrServiceName || "Campaign";

      // milestone title from milestoneHistoryId
      let milestoneTitle = "";
      const msDoc = await Milestone.findOne({
        "milestoneHistory.milestoneHistoryId": String(existing.milestoneHistoryId),
      })
        .select("milestoneHistory")
        .lean();

      if (msDoc?.milestoneHistory?.length) {
        const h = msDoc.milestoneHistory.find(
          (x) => String(x.milestoneHistoryId) === String(existing.milestoneHistoryId)
        );
        milestoneTitle = h?.milestoneTitle || "";
      }

      await createNotificationSafe({
        brandId: String(existing.brandId),
        type: "deliverable.revision.submitted",
        title: "Revision submitted ✏️",
        message: `${influencerName} submitted a revision for ${campaignName}${
          milestoneTitle ? ` (Milestone: ${milestoneTitle})` : ""
        }.`,
        entityType: "deliverable",
        entityId: String(existing.delieverableApprovalId),
        actionPath: `brand/deleverables?campaignId=${existing.campaignId}`,
        isRead: false,
      });
    } catch (e) {
      // don't fail main API if notification fails
      console.log("revision notification failed:", e?.message || e);
    }

    return res.status(200).json({
      success: true,
      message: "Revision updated successfully.",
      data: doc,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to update revision.",
      error: err.message,
    });
  }
};