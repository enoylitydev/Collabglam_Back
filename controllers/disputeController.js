// controllers/disputeController.js
const Dispute = require('../models/dispute');
const Campaign = require('../models/campaign');
const Admin = require('../models/admin');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const ApplyCampaign = require('../models/applyCampaign');
const Contract = require('../models/contract');

const {
  handleSendDisputeCreated,
  handleSendDisputeResolved,
  handleSendDisputeAgainstYou
} = require('../emails/disputeEmailController');

// ---- STATUS CONFIG & HELPERS ----

const STATUS_ORDER = ['open', 'in_review', 'awaiting_user', 'resolved', 'rejected'];
const ALLOWED_STATUSES = new Set(STATUS_ORDER);

/**
 * Escape a string so it can be safely used inside new RegExp(...)
 */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStatusInput(raw, { allowZeroAll = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return null;

  const s = String(raw).trim();
  if (!s) return null;

  // numeric mapping
  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num === 0) {
      return allowZeroAll ? '__ALL__' : null;
    }
    const idx = num - 1; // 1 → index 0
    if (idx >= 0 && idx < STATUS_ORDER.length) {
      return STATUS_ORDER[idx];
    }
    return null;
  }

  // direct string status
  if (ALLOWED_STATUSES.has(s)) return s;

  return null;
}

/**
 * Sanitize user-supplied attachments into the canonical shape.
 */
function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(a => a && a.url)
    .map(a => ({
      url: a.url,
      originalName: a.originalName || null,
      mimeType: a.mimeType || null,
      size: typeof a.size === 'number' ? a.size : undefined
    }));
}

/**
 * Build safe $or for campaign text search (influencerCampaignsForDispute).
 */
function buildSearchOr(term) {
  const safe = escapeRegex(term);

  const or = [
    { brandName: { $regex: safe, $options: 'i' } },
    { productOrServiceName: { $regex: safe, $options: 'i' } },
    { description: { $regex: safe, $options: 'i' } },
    { 'categories.subcategoryName': { $regex: safe, $options: 'i' } },
    { 'categories.categoryName': { $regex: safe, $options: 'i' } }
  ];

  const num = Number(term);
  if (!isNaN(num)) {
    or.push({ budget: { $lte: num } });
  }

  return or;
}

// ----------------- ID / MODEL HELPERS -----------------

/**
 * Extract brandId from body/query/params and load Brand.
 * Returns the Brand document (lean) or sends error + returns null.
 */
async function requireBrandModel(req, res) {
  const brandId =
    (req.body && req.body.brandId) ||
    (req.query && req.query.brandId) ||
    (req.params && req.params.brandId);

  if (!brandId) {
    res.status(400).json({ message: 'brandId is required' });
    return null;
  }

  const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
  if (!brand) {
    res.status(404).json({ message: 'Brand not found' });
    return null;
  }

  return brand;
}

/**
 * Extract influencerId from body/query/params and load Influencer.
 */
async function requireInfluencerModel(req, res) {
  const influencerId =
    (req.body && req.body.influencerId) ||
    (req.query && req.query.influencerId) ||
    (req.params && req.params.influencerId);

  if (!influencerId) {
    res.status(400).json({ message: 'influencerId is required' });
    return null;
  }

  const influencer = await Influencer.findOne({
    influencerId: String(influencerId)
  }).lean();

  if (!influencer) {
    res.status(404).json({ message: 'Influencer not found' });
    return null;
  }

  return influencer;
}

/**
 * Admin is "relaxed": we don't block if adminId is missing.
 * If adminId is provided (body/query/params), we try to load it.
 * Returns admin doc or null; never sends error.
 */
async function resolveAdminModel(req) {
  const adminId =
    (req.body && req.body.adminId) ||
    (req.query && req.query.adminId) ||
    (req.params && req.params.adminId);

  if (!adminId) return null;

  const admin = await Admin.findOne({ adminId: String(adminId) })
    .select('adminId name email')
    .lean();

  return admin || null;
}

// ----------------- BRAND ENDPOINTS -----------------

