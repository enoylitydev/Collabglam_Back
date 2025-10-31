const Dispute = require('../models/dispute');
const Campaign = require('../models/campaign');
const Admin = require('../models/admin');

const ALLOWED_STATUSES = new Set(['open', 'in_review', 'awaiting_user', 'resolved', 'rejected']);
const ALLOWED_PRIORITIES = new Set(['low', 'medium', 'high']);

function getAuth(req) {
  const u = req.user || {}; // set by dashboardController.verifyToken
  if (u.adminId) return { role: 'Admin', id: u.adminId };
  if (u.brandId) return { role: 'Brand', id: u.brandId };
  if (u.influencerId) return { role: 'Influencer', id: u.influencerId };
  return { role: 'Unknown', id: null };
}

function requireUser(req, res) {
  const a = getAuth(req);
  if (a.role === 'Brand' || a.role === 'Influencer') return a;
  res.status(403).json({ message: 'Forbidden' });
  return null;
}

// In environments without dedicated admin login, allow any authenticated user
// (Brand or Influencer) to access admin endpoints.
function requireAdmin(req, res) {
  const a = getAuth(req);
  // Allow all (including unauthenticated/Unknown) if you don't want admin login
  if (a.role === 'Admin' || a.role === 'Brand' || a.role === 'Influencer' || a.role === 'Unknown') return a;
  res.status(403).json({ message: 'Admin only' });
  return null;
}

