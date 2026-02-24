// controllers/campaignInvitationController.js
const mongoose = require("mongoose");

const CampaignInvitation = require("../models/campaignInvitation");
const Campaign = require("../models/campaign");
const Modash = require("../models/modash");
const Influencer = require("../models/influencer");

// validation
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

function normalizeHandle(h) {
  if (!h) return null;
  const t = String(h).trim();
  const withAt = t.startsWith("@") ? t : `@${t}`;
  return withAt.toLowerCase();
}

/**
 * Accepts:
 * - campaignsIds (array or string)
 * - campaignsId  (array or string)
 * - campaignIds  (array or string)  [optional alias]
 * - campaignId   (single string)    [optional alias]
 *
 * Returns: array of IDs (strings), deduped
 */
function parseCampaignIdsFromBody(body) {
  const raw =
    body?.campaignsIds ??
    body?.campaignsId ??
    body?.campaignIds ??
    body?.campaignId;

  let ids = [];

  if (Array.isArray(raw)) {
    ids = raw.map((x) => String(x || "").trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    const v = raw.trim();
    if (v) ids = [v];
  } else if (raw != null) {
    // in case frontend sends numbers/objects by mistake
    const v = String(raw).trim();
    if (v) ids = [v];
  }

  // dedupe
  return [...new Set(ids)];
}

/**
 * Find Modash by userId (+provider best practice)
 * - userId is Modash.userId (UC....)
 * - provider is 'youtube'/'instagram'/'tiktok'
 */
async function findModashByUserId(userId, provider) {
  const id = String(userId || "").trim();
  if (!id) return null;

  // If someone accidentally passes Modash _id
  if (isObjectId(id)) {
    const byId = await Modash.findById(id).lean();
    if (byId) return byId;
  }

  if (provider) {
    const byPair = await Modash.findOne({ userId: id, provider }).lean();
    if (byPair) return byPair;
  }

  return Modash.findOne({ userId: id }).lean();
}

function extractHandleFromModash(modashDoc) {
  const cand = [modashDoc?.handle, modashDoc?.username].filter(Boolean);
  if (!cand.length) return null;
  return normalizeHandle(cand[0]);
}

/**
 * POST /admin/invitations/store
 * Stores invitations only (no email sending)
 *
 * body:
 * {
 *   userId: "UC....",
 *   campaignsId: ["uuid1","uuid2"]  // OR campaignsIds: [...]
 *   platform: "youtube"
 * }
 */
exports.storeInvitation = async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const platformRaw = String(req.body?.platform || "").trim().toLowerCase();

    const requestedCampaignIds = parseCampaignIdsFromBody(req.body);

    if (!userId || requestedCampaignIds.length === 0) {
      return res.status(400).json({
        status: "error",
        message:
          'userId and campaignsId(s) are required. Send "campaignsId" (string/array) or "campaignsIds" (string/array).',
      });
    }

    // 1) Modash
    const modash = await findModashByUserId(userId, platformRaw || undefined);
    if (!modash) {
      return res.status(404).json({ status: "error", message: "Modash profile not found" });
    }

    const platform = platformRaw || String(modash?.provider || "youtube").toLowerCase();

    // 2) Handle
    const handle = extractHandleFromModash(modash);
    if (!handle || !HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Could not resolve a valid @handle from Modash data",
      });
    }

    // 3) Optional influencer link
    let influencerId = null;

    if (modash?.influencer && isObjectId(modash.influencer)) {
      const influencer = await Influencer.findById(modash.influencer).select("influencerId").lean();
      influencerId = influencer?.influencerId || null;
    } else if (modash?.influencerId) {
      influencerId = modash.influencerId;
    }

    // 4) Fetch campaigns by campaignsId (UUID string)
    const campaigns = await Campaign.find({
      campaignsId: { $in: requestedCampaignIds },
    })
      .select("_id brandId campaignsId productOrServiceName")
      .lean();

    const byCampaignsId = new Map(campaigns.map((c) => [String(c.campaignsId), c]));

    const missingCampaigns = requestedCampaignIds.filter((cid) => !byCampaignsId.has(cid));

    // 5) Upsert invitations
    const storedInvitations = [];

    for (const cid of requestedCampaignIds) {
      const campaign = byCampaignsId.get(cid);
      if (!campaign) continue;
      if (!campaign.brandId) continue;

      const filter = {
        brandId: campaign.brandId,
        campaignId: campaign._id, // store internal mongo id
        handle,
        platform,
      };

      const update = {
        $setOnInsert: {
          brandId: campaign.brandId,
          campaignId: campaign._id,
          campaignsId: campaign.campaignsId || null, // store uuid
          handle,
          platform,
          createdByAdminId: req.user?.adminId || null,
          status: "created",
        },
        $set: {
          modashUserId: userId, // ✅ Modash.userId (UC...)
          influencerId: influencerId,
        },
      };

      const inv = await CampaignInvitation.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }).lean();

      storedInvitations.push({
        invitationId: inv.invitationId,
        brandId: inv.brandId,
        campaignId: String(inv.campaignId), // mongo id (internal)
        campaignsId: inv.campaignsId || null, // uuid (frontend)
        modashUserId: inv.modashUserId,
        influencerId: inv.influencerId || null,
        handle: inv.handle,
        platform: inv.platform,
        status: inv.status,
        createdAt: inv.createdAt,
        updatedAt: inv.updatedAt,
      });
    }

    return res.json({
      status: "success",
      message: "Invitations stored",
      requested: requestedCampaignIds.length,
      stored: storedInvitations.length,
      missingCampaigns, // campaignsId that were not found
      invitations: storedInvitations,
    });
  } catch (e) {
    console.error("storeInvitation error:", e);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
};