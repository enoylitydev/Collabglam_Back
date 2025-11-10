// controllers/disputeController.js
const nodemailer = require('nodemailer');
const Dispute = require('../models/dispute');
const Campaign = require('../models/campaign');
const Admin = require('../models/admin');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');

const ALLOWED_STATUSES = new Set(['open', 'in_review', 'awaiting_user', 'resolved', 'rejected']);

// ---- env / mailer ----
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const JWT_SECRET = process.env.JWT_SECRET; // (unused here, kept as requested)

const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'CollabGlam Disputes';

// Optional deep-link bases (if you have panel URLs)
const ADMIN_DISPUTE_URL_BASE = process.env.ADMIN_DISPUTE_URL_BASE || '';
const BRAND_DISPUTE_URL_BASE = process.env.BRAND_DISPUTE_URL_BASE || '';
const INFLUENCER_DISPUTE_URL_BASE = process.env.INFLUENCER_DISPUTE_URL_BASE || '';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ----------------- auth helpers -----------------
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

// Relaxed admin policy as in original file:
function requireAdmin(req, res) {
  const a = getAuth(req);
  if (a.role === 'Admin' || a.role === 'Brand' || a.role === 'Influencer' || a.role === 'Unknown') return a;
  res.status(403).json({ message: 'Admin only' });
  return null;
}

// ----------------- mail helpers -----------------
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const nl2br = (s = '') => esc(s).replace(/\r?\n/g, '<br>');
const safe = (v) => (v == null || v === '' ? '—' : esc(String(v)));

// ================= THEME: ORANGE / YELLOW =================

// Shell
const WRAP = 'max-width:680px;margin:0 auto;padding:0;background:#f7fafc;color:#0f172a;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';
const SHELL = 'padding:24px;';
const CARD  = 'border-radius:14px;background:#ffffff;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.04);';

// Header (white with warm border) + thin orange→amber accent strip
const BRAND_BAR  = 'padding:18px 20px;background:#ffffff;color:#111827;border-bottom:1px solid #FFE8B7;';
const BRAND_NAME = 'font-weight:900;font-size:16px;letter-spacing:.2px;';
const ACCENT_BAR = 'height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);';

// Body typography & layout
const HDR   = 'padding:20px 24px 6px 24px;font-weight:800;font-size:18px;color:#111827;';
const SUBHDR= 'padding:0 24px 16px 24px;color:#374151;font-size:13px;';
const BODY  = 'padding:0 24px 24px 24px;';
const KVTBL = 'width:100%;border-collapse:separate;border-spacing:0 8px;';
const KEY   = 'width:160px;color:#6b7280;font-size:13px;padding:6px 0;vertical-align:top;';
const VAL   = 'color:#111827;font-size:14px;font-weight:600;padding:6px 0;';

// Base chip; we tint via statusBadge
const CHIP  = 'display:inline-block;padding:2px 10px;border-radius:999px;background:#f9fafb;border:1px solid #e5e7eb;color:#111827;font-weight:700;font-size:12px;';

const BOX   = 'border:1px dashed #e5e7eb;border-radius:10px;padding:12px 14px;background:#fafafa;';
const FOOT  = 'padding:16px 24px;color:#6b7280;font-size:12px;border-top:1px solid #f1f5f9;background:#fcfcfd;';

// Buttons: black primary; orange gradient alt
const BTN   = 'display:inline-block;background:#111827;color:#ffffff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:800;';
const BTN_ALT = 'display:inline-block;background:linear-gradient(90deg,#FF6A00,#FF8A00,#FFBF00);color:#ffffff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:800;';

const GRID2 = 'display:grid;grid-template-columns:1fr;gap:12px;margin:10px 0 0 0;';
const GRID2_MD = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0 0 0;';
const H6    = 'margin:0 0 6px 0;font-weight:700;font-size:13px;color:#111827;';
const SMALL = 'color:#6b7280;font-size:12px;';
const PREHEADER = (t) => `<div style="display:none;opacity:0;visibility:hidden;overflow:hidden;height:0;width:0;mso-hide:all;">${esc(t)}</div>`;