exports.createDispute = async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return; // response already sent

  try {
    const {
      campaignId,
      brandId,
      influencerId,
      subject,
      description = '',
      priority = 'medium',
      related
    } = req.body || {};

    if (!brandId || !influencerId || !subject) {
      return res.status(400).json({ message: 'brandId, influencerId and subject are required' });
    }
    if (!ALLOWED_PRIORITIES.has(String(priority))) {
      return res.status(400).json({ message: 'Invalid priority' });
    }

    // Enforce identity consistency: user can only create for self
    if (me.role === 'Brand' && me.id !== String(brandId)) {
      return res.status(403).json({ message: 'You can only create disputes for your own brandId' });
    }
    if (me.role === 'Influencer' && me.id !== String(influencerId)) {
      return res.status(403).json({ message: 'You can only create disputes for your own influencerId' });
    }

    // If campaignId provided, validate it belongs to brand
    // If campaignId provided, try to validate; if not found, ignore (optional linkage)
    let linkedCampaignId = null;
    if (campaignId) {
      const camp = await Campaign.findOne({ campaignsId: campaignId, brandId });
      if (camp) linkedCampaignId = campaignId; // only link when valid for the brand
    }

    const dispute = new Dispute({
      campaignId: linkedCampaignId, // may be null when not provided or not found
      brandId,
      influencerId,
      subject: String(subject).trim(),
      description: String(description || ''),
      priority: String(priority),
      related: related && typeof related === 'object' ? {
        type: related.type || 'other',
        id: related.id || null
      } : { type: 'other', id: null },
      createdBy: { id: me.id, role: me.role }
    });

    await dispute.save();
    return res.status(201).json({ message: 'Dispute created', disputeId: dispute.disputeId });
  } catch (err) {
    console.error('Error in createDispute:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.listMine = async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return;

  try {
    const {
      page = 1,
      limit = 10,
      status,
      search = ''
    } = req.body || {};

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {};
    if (me.role === 'Brand') filter.brandId = me.id;
    if (me.role === 'Influencer') filter.influencerId = me.id;
    if (status && ALLOWED_STATUSES.has(String(status))) filter.status = String(status);
    if (search && String(search).trim()) {
      const re = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ subject: re }, { description: re }];
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .select('disputeId subject description priority status campaignId brandId influencerId assignedTo comments createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    return res.status(200).json({
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
      disputes: rows
    });
  } catch (err) {
    console.error('Error in listMine:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getById = async (req, res) => {
  const me = getAuth(req);
  const { id } = req.params;
  if (!id) return res.status(400).json({ message: 'Dispute id is required' });

  try {
    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    // Access control
    if (me.role !== 'Admin' && me.role !== 'Unknown') {
      if (me.role === 'Brand' && d.brandId !== me.id) return res.status(403).json({ message: 'Forbidden' });
      if (me.role === 'Influencer' && d.influencerId !== me.id) return res.status(403).json({ message: 'Forbidden' });
    } else if (me.role === 'Unknown') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in getById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.addComment = async (req, res) => {
  const me = getAuth(req);
  const { id } = req.params;
  if (!id) return res.status(400).json({ message: 'Dispute id is required' });

  try {
    const { text, attachments = [] } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    // Access control: involved brand/influencer or admin
    if (me.role === 'Brand' && d.brandId !== me.id) return res.status(403).json({ message: 'Forbidden' });
    if (me.role === 'Influencer' && d.influencerId !== me.id) return res.status(403).json({ message: 'Forbidden' });
    if (me.role !== 'Admin' && me.role !== 'Brand' && me.role !== 'Influencer') return res.status(403).json({ message: 'Forbidden' });

    // No comments allowed once finalized
    if (d.status === 'resolved' || d.status === 'rejected') {
      return res.status(400).json({ message: 'Cannot comment on a finalized dispute' });
    }

    const sanitized = Array.isArray(attachments) ? attachments
      .filter(a => a && a.url)
      .map(a => ({
        url: a.url,
        originalName: a.originalName || null,
        mimeType: a.mimeType || null,
        size: typeof a.size === 'number' ? a.size : undefined
      }))
      : [];

    d.comments.push({
      authorRole: me.role,
      authorId: me.id,
      text: String(text),
      attachments: sanitized
    });
    await d.save();

    return res.status(200).json({ message: 'Comment added' });
  } catch (err) {
    console.error('Error in addComment:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.adminList = async (req, res) => {
  const me = requireAdmin(req, res);
  if (!me) return;

  try {
    const {
      page = 1,
      limit = 10,
      status,
      campaignId,
      brandId,
      influencerId,
      search = ''
    } = req.body || {};

    const p = Math.max(1, parseInt(page, 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const filter = {};
    if (status && ALLOWED_STATUSES.has(String(status))) filter.status = String(status);
    if (campaignId) filter.campaignId = String(campaignId);
    if (brandId) filter.brandId = String(brandId);
    if (influencerId) filter.influencerId = String(influencerId);
    if (search && String(search).trim()) {
      const re = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ subject: re }, { description: re }];
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    return res.status(200).json({ page: p, limit: l, total, totalPages: Math.ceil(total / l), disputes: rows });
  } catch (err) {
    console.error('Error in adminList:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.adminUpdateStatus = async (req, res) => {
  const me = requireAdmin(req, res);
  if (!me) return;

  try {
    const { disputeId, status, resolution } = req.body || {};
    if (!disputeId || !status) {
      return res.status(400).json({ message: 'disputeId and status are required' });
    }
    if (!ALLOWED_STATUSES.has(String(status))) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const d = await Dispute.findOne({ disputeId });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    d.status = String(status);
    if (resolution && String(resolution).trim()) {
      d.comments.push({ authorRole: me.role, authorId: me.id, text: String(resolution) });
    }
    await d.save();

    return res.status(200).json({ message: 'Status updated' });
  } catch (err) {
    console.error('Error in adminUpdateStatus:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.adminAssign = async (req, res) => {
  const me = requireAdmin(req, res);
  if (!me) return;

  try {
    const { disputeId, adminId } = req.body || {};
    if (!disputeId) return res.status(400).json({ message: 'disputeId is required' });

    const d = await Dispute.findOne({ disputeId });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

    let targetAdminId = String(adminId || me.id);
    let name = null;
    try {
      const a = await Admin.findOne({ adminId: targetAdminId }, 'email name').lean();
      if (a) name = a.name || a.email || null;
    } catch {}

    d.assignedTo = { adminId: targetAdminId, name };
    await d.save();
    return res.status(200).json({ message: 'Assigned', assignedTo: d.assignedTo });
  } catch (err) {
    console.error('Error in adminAssign:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