// Brand creates a dispute
exports.brandCreateDispute = async (req, res) => {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      subject,
      description = '',
      attachments = []
    } = req.body || {};

    if (!brandId || !influencerId || !subject) {
      return res.status(400).json({
        message: 'brandId, influencerId and subject are required'
      });
    }

    // ensure brand exists
    const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    // ensure influencer exists
    const influencer = await Influencer.findOne({
      influencerId: String(influencerId)
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // validate campaign belongs to this brand (if provided)
    let linkedCampaignId = null;
    let camp = null;
    if (campaignId) {
      camp = await Campaign.findOne({
        campaignsId: campaignId,
        brandId: String(brandId)
      }).lean();
      if (camp) linkedCampaignId = String(campaignId);
    }

    const sanitizedAttachments = sanitizeAttachments(attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId, // may be null
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ''),
      createdBy: { id: String(brandId), role: 'Brand' },
      attachments: sanitizedAttachments
    });

    await dispute.save();

    // Notify brand (creator)
    if (brand.email) {
      await handleSendDisputeCreated({
        email: brand.email,
        userName: brand.name,
        ticketId: dispute.disputeId,
        category: dispute.subject
      });
    }

    // Notify influencer that a dispute has been raised against them
    if (influencer.email) {
      await handleSendDisputeAgainstYou({
        email: influencer.email,
        userName: influencer.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
        raisedBy: brand.name,
        raisedByRole: 'Brand',
        campaignName: linkedCampaignId ? (camp?.productOrServiceName || '') : ''
      });
    }

    return res
      .status(201)
      .json({ message: 'Dispute created', disputeId: dispute.disputeId });
  } catch (err) {
    console.error('Error in brandCreateDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Brand list disputes for its brandId
exports.brandList = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      status,
      search,
      appliedBy // "brand" | "influencer" optional
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {
      brandId: String(brandId)
    };

    // numeric / string status support (0 = all)
    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== '__ALL__') {
      filter.status = normalizedStatus;
    }

    // backend search: subject / description / disputeId
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const pattern = escapeRegex(searchTerm);
      const re = new RegExp(pattern, 'i');
      filter.$or = [
        { subject: re },
        { description: re },
        { disputeId: re }
      ];
    }

    // who raised it (direction filter)
    if (appliedBy && typeof appliedBy === 'string') {
      const role = String(appliedBy).toLowerCase();
      if (role === 'brand') filter['createdBy.role'] = 'Brand';
      if (role === 'influencer') filter['createdBy.role'] = 'Influencer';
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .select(
        'disputeId subject description status campaignId brandId influencerId assignedTo attachments comments createdAt updatedAt createdBy'
      )
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    // Add quick "who raised it" info
    const rowsWithRole = rows.map(r => ({
      ...r,
      raisedByRole: r.createdBy?.role || null,
      raisedById: r.createdBy?.id || null
    }));

    // Enrich with influencer name + campaign name + raisedBy/raisedAgainst
    try {
      const influencerIds = Array.from(
        new Set(rowsWithRole.map(r => r.influencerId).filter(Boolean))
      ).map(String);

      const campaignIds = Array.from(
        new Set(rowsWithRole.map(r => r.campaignId).filter(Boolean))
      ).map(String);

      const [influencers, campaigns] = await Promise.all([
        influencerIds.length
          ? Influencer.find({ influencerId: { $in: influencerIds } })
              .select('influencerId name')
              .lean()
          : [],
        campaignIds.length
          ? Campaign.find({ campaignsId: { $in: campaignIds } })
              .select('campaignsId productOrServiceName')
              .lean()
          : []
      ]);

      const infMap = new Map(
        (influencers || []).map(i => [String(i.influencerId), i.name])
      );
      const cmap = new Map(
        (campaigns || []).map(c => [String(c.campaignsId), c.productOrServiceName])
      );

      const enriched = rowsWithRole.map(r => {
        const campaignName = r.campaignId
          ? cmap.get(String(r.campaignId)) || null
          : null;

        const role = r.raisedByRole;
        let raisedBy = null;
        let raisedAgainst = null;

        if (role === 'Brand') {
          // Brand (viewer) raised it
          raisedBy = {
            role: 'Brand',
            id: r.brandId,
            name: brand.name || null
          };
          raisedAgainst = {
            role: 'Influencer',
            id: r.influencerId,
            name: infMap.get(String(r.influencerId)) || null
          };
        } else if (role === 'Influencer') {
          // Influencer raised it against this brand
          raisedBy = {
            role: 'Influencer',
            id: r.influencerId,
            name: infMap.get(String(r.influencerId)) || null
          };
          raisedAgainst = {
            role: 'Brand',
            id: r.brandId,
            name: brand.name || null
          };
        }

        const viewerIsRaiser = role === 'Brand';

        return {
          ...r,
          campaignName,
          raisedBy,
          raisedAgainst,
          viewerIsRaiser
        };
      });

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched
      });
    } catch (e) {
      console.error('Error enriching brandList:', e);
      // Fallback: still return raisedByRole info
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rowsWithRole
      });
    }
  } catch (err) {
    console.error('Error in brandList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Brand get dispute-by-id (must match brandId)
exports.brandGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const brandId =
      (req.query && req.query.brandId) ||
      (req.body && req.body.brandId);

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.brandId !== String(brandId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Enrich with campaign name + who raised against whom
    try {
      const [campaign, influencer] = await Promise.all([
        d.campaignId
          ? Campaign.findOne({ campaignsId: d.campaignId })
              .select('campaignsId productOrServiceName')
              .lean()
          : null,
        d.influencerId
          ? Influencer.findOne({ influencerId: d.influencerId })
              .select('influencerId name')
              .lean()
          : null
      ]);

      d.campaignName = campaign?.productOrServiceName || null;

      const influencerName = influencer?.name || null;
      const raisedByRole = d.createdBy?.role || null;

      if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: brand.name || null
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName
        };
      } else if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencerName
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: brand.name || null
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
      d.viewerIsRaiser = raisedByRole === 'Brand';
    } catch (e) {
      console.error('Error enriching brandGetById:', e);
      d.campaignName = d.campaignName || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in brandGetById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Brand add comment
exports.brandAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], brandId } = req.body || {};

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.brandId !== String(brandId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (d.status === 'resolved' || d.status === 'rejected') {
      return res
        .status(400)
        .json({ message: 'Cannot comment on a finalized dispute' });
    }

    const sanitized = sanitizeAttachments(attachments);

    d.comments.push({
      authorRole: 'Brand',
      authorId: String(brandId),
      text: String(text),
      attachments: sanitized
    });

    await d.save();

    return res.status(200).json({ message: 'Comment added' });
  } catch (err) {
    console.error('Error in brandAddComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ----------------- INFLUENCER ENDPOINTS -----------------

// Influencer creates a dispute
exports.influencerCreateDispute = async (req, res) => {
  try {
    const {
      influencerId,
      campaignId,
      brandId,
      subject,
      description = '',
      attachments = []
    } = req.body || {};

    if (!influencerId || !brandId || !subject) {
      return res.status(400).json({
        message: 'influencerId, brandId and subject are required'
      });
    }

    const influencer = await Influencer.findOne({
      influencerId: String(influencerId)
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const brand = await Brand.findOne({ brandId: String(brandId) }).lean();
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    // validate campaign belongs to that brand (if provided)
    let linkedCampaignId = null;
    let camp = null;
    if (campaignId) {
      camp = await Campaign.findOne({
        campaignsId: campaignId,
        brandId: String(brandId)
      }).lean();
      if (camp) linkedCampaignId = String(campaignId);
    }

    const sanitizedAttachments = sanitizeAttachments(attachments);

    const dispute = new Dispute({
      campaignId: linkedCampaignId,
      brandId: String(brandId),
      influencerId: String(influencerId),
      subject: String(subject).trim(),
      description: String(description || ''),
      createdBy: { id: String(influencerId), role: 'Influencer' },
      attachments: sanitizedAttachments
    });

    await dispute.save();

    // Notify influencer (creator)
    if (influencer.email) {
      await handleSendDisputeCreated({
        email: influencer.email,
        userName: influencer.name,
        ticketId: dispute.disputeId,
        category: dispute.subject
      });
    }

    // Notify brand that a dispute has been raised against them
    if (brand.email) {
      await handleSendDisputeAgainstYou({
        email: brand.email,
        userName: brand.name,
        ticketId: dispute.disputeId,
        category: dispute.subject,
        raisedBy: influencer.name,
        raisedByRole: 'Influencer',
        campaignName: linkedCampaignId ? (camp?.productOrServiceName || '') : ''
      });
    }

    return res
      .status(201)
      .json({ message: 'Dispute created', disputeId: dispute.disputeId });
  } catch (err) {
    console.error('Error in influencerCreateDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer list disputes
exports.influencerList = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      status,
      search,
      appliedBy // optional: "brand" | "influencer"
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const influencer = await Influencer.findOne({
      influencerId: String(influencerId)
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    // Base filter: all disputes where this influencer is involved
    const filter = {
      influencerId: String(influencerId)
    };

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== '__ALL__') {
      filter.status = normalizedStatus;
    }

    // backend search: subject / description / disputeId
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const pattern = escapeRegex(searchTerm);
      const re = new RegExp(pattern, 'i');
      filter.$or = [
        { subject: re },
        { description: re },
        { disputeId: re }
      ];
    }

    // Optional filter by who raised the dispute
    if (appliedBy && typeof appliedBy === 'string') {
      const role = String(appliedBy).toLowerCase();

      if (role === 'brand') {
        // Raised against me (by brand)
        filter['createdBy.role'] = 'Brand';
      }

      if (role === 'influencer') {
        // Raised by me
        filter['createdBy.role'] = 'Influencer';
        filter['createdBy.id'] = String(influencerId);
      }
    }
    // If no appliedBy → influencer sees all disputes involving them (both directions)

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .select(
        'disputeId subject description status campaignId brandId influencerId assignedTo attachments comments createdAt updatedAt createdBy'
      )
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    // Add quick "who raised it" info
    const rowsWithRole = rows.map(r => ({
      ...r,
      raisedByRole: r.createdBy?.role || null,
      raisedById: r.createdBy?.id || null
    }));

    // Enrich with brand name + campaign name + raisedBy/raisedAgainst
    try {
      const brandIds = Array.from(
        new Set(rowsWithRole.map(r => r.brandId).filter(Boolean))
      ).map(String);

      const campaignIds = Array.from(
        new Set(rowsWithRole.map(r => r.campaignId).filter(Boolean))
      ).map(String);

      const [brands, campaigns] = await Promise.all([
        brandIds.length
          ? Brand.find({ brandId: { $in: brandIds } })
              .select('brandId name')
              .lean()
          : [],
        campaignIds.length
          ? Campaign.find({ campaignsId: { $in: campaignIds } })
              .select('campaignsId productOrServiceName')
              .lean()
          : []
      ]);

      const brandMap = new Map(
        (brands || []).map(b => [String(b.brandId), b.name])
      );
      const cmap = new Map(
        (campaigns || []).map(c => [String(c.campaignsId), c.productOrServiceName])
      );

      const enriched = rowsWithRole.map(r => {
        const campaignName = r.campaignId
          ? cmap.get(String(r.campaignId)) || null
          : null;

        const role = r.raisedByRole;
        let raisedBy = null;
        let raisedAgainst = null;

        if (role === 'Influencer') {
          // Influencer (viewer) raised it
          raisedBy = {
            role: 'Influencer',
            id: r.influencerId,
            name: influencer.name || null
          };
          raisedAgainst = {
            role: 'Brand',
            id: r.brandId,
            name: brandMap.get(String(r.brandId)) || null
          };
        } else if (role === 'Brand') {
          // Brand raised it against this influencer
          raisedBy = {
            role: 'Brand',
            id: r.brandId,
            name: brandMap.get(String(r.brandId)) || null
          };
          raisedAgainst = {
            role: 'Influencer',
            id: r.influencerId,
            name: influencer.name || null
          };
        }

        const viewerIsRaiser = role === 'Influencer';

        return {
          ...r,
          campaignName,
          raisedBy,
          raisedAgainst,
          viewerIsRaiser
        };
      });

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched
      });
    } catch (e) {
      console.error('Error enriching influencerList:', e);
      // Fallback: still return raisedByRole info
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rowsWithRole
      });
    }
  } catch (err) {
    console.error('Error in influencerList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer get dispute-by-id
exports.influencerGetById = async (req, res) => {
  try {
    const { id } = req.params;
    const influencerId =
      (req.query && req.query.influencerId) ||
      (req.body && req.body.influencerId);

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const influencer = await Influencer.findOne({
      influencerId: String(influencerId)
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.influencerId !== String(influencerId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Enrich with campaign name + who raised against whom
    try {
      const [campaign, brand] = await Promise.all([
        d.campaignId
          ? Campaign.findOne({ campaignsId: d.campaignId })
              .select('campaignsId productOrServiceName')
              .lean()
          : null,
        d.brandId
          ? Brand.findOne({ brandId: d.brandId })
              .select('brandId name')
              .lean()
          : null
      ]);

      d.campaignName = campaign?.productOrServiceName || null;

      const brandName = brand?.name || null;
      const raisedByRole = d.createdBy?.role || null;

      if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencer.name || null
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: brandName
        };
      } else if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: brandName
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: influencer.name || null
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
      d.viewerIsRaiser = raisedByRole === 'Influencer';
    } catch (e) {
      console.error('Error enriching influencerGetById:', e);
      d.campaignName = d.campaignName || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in influencerGetById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer add comment
exports.influencerAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], influencerId } = req.body || {};

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const influencer = await Influencer.findOne({
      influencerId: String(influencerId)
    }).lean();
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.influencerId !== String(influencerId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (d.status === 'resolved' || d.status === 'rejected') {
      return res
        .status(400)
        .json({ message: 'Cannot comment on a finalized dispute' });
    }

    const sanitized = sanitizeAttachments(attachments);

    d.comments.push({
      authorRole: 'Influencer',
      authorId: String(influencerId),
      text: String(text),
      attachments: sanitized
    });

    await d.save();

    return res.status(200).json({ message: 'Comment added' });
  } catch (err) {
    console.error('Error in influencerAddComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ----------------- ADMIN ENDPOINTS -----------------

// Admin-friendly detail view (relaxed auth, no token required)
exports.adminGetById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'Dispute id is required' });

    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    try {
      const [b, inf, camp] = await Promise.all([
        d.brandId
          ? Brand.findOne({ brandId: d.brandId })
              .select('brandId name')
              .lean()
          : null,
        d.influencerId
          ? Influencer.findOne({ influencerId: d.influencerId })
              .select('influencerId name')
              .lean()
          : null,
        d.campaignId
          ? Campaign.findOne({ campaignsId: d.campaignId })
              .select('campaignsId productOrServiceName')
              .lean()
          : null
      ]);

      d.brandName = b?.name || null;
      d.influencerName = inf?.name || null;
      d.campaignName = camp?.productOrServiceName || null;

      const raisedByRole = d.createdBy?.role || null;

      if (raisedByRole === 'Brand') {
        d.raisedBy = {
          role: 'Brand',
          id: d.brandId,
          name: b?.name || null
        };
        d.raisedAgainst = {
          role: 'Influencer',
          id: d.influencerId,
          name: inf?.name || null
        };
      } else if (raisedByRole === 'Influencer') {
        d.raisedBy = {
          role: 'Influencer',
          id: d.influencerId,
          name: inf?.name || null
        };
        d.raisedAgainst = {
          role: 'Brand',
          id: d.brandId,
          name: b?.name || null
        };
      } else {
        d.raisedBy = null;
        d.raisedAgainst = null;
      }

      d.raisedByRole = raisedByRole;
      d.raisedById = d.createdBy?.id || null;
    } catch (e) {
      console.error('Error enriching adminGetById:', e);
      d.brandName = d.brandName || null;
      d.influencerName = d.influencerName || null;
      d.campaignName = d.campaignName || null;
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in adminGetById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Admin add comment (relaxed auth)
exports.adminAddComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { text, attachments = [], adminId } = req.body || {};

    if (!id) return res.status(400).json({ message: 'Dispute id is required' });
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    if (d.status === 'resolved' || d.status === 'rejected') {
      return res
        .status(400)
        .json({ message: 'Cannot comment on a finalized dispute' });
    }

    const admin = adminId
      ? await Admin.findOne({ adminId: String(adminId) })
          .select('adminId name email')
          .lean()
      : null;

    const sanitized = sanitizeAttachments(attachments);

    d.comments.push({
      authorRole: 'Admin',
      authorId: admin ? admin.adminId : (adminId || 'system'),
      text: String(text),
      attachments: sanitized
    });

    await d.save();

    return res.status(200).json({ message: 'Comment added' });
  } catch (err) {
    console.error('Error in adminAddComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Admin list with filters (status, campaignId, brandId, influencerId, etc.)
exports.adminList = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      campaignId,
      brandId,
      influencerId,
      search,
      appliedBy
    } = req.body || {};

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {};

    const normalizedStatus = normalizeStatusInput(status, { allowZeroAll: true });
    if (normalizedStatus && normalizedStatus !== '__ALL__') {
      filter.status = normalizedStatus;
    }

    if (campaignId) filter.campaignId = String(campaignId);
    if (brandId) filter.brandId = String(brandId);
    if (influencerId) filter.influencerId = String(influencerId);

    // backend search: subject / description / disputeId
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      const pattern = escapeRegex(searchTerm);
      const re = new RegExp(pattern, 'i');
      filter.$or = [
        { subject: re },
        { description: re },
        { disputeId: re }
      ];
    }

    if (appliedBy && typeof appliedBy === 'string') {
      const role = String(appliedBy).toLowerCase();
      if (role === 'brand') filter['createdBy.role'] = 'Brand';
      if (role === 'influencer') filter['createdBy.role'] = 'Influencer';
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    // Enrich with brand / influencer / campaign names
    try {
      const brandIds = Array.from(
        new Set(rows.map(r => r.brandId).filter(Boolean))
      ).map(String);
      const influencerIds = Array.from(
        new Set(rows.map(r => r.influencerId).filter(Boolean))
      ).map(String);
      const campaignIds = Array.from(
        new Set(rows.map(r => r.campaignId).filter(Boolean))
      ).map(String);

      const [brands, influencers, campaigns] = await Promise.all([
        brandIds.length
          ? Brand.find({ brandId: { $in: brandIds } })
              .select('brandId name')
              .lean()
          : [],
        influencerIds.length
          ? Influencer.find({ influencerId: { $in: influencerIds } })
              .select('influencerId name')
              .lean()
          : [],
        campaignIds.length
          ? Campaign.find({ campaignsId: { $in: campaignIds } })
              .select('campaignsId productOrServiceName')
              .lean()
          : []
      ]);

      const brandMap = new Map(
        (brands || []).map(b => [String(b.brandId), b.name])
      );
      const infMap = new Map(
        (influencers || []).map(i => [String(i.influencerId), i.name])
      );
      const campMap = new Map(
        (campaigns || []).map(c => [String(c.campaignsId), c.productOrServiceName])
      );

      const enriched = rows.map(r => {
        const raisedByRole = r.createdBy?.role || null;
        return {
          ...r,
          brandName: brandMap.get(String(r.brandId)) || null,
          influencerName: infMap.get(String(r.influencerId)) || null,
          campaignName: r.campaignId
            ? campMap.get(String(r.campaignId)) || null
            : null,
          raisedByRole,
          raisedById: r.createdBy?.id || null
        };
      });

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched
      });
    } catch (e) {
      console.error('Error enriching adminList:', e);
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rows
      });
    }
  } catch (err) {
    console.error('Error in adminList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Admin update status
exports.adminUpdateStatus = async (req, res) => {
  try {
    const { disputeId, status, resolution, adminId } = req.body || {};

    if (
      !disputeId ||
      status === undefined ||
      status === null ||
      status === ''
    ) {
      return res
        .status(400)
        .json({ message: 'disputeId and status are required' });
    }

    const normalizedStatus = normalizeStatusInput(status, {
      allowZeroAll: false
    });
    if (!normalizedStatus) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const d = await Dispute.findOne({ disputeId });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    d.status = normalizedStatus;

    let admin = null;
    if (adminId) {
      admin = await Admin.findOne({ adminId: String(adminId) })
        .select('adminId name email')
        .lean();
    }

    if (resolution && String(resolution).trim()) {
      d.comments.push({
        authorRole: 'Admin',
        authorId: admin ? admin.adminId : (adminId || 'system'),
        text: String(resolution)
      });
    }

    await d.save();

    if (d.status === 'resolved') {
      const [brand, influencer] = await Promise.all([
        Brand.findOne({ brandId: d.brandId }).lean(),
        Influencer.findOne({ influencerId: d.influencerId }).lean()
      ]);

      const resolutionSummary =
        resolution ||
        'The dispute has been reviewed and resolved by our team.';

      if (brand && brand.email) {
        await handleSendDisputeResolved({
          email: brand.email,
          userName: brand.name,
          ticketId: d.disputeId,
          resolutionSummary
        });
      }
      if (influencer && influencer.email) {
        await handleSendDisputeResolved({
          email: influencer.email,
          userName: influencer.name,
          ticketId: d.disputeId,
          resolutionSummary
        });
      }
    }

    return res.status(200).json({ message: 'Status updated' });
  } catch (err) {
    console.error('Error in adminUpdateStatus:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Admin assign dispute
exports.adminAssign = async (req, res) => {
  try {
    const { disputeId, adminId } = req.body || {};
    if (!disputeId) {
      return res.status(400).json({ message: 'disputeId is required' });
    }

    const d = await Dispute.findOne({ disputeId });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    let targetAdminId = adminId ? String(adminId) : null;
    let name = null;

    if (targetAdminId) {
      try {
        const a = await Admin.findOne({ adminId: targetAdminId })
          .select('email name')
          .lean();
        if (a) {
          name = a.name || a.email || null;
        }
      } catch {
        // ignore lookup errors, keep name=null
      }
    }

    d.assignedTo = { adminId: targetAdminId || null, name };
    await d.save();

    return res
      .status(200)
      .json({ message: 'Assigned', assignedTo: d.assignedTo });
  } catch (err) {
    console.error('Error in adminAssign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Influencer campaigns for dispute creation
exports.influencerCampaignsForDispute = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body || {};

  if (!influencerId) {
    return res.status(400).json({ message: 'influencerId is required' });
  }

  try {
    // Ensure influencer exists (defensive)
    const inf = await Influencer.findOne({ influencerId: String(influencerId) }).lean();
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // 1) All campaigns this influencer has applied to
    const applyRecs = await ApplyCampaign.find(
      { 'applicants.influencerId': String(influencerId) },
      'campaignId'
    ).lean();

    let campaignIds = applyRecs
      .map(r => r.campaignId)
      .filter(Boolean)
      .map(String);

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0
        },
        campaigns: []
      });
    }

    // 2) All contracts this influencer has for those campaigns
    const contracts = await Contract.find(
      {
        influencerId: String(influencerId),
        campaignId: { $in: campaignIds }
      },
      'campaignId contractId status isAccepted isRejected'
    ).lean();

    const contractMap = new Map();
    contracts.forEach(c => {
      const key = String(c.campaignId);
      contractMap.set(key, {
        contractId: c.contractId || null,
        status: c.status || null,
        isAccepted: c.isAccepted === 1 ? 1 : 0,
        isRejected: c.isRejected === 1 ? 1 : 0
      });
    });

    // 3) Fetch campaign docs for those ids
    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const filter = { campaignsId: { $in: campaignIds } };

    if (typeof search === 'string' && search.trim()) {
      const term = search.trim();
      filter.$or = buildSearchOr(term);
    }

    // Only fetch the minimal fields we need
    const projection = [
      'brandId',
      'brandName',
      'productOrServiceName',
      'isActive',
      'applicantCount',
      'hasApplied',
      'isDraft',
      'campaignsId',
      'createdAt'
    ].join(' ');

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter, projection)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limNum)
        .lean()
    ]);

    const campaigns = rawCampaigns.map(c => {
      const key = String(c.campaignsId);
      const contract = contractMap.get(key);

      const isRejected = contract ? contract.isRejected : 0;
      const isContracted = contract && !contract.isRejected ? 1 : 0;
      const isAccepted = contract && contract.isAccepted ? 1 : 0;

      return {
        // campaign identity
        campaignId: c.campaignsId,
        campaignName: c.productOrServiceName,

        // brand info
        brandId: c.brandId,
        brandName: c.brandName,

        // campaign state
        isActive: typeof c.isActive === 'number' ? c.isActive : 0,
        applicantCount: c.applicantCount ?? 0,
        hasApplied: 1, // by definition they applied
        isDraft: c.isDraft ?? 0,
        createdAt: c.createdAt,

        // contract state
        isContracted,
        isAccepted,
        isRejected,
        contractId: contract ? contract.contractId : null,
        contractStatus: contract ? contract.status : null
      };
    });

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      campaigns
    });
  } catch (err) {
    console.error('Error in influencerCampaignsForDispute:', err);
    return res
      .status(500)
      .json({ message: 'Internal server error while fetching campaigns for dispute.' });
  }
};