// Nice “party box” for Brand / Influencer
function partyBox(label, { name, email, id }) {
  return `
  <div style="${BOX}">
    <div style="${H6}">${esc(label)}</div>
    <div style="font-weight:700;color:#111827;">${safe(name)}</div>
    <div style="${SMALL}">${email ? esc(email) : '—'}</div>
    <div style="${SMALL}">ID: ${safe(id)}</div>
  </div>`;
}

// --- extra helpers for UX ---
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return safe(iso); }
}

// Status badge hues (orange/yellow for non-final; semantic green/red for final)
function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  const orange = `${CHIP};background:#FFF7E6;border-color:#FFE2B3;color:#7A3E00;`;
  const styles = {
    open:          orange,
    in_review:     orange,
    awaiting_user: orange,
    resolved:      `${CHIP};background:#ecfdf5;border-color:#a7f3d0;color:#065f46;`,
    rejected:      `${CHIP};background:#fef2f2;border-color:#fecaca;color:#991b1b;`,
  };
  return `<span style="${styles[s] || orange}">${esc(status)}</span>`;
}

function viewLinkBlock(url, label) {
  if (!url) return '';
  return `
    <div style="margin-top:16px;">
      <a href="${url}" style="${BTN}">${esc(label)}</a>
      <div style="${SMALL};margin-top:8px;">If the button doesn’t work, copy &amp; paste this link:<br><span style="word-break:break-all;color:#111827;">${esc(url)}</span></div>
    </div>`;
}

// ----------- ✉️ Templates (sleek, orange/yellow) -----------

function adminCreatedTemplate({ dispute, brand, influencer, campaign }) {
  const raisedByRole = dispute?.createdBy?.role || 'User';
  const raisedBy =
    raisedByRole === 'Brand' ? brand :
    raisedByRole === 'Influencer' ? influencer : null;

  const counterparty =
    raisedByRole === 'Brand' ? influencer :
    raisedByRole === 'Influencer' ? brand : null;

  const viewUrl = ADMIN_DISPUTE_URL_BASE
    ? `${ADMIN_DISPUTE_URL_BASE}/${encodeURIComponent(dispute.disputeId)}`
    : null;

  const status = dispute?.status || 'open';
  const preheader = `New dispute submitted by ${raisedByRole}: “${dispute.subject}”`;

  return `
  ${PREHEADER(preheader)}
  <div style="${WRAP}">
    <div style="${SHELL}">
      <div style="${CARD}">
        <div style="${BRAND_BAR}">
          <div style="${BRAND_NAME}">CollabGlam • Disputes</div>
        </div>
        <div style="${ACCENT_BAR}"></div>

        <div style="${HDR}">New Dispute ${statusBadge(status)}</div>
        <div style="${SUBHDR}">
          A new dispute was submitted. Review the details and take action.
        </div>

        <div style="${BODY}">
          <div style="${GRID2}">
            <table style="${KVTBL}">
              <tr>
                <td style="${KEY}">Subject</td>
                <td style="${VAL}">${esc(dispute.subject)}</td>
              </tr>
              <tr>
                <td style="${KEY}">Campaign</td>
                <td style="${VAL}">${safe(campaign?.productOrServiceName || 'N/A')}</td>
              </tr>
              <tr>
                <td style="${KEY}">Created</td>
                <td style="${VAL}">${fmtDate(dispute.createdAt)}</td>
              </tr>
              <tr>
                <td style="${KEY}">Reference</td>
                <td style="${VAL}">#${safe(dispute.disputeId)}</td>
              </tr>
            </table>
          </div>

          <div style="margin-top:12px;${GRID2_MD}">
            ${partyBox('Raised by', {
              name: raisedBy?.name,
              email: raisedBy?.email,
              id: raisedByRole === 'Brand' ? brand?.brandId : influencer?.influencerId
            })}
            ${partyBox('Counterparty', {
              name: counterparty?.name,
              email: counterparty?.email,
              id: raisedByRole === 'Brand' ? influencer?.influencerId : brand?.brandId
            })}
          </div>

          ${dispute.description
            ? `<div style="margin-top:14px;">
                 <div style="${H6}">Description</div>
                 <div style="font-weight:600;color:#111827;">${nl2br(dispute.description)}</div>
               </div>`
            : ''
          }

          ${viewLinkBlock(viewUrl, 'Open in Admin')}
        </div>

        <div style="${FOOT}">
          You’re receiving this because you’re an administrator for CollabGlam Disputes.
        </div>
      </div>
    </div>
  </div>`;
}

function statusUpdatedTemplate({ dispute, brand, influencer, toRole }) {
  const roleIsBrand = toRole === 'Brand';
  const viewUrl = roleIsBrand
    ? (BRAND_DISPUTE_URL_BASE ? `${BRAND_DISPUTE_URL_BASE}/${encodeURIComponent(dispute.disputeId)}` : null)
    : (INFLUENCER_DISPUTE_URL_BASE ? `${INFLUENCER_DISPUTE_URL_BASE}/${encodeURIComponent(dispute.disputeId)}` : null);

  const recipientName = roleIsBrand ? (brand?.name || 'there') : (influencer?.name || 'there');
  const otherPartyName = roleIsBrand ? (influencer?.name || '') : (brand?.name || '');
  const latestNote = Array.isArray(dispute.comments) && dispute.comments.length
    ? dispute.comments[dispute.comments.length - 1]?.text
    : '';

  const preheader = `Your dispute “${dispute.subject}” is now ${dispute.status}.`;

  return `
  ${PREHEADER(preheader)}
  <div style="${WRAP}">
    <div style="${SHELL}">
      <div style="${CARD}">
        <div style="${BRAND_BAR}">
          <div style="${BRAND_NAME}">CollabGlam • Disputes</div>
        </div>
        <div style="${ACCENT_BAR}"></div>

        <div style="${HDR}">Status Updated ${statusBadge(dispute.status)}</div>
        <div style="${SUBHDR}">
          Hi ${esc(recipientName)}, the status of your dispute has changed.
        </div>

        <div style="${BODY}">
          <table style="${KVTBL}">
            <tr>
              <td style="${KEY}">Subject</td>
              <td style="${VAL}">${esc(dispute.subject)}</td>
            </tr>
            <tr>
              <td style="${KEY}">Current status</td>
              <td style="${VAL}">${statusBadge(dispute.status)}</td>
            </tr>
            <tr>
              <td style="${KEY}">Other party</td>
              <td style="${VAL}">${safe(otherPartyName)}</td>
            </tr>
            <tr>
              <td style="${KEY}">Last updated</td>
              <td style="${VAL}">${fmtDate(dispute.updatedAt)}</td>
            </tr>
            <tr>
              <td style="${KEY}">Reference</td>
              <td style="${VAL}">#${safe(dispute.disputeId)}</td>
            </tr>
            ${latestNote
              ? `<tr>
                   <td style="${KEY}">Latest note</td>
                   <td style="${VAL}">${nl2br(latestNote)}</td>
                 </tr>`
              : ''
            }
          </table>

          ${viewLinkBlock(viewUrl, 'View Dispute')}
        </div>

        <div style="${FOOT}">
          Need help? Reply to this email or contact support.
        </div>
      </div>
    </div>
  </div>`;
}

async function sendMail({ to, subject, html }) {
  if (!to || !SMTP_HOST || !SMTP_USER) {
    console.warn('[mailer] Missing recipient or SMTP config; skipping email');
    return;
  }
  try {
    await transporter.sendMail({
      from: `"${MAIL_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
    });
  } catch (e) {
    console.error('[mailer] sendMail failed:', e?.message || e);
  }
}

// ----------------- ROUTES (business logic) -----------------

exports.createDispute = async (req, res) => {
  const me = requireUser(req, res);
  if (!me) return; 

  try {
    const {
      campaignId,
      brandId,
      influencerId,
      subject,
      description = '',
    } = req.body || {};

    if (!brandId || !influencerId || !subject) {
      return res.status(400).json({ message: 'brandId, influencerId and subject are required' });
    }

    // Enforce identity consistency: user can only create for self
    if (me.role === 'Brand' && me.id !== String(brandId)) {
      return res.status(403).json({ message: 'You can only create disputes for your own brandId' });
    }
    if (me.role === 'Influencer' && me.id !== String(influencerId)) {
      return res.status(403).json({ message: 'You can only create disputes for your own influencerId' });
    }

    // If campaignId provided, validate it belongs to brand
    let linkedCampaignId = null;
    if (campaignId) {
      const camp = await Campaign.findOne({ campaignsId: campaignId, brandId });
      if (camp) linkedCampaignId = campaignId; // only link when valid for the brand
    }

    const dispute = new Dispute({
      campaignId: linkedCampaignId, // may be null
      brandId,
      influencerId,
      subject: String(subject).trim(),
      description: String(description || ''),
      createdBy: { id: me.id, role: me.role }
    });

    await dispute.save();

    // ---- email admin on create (fire-and-forget) ----
    try {
      const [brand, influencer, campaign] = await Promise.all([
        Brand.findOne({ brandId }).select('brandId name email').lean(),
        Influencer.findOne({ influencerId }).select('influencerId name email').lean(),
        linkedCampaignId
          ? Campaign.findOne({ campaignsId: linkedCampaignId }).select('campaignsId productOrServiceName').lean()
          : null,
      ]);
      const html = adminCreatedTemplate({ dispute: dispute.toObject ? dispute.toObject() : dispute, brand, influencer, campaign });
      await sendMail({
        to: 'priyanshuyad2001@gmail.com',
        subject: `New Dispute • #${dispute.disputeId} • ${dispute.subject}`,
        html,
      });
    } catch (e) {
      console.error('[mailer] admin notification on create failed:', e?.message || e);
    }

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
      search = '',
      appliedBy
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
    if (appliedBy && typeof appliedBy === 'string') {
      const role = String(appliedBy).toLowerCase();
      if (role === 'brand') filter['createdBy.role'] = 'Brand';
      if (role === 'influencer') filter['createdBy.role'] = 'Influencer';
    }

    // By default, influencers should only see disputes they created themselves
    if (me.role === 'Influencer' && !appliedBy) {
      filter['createdBy.role'] = 'Influencer';
      filter['createdBy.id'] = me.id;
    }

    const total = await Dispute.countDocuments(filter);
    const rows = await Dispute.find(filter)
      .select('disputeId subject description status campaignId brandId influencerId assignedTo comments createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean();

    // Enrich with campaign name
    try {
      const campaignIds = Array.from(new Set(rows.map(r => r.campaignId).filter(Boolean))).map(String);
      const campaigns = campaignIds.length
        ? await Campaign.find({ campaignsId: { $in: campaignIds } })
            .select('campaignsId productOrServiceName')
            .lean()
        : [];
      const cmap = new Map((campaigns || []).map(c => [String(c.campaignsId), c.productOrServiceName]));
      const enriched = rows.map(r => ({ ...r, campaignName: r.campaignId ? (cmap.get(String(r.campaignId)) || null) : null }));

      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: enriched
      });
    } catch {
      return res.status(200).json({
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
        disputes: rows
      });
    }
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

    // Enrich with campaign name
    try {
      if (d.campaignId) {
        const c = await Campaign.findOne({ campaignsId: d.campaignId }).select('campaignsId productOrServiceName').lean();
        d.campaignName = c?.productOrServiceName || null;
      } else {
        d.campaignName = null;
      }
    } catch {}

    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in getById:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// Admin-friendly detail view
exports.adminGetById = async (req, res) => {
  const me = requireAdmin(req, res);
  if (!me) return;

  const { id } = req.params;
  if (!id) return res.status(400).json({ message: 'Dispute id is required' });

  try {
    const d = await Dispute.findOne({ disputeId: id }).lean();
    if (!d) return res.status(404).json({ message: 'Dispute not found' });
    try {
      const [b, inf] = await Promise.all([
        d.brandId ? Brand.findOne({ brandId: d.brandId }).select('brandId name').lean() : null,
        d.influencerId ? Influencer.findOne({ influencerId: d.influencerId }).select('influencerId name').lean() : null,
      ]);
      d.brandName = b?.name || null;
      d.influencerName = inf?.name || null;
    } catch {}
    return res.status(200).json({ dispute: d });
  } catch (err) {
    console.error('Error in adminGetById:', err);
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

// Admin-friendly add comment (relaxed auth)
exports.adminAddComment = async (req, res) => {
  const me = requireAdmin(req, res);
  if (!me) return;

  const { id } = req.params;
  if (!id) return res.status(400).json({ message: 'Dispute id is required' });

  try {
    const { text, attachments = [] } = req.body || {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ message: 'text is required' });
    }

    const d = await Dispute.findOne({ disputeId: id });
    if (!d) return res.status(404).json({ message: 'Dispute not found' });

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

    const authorRole = me.role === 'Unknown' ? 'Admin' : me.role;
    const authorId = me.id || req.body?.adminId || 'system';

    d.comments.push({
      authorRole,
      authorId,
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
      search = '',
      appliedBy
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

    // Enrich with brand/influencer names
    try {
      const brandIds = Array.from(new Set(rows.map(r => r.brandId).filter(Boolean))).map(String);
      const influencerIds = Array.from(new Set(rows.map(r => r.influencerId).filter(Boolean))).map(String);

      const [brands, influencers] = await Promise.all([
        brandIds.length ? Brand.find({ brandId: { $in: brandIds } }).select('brandId name').lean() : [],
        influencerIds.length ? Influencer.find({ influencerId: { $in: influencerIds } }).select('influencerId name').lean() : [],
      ]);

      const brandMap = new Map((brands || []).map(b => [String(b.brandId), b.name]));
      const infMap = new Map((influencers || []).map(i => [String(i.influencerId), i.name]));

      const enriched = rows.map(r => ({
        ...r,
        brandName: brandMap.get(String(r.brandId)) || null,
        influencerName: infMap.get(String(r.influencerId)) || null,
      }));

      return res.status(200).json({ page: p, limit: l, total, totalPages: Math.ceil(total / l), disputes: enriched });
    } catch {
      return res.status(200).json({ page: p, limit: l, total, totalPages: Math.ceil(total / l), disputes: rows });
    }
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
      const authorRole = me.role === 'Unknown' ? 'Admin' : me.role;
      const authorId = me.id || req.body?.adminId || 'system';
      d.comments.push({ authorRole, authorId, text: String(resolution) });
    }
    await d.save();

    // ---- email the dispute creator on status update (fire-and-forget) ----
    try {
      const [brand, influencer] = await Promise.all([
        d.brandId ? Brand.findOne({ brandId: d.brandId }).select('brandId name email').lean() : null,
        d.influencerId ? Influencer.findOne({ influencerId: d.influencerId }).select('influencerId name email').lean() : null,
      ]);

      const creatorRole = d.createdBy?.role;
      let to = null;
      if (creatorRole === 'Brand') to = brand?.email || null;
      else if (creatorRole === 'Influencer') to = influencer?.email || null;

      if (to) {
        const disputeForEmail = d.toObject ? d.toObject() : d;
        const html = statusUpdatedTemplate({ dispute: disputeForEmail, brand, influencer, toRole: creatorRole });
        await sendMail({
          to,
          subject: `Dispute #${d.disputeId} • Status updated to ${d.status}`,
          html,
        });
      } else {
        console.warn('[mailer] No creator email found to notify on status update');
      }
    } catch (e) {
      console.error('[mailer] creator notification on status failed:', e?.message || e);
    }

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
