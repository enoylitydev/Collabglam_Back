// controllers/emailController.js
const { SESClient, SendEmailCommand, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const { EmailThread, EmailMessage, EmailTemplate } = require('../models/email');
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const { buildInvitationEmail } = require('../template/invitationTemplate');
const { uploadToGridFS } = require('../utils/gridfs'); // 🔁 adjust path if different
const { v4: uuidv4 } = require('uuid');
const EmailAlias = require('../models/emailAlias');
const { getOrCreateBrandAlias, getOrCreateInfluencerAlias } = require('../utils/emailAliases');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB per file

// ---------- SES CLIENT (uses AWS keys if provided) ----------
const ses = new SESClient({
  region: process.env.AWS_REGION || 'us-east-1',
  // If running on Lambda/EC2 with IAM role, you can omit credentials.
  // Here we *optionally* wire env keys for local/dev.
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
      : undefined,
});

// ---------- Helpers ----------

async function findBrandByIdOrBrandId(id) {
  if (!id) return null;
  let brand = await Brand.findOne({ brandId: id });
  if (!brand) {
    try {
      brand = await Brand.findById(id);
    } catch (e) {
      // ignore invalid ObjectId
    }
  }
  return brand;
}

async function findInfluencerByIdOrInfluencerId(id) {
  if (!id) return null;
  let inf = await Influencer.findOne({ influencerId: id });
  if (!inf) {
    try {
      inf = await Influencer.findById(id);
    } catch (e) {
      // ignore invalid ObjectId
    }
  }
  return inf;
}

async function findCampaignByIdOrCampaignsId(id) {
  if (!id) return null;

  let campaign = await Campaign.findOne({ campaignsId: id });
  if (!campaign) {
    try {
      campaign = await Campaign.findById(id);
    } catch (e) {
      // ignore invalid ObjectId
    }
  }
  return campaign;
}

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_MAP = new Map([
  ['youtube', 'youtube'], ['yt', 'youtube'],
  ['instagram', 'instagram'], ['ig', 'instagram'],
  ['tiktok', 'tiktok'], ['tt', 'tiktok'],
]);

function normalizeHandle(h) {
  if (!h) return '';
  const t = String(h).trim().toLowerCase();
  return t.startsWith('@') ? t : `@${t}`;
}

function sortParticipants(a, b) {
  return a.userId.localeCompare(b.userId);
}

async function getOrCreateThread({ brand, influencer, createdBy, subject }) {
  let thread = await EmailThread.findOne({
    brand: brand._id,
    influencer: influencer._id,
  });

  if (thread) {
    // Optionally update subject on first message
    if (!thread.subject && subject) {
      thread.subject = subject;
      await thread.save();
    }
    return thread;
  }

  const brandAlias = await getOrCreateBrandAlias(brand);
  const influencerAlias = await getOrCreateInfluencerAlias(influencer);

  thread = await EmailThread.create({
    brand: brand._id,
    influencer: influencer._id,

    brandSnapshot: {
      name: brand.name,
      email: brand.email,
    },
    influencerSnapshot: {
      name: influencer.name || 'Influencer',
      email: influencer.email,
    },

    brandAliasEmail: brandAlias,
    influencerAliasEmail: influencerAlias,
    brandDisplayAlias: brandAlias,
    influencerDisplayAlias: influencerAlias,

    subject: subject || undefined,
    status: 'active',
    createdBy: createdBy || 'system',
  });

  return thread;
}

// Very simple template renderer: replaces {{brandName}}, {{influencerName}}, {{platformName}}
function renderTemplateString(str, context = {}) {
  if (!str) return str;
  const map = {
    brandName: context.brandName || '',
    influencerName: context.influencerName || '',
    platformName: process.env.PLATFORM_NAME || 'CollabGlam',
  };

  return str.replace(
    /{{\s*(brandName|influencerName|platformName)\s*}}/gi,
    (_, key) => {
      return map[key] || '';
    }
  );
}

/**
 * Send an email via SES, with optional Reply-To.
 *
 * - fromAlias: address used in "From"
 * - replyTo: address used in "Reply-To" header (relay)
 */
async function sendViaSES({
  fromAlias,
  fromName,
  toRealEmail,
  subject,
  htmlBody,
  textBody,
  replyTo,
  attachments,
}) {
  let cmd;
  const nl = '\r\n';

  try {
    if (attachments && attachments.length) {
      // ---------- multipart/mixed with attachments ----------
      const mixedBoundary = `Mixed_${uuidv4()}`;
      const altBoundary = `Alt_${uuidv4()}`;

      const headers = [
        `From: ${fromName} <${fromAlias}>`,
        `To: ${toRealEmail}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      ];
      if (replyTo) {
        headers.push(`Reply-To: ${replyTo}`);
      }

      let raw = headers.join(nl) + nl + nl;

      // multipart/alternative (text + html)
      raw += `--${mixedBoundary}${nl}`;
      raw += `Content-Type: multipart/alternative; boundary="${altBoundary}"${nl}${nl}`;

      if (textBody) {
        raw += `--${altBoundary}${nl}`;
        raw += `Content-Type: text/plain; charset="UTF-8"${nl}`;
        raw += `Content-Transfer-Encoding: 7bit${nl}${nl}`;
        raw += `${textBody}${nl}${nl}`;
      }

      if (htmlBody) {
        raw += `--${altBoundary}${nl}`;
        raw += `Content-Type: text/html; charset="UTF-8"${nl}`;
        raw += `Content-Transfer-Encoding: 7bit${nl}${nl}`;
        raw += `${htmlBody}${nl}${nl}`;
      }

      raw += `--${altBoundary}--${nl}${nl}`;

      // Attachments
      for (const att of attachments) {
        if (!att) continue;

        const filename = (att.filename || 'attachment').replace(/"/g, "'");
        const contentType =
          att.contentType || 'application/octet-stream';

        let base64 = '';
        if (Buffer.isBuffer(att.content)) {
          base64 = att.content.toString('base64');
        } else if (typeof att.content === 'string') {
          const trimmed = att.content.trim();
          base64 = trimmed.includes(',')
            ? trimmed.split(',').pop()
            : trimmed;
        }

        if (!base64) continue;

        raw += `--${mixedBoundary}${nl}`;
        raw += `Content-Type: ${contentType}; name="${filename}"${nl}`;
        raw += `Content-Disposition: attachment; filename="${filename}"${nl}`;
        raw += 'Content-Transfer-Encoding: base64' + nl + nl;
        raw += `${base64}${nl}${nl}`;
      }

      raw += `--${mixedBoundary}--`;

      cmd = new SendRawEmailCommand({
        RawMessage: {
          Data: Buffer.from(raw),
        },
      });
    } else {
      // ---------- simple text/html only (no attachments) ----------
      const params = {
        Source: `${fromName} <${fromAlias}>`,
        Destination: {
          ToAddresses: [toRealEmail],
        },
        Message: {
          Subject: { Charset: 'UTF-8', Data: subject },
          Body: {},
        },
      };

      if (replyTo) {
        params.ReplyToAddresses = [replyTo];
      }

      if (htmlBody) {
        params.Message.Body.Html = { Charset: 'UTF-8', Data: htmlBody };
      }
      if (textBody) {
        params.Message.Body.Text = { Charset: 'UTF-8', Data: textBody };
      }

      cmd = new SendEmailCommand(params);
    }

    return await ses.send(cmd);
  } catch (err) {
    console.error('SES send error:', err);

    const sesError = (err && err.Error) || {};
    const code = sesError.Code || err.name;
    const message = sesError.Message || err.message || 'SES send failed';

    // sandbox "not verified" handling
    if (code === 'MessageRejected' && /not verified/i.test(message)) {
      let failingEmail = '';
      const match = message.match(/: ([^ ]+@[^ ]+)/);
      if (match && match[1]) failingEmail = match[1];

      const region = process.env.AWS_REGION || 'us-east-1';

      const friendly = failingEmail
        ? `AWS SES rejected the email because "${failingEmail}" is not verified in region ${region}. In SES sandbox mode you must verify both the sender and the recipient email addresses before you can send.`
        : `AWS SES rejected the email because an address is not verified in region ${region}. In SES sandbox mode you must verify both the sender and the recipient email addresses.`;

      const e = new Error(friendly);
      e.statusCode = 400;
      e.code = 'SES_IDENTITY_NOT_VERIFIED';
      throw e;
    }

    throw err;
  }
}

/**
 * Resolve recipient for campaign invitation:
 * - If influencerId is provided: use Influencer model
 * - Else if invitationId is provided: use Invitation -> MissingEmail
 * Returns: { influencer, influencerName, recipientEmail }
 */
async function resolveInfluencerAndEmail({ influencerId, invitationId, brand }) {
  let influencer = null;
  let influencerName = '';
  let recipientEmail = '';

  if (influencerId) {
    // Normal flow: existing Influencer user
    influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!influencer) {
      const err = new Error('Influencer not found');
      err.statusCode = 404;
      throw err;
    }
    recipientEmail = influencer.email;
    influencerName = influencer.name || (influencer.email || '').split('@')[0];
  } else if (invitationId) {
    // Flow: cold invite via Invitations + MissingEmail
    const invitation = await Invitation.findOne({ invitationId });
    if (!invitation) {
      const err = new Error('Invitation not found');
      err.statusCode = 404;
      throw err;
    }

    // Optional: ensure the invitation belongs to this brand
    if (brand && invitation.brandId && invitation.brandId !== brand.brandId) {
      const err = new Error('Invitation does not belong to this brand');
      err.statusCode = 403;
      throw err;
    }

    let missing = null;
    if (invitation.missingEmailId) {
      missing = await MissingEmail.findOne({
        missingEmailId: invitation.missingEmailId,
      });
    }
    if (!missing) {
      // Fallback by handle if needed
      missing = await MissingEmail.findOne({
        handle: invitation.handle.toLowerCase(),
      });
    }
    if (!missing) {
      const err = new Error('Recipient email not found for this invitation');
      err.statusCode = 404;
      throw err;
    }

    recipientEmail = missing.email;

    if (missing.youtube && missing.youtube.title) {
      influencerName = missing.youtube.title;
    } else if (missing.handle) {
      influencerName = missing.handle.replace(/^@/, '');
    } else {
      influencerName = (missing.email || '').split('@')[0];
    }

    // Try to reuse existing Influencer by email
    influencer = await Influencer.findOne({
      email: recipientEmail.toLowerCase(),
    });
    if (!influencer) {
      // Minimal Influencer so threads work, not OTP verified
      influencer = await Influencer.create({
        email: recipientEmail.toLowerCase(),
        name: influencerName,
        otpVerified: false,
      });
    }
  } else {
    const err = new Error('Either influencerId or invitationId is required');
    err.statusCode = 400;
    throw err;
  }

  return { influencer, influencerName, recipientEmail };
}

// ---------- CONTROLLERS ----------

/**
 * GET /api/email/templates/:key
 * Optional query: brandId, influencerId to pre-fill placeholders
 */
exports.getTemplateByKey = async (req, res) => {
  try {
    const { key } = req.params;
    const { brandId, influencerId } = req.query;

    const template = await EmailTemplate.findOne({ key });
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    let brandName = '';
    let influencerName = '';

    if (brandId) {
      const brand = await findBrandByIdOrBrandId(brandId);
      if (brand) brandName = brand.name;
    }
    if (influencerId) {
      const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
      if (influencer) influencerName = influencer.name || '';
    }

    const context = { brandName, influencerName };
    const renderedSubject = renderTemplateString(template.subject, context);
    const renderedHtml = renderTemplateString(template.htmlBody, context);
    const renderedText = renderTemplateString(template.textBody || '', context);

    return res.status(200).json({
      templateId: template._id,
      key: template.key,
      name: template.name,
      subject: renderedSubject,
      htmlBody: renderedHtml,
      textBody: renderedText,
    });
  } catch (err) {
    console.error('getTemplateByKey error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /api/email/brand-to-influencer
 * Body:
 *  - brandId
 *  - influencerId
 *  - subject
 *  - body (string - plain text)
 *  - templateId (optional, for tracking)
 *
 * Brand -> Influencer
 * From: "Brand via CollabGlam" <adidas@collabglam.cloud>
 * Reply-To: <b-adidas-xxxxxx@collabglam.cloud> (relay)
 */
exports.sendBrandToInfluencer = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      subject,
      body,
      templateId,
      attachments, // [{ filename, contentType, contentBase64, size }]
    } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({
        error: 'brandId, influencerId, subject and body are required.',
      });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);

    if (!brand)
      return res.status(404).json({ error: 'Brand not found' });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: 'brand',
      subject,
    });

    const fromAlias = thread.brandDisplayAlias || thread.brandAliasEmail;
    const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || 'CollabGlam'}`;

    const htmlBody = `<p>${body.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <p style="font-size:12px;color:#666;">
        Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
      </p>`;
    const textBody = body;

    /* ─────────────────────────────────────────────
       1) Normalize incoming attachments from frontend
       ───────────────────────────────────────────── */
    const safeAttachments = Array.isArray(attachments)
      ? attachments.map((att) => ({
        filename: att.filename || att.name || 'attachment',
        contentType: att.contentType || 'application/octet-stream',
        // keep base64 string for SES
        contentBase64: att.contentBase64 || att.content || '',
        size: Number(att.size) || 0,
      }))
      : [];

    /* ─────────────────────────────────────────────
       2) Upload to GridFS with 20MB per-file limit
       ───────────────────────────────────────────── */
    let uploadedFiles = [];
    if (safeAttachments.length) {
      const filesForGrid = safeAttachments.map((att) => {
        const raw = (att.contentBase64 || '').trim();
        const base64 = raw.includes(',') ? raw.split(',').pop() : raw;

        if (!base64) {
          const err = new Error(
            `Attachment "${att.filename}" has no content`
          );
          err.statusCode = 400;
          throw err;
        }

        const buffer = Buffer.from(base64, 'base64');

        // 🔥 enforce 20MB per file
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          const err = new Error(
            `Attachment "${att.filename}" is too large. Max allowed size is 20MB.`
          );
          err.statusCode = 413;
          throw err;
        }

        return {
          originalname: att.filename,
          mimetype: att.contentType,
          buffer,
          size: buffer.length,
        };
      });

      uploadedFiles = await uploadToGridFS(filesForGrid, {
        req, // lets gridfs util build full URL from request
        prefix: 'email',
        metadata: {
          kind: 'email-attachment',
          brandId: brand.brandId || String(brand._id),
          influencerId: influencer.influencerId || String(influencer._id),
        },
      });
    }

    /* ─────────────────────────────────────────────
       3) Attachments for SES (use base64 from frontend)
       ───────────────────────────────────────────── */
    const sesAttachments = safeAttachments.length
      ? safeAttachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        content: att.contentBase64,
        size: att.size,
      }))
      : undefined;

    const sesResult = await sendViaSES({
      fromAlias,
      fromName,
      toRealEmail: influencer.email,
      subject,
      htmlBody,
      textBody,
      replyTo: thread.brandAliasEmail,
      attachments: sesAttachments,
    });

    /* ─────────────────────────────────────────────
       4) Save attachment metadata (with URL) in EmailMessage
       ───────────────────────────────────────────── */
    let attachmentMeta = [];
    if (uploadedFiles.length) {
      attachmentMeta = uploadedFiles.map((file) => ({
        filename: file.originalName || file.filename,
        contentType: file.mimeType,
        size: file.size,
        storageKey: String(file.id), // GridFS file id
        url: file.url,               // direct URL like /file/filename
      }));
    }

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: 'brand_to_influencer',

      fromUser: brand._id,
      fromUserModel: 'Brand',

      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.brandAliasEmail,
      fromRealEmail: brand.email,

      toRealEmail: influencer.email,
      toProxyEmail: thread.influencerAliasEmail,

      subject,
      htmlBody,
      textBody,
      template: templateId || null,

      attachments: attachmentMeta.length ? attachmentMeta : undefined,
      sentAt: new Date(),

      messageId: sesResult?.MessageId || undefined,
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = 'brand_to_influencer';
    thread.lastMessageSnippet = textBody.slice(0, 200);
    await thread.save();

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: influencer.email, // internal only; UI should hide this
      brandAliasEmail: thread.brandAliasEmail,
      influencerAliasEmail: thread.influencerAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error('sendBrandToInfluencer error:', err);
    const status = err.statusCode || err?.$metadata?.httpStatusCode || 500;
    return res
      .status(status)
      .json({ error: err.message || 'Internal server error' });
  }
};

exports.sendInfluencerToBrand = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      subject,
      body,
      templateId,
      attachments, // [{ filename, contentType, contentBase64, size }]
    } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({
        error: 'brandId, influencerId, subject and body are required.',
      });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);

    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: 'influencer',
      subject,
    });

    const fromAlias = thread.influencerAliasEmail;
    const fromName = `${influencer.name || 'Influencer'} via ${process.env.PLATFORM_NAME || 'CollabGlam'}`;

    const htmlBody = `<p>${body.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <p style="font-size:12px;color:#666;">
        Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
      </p>`;
    const textBody = body;

    /* ─────────────────────────────────────────────
       1) Normalize incoming attachments from frontend
       ───────────────────────────────────────────── */
    const safeAttachments = Array.isArray(attachments)
      ? attachments.map((att) => ({
        filename: att.filename || att.name || 'attachment',
        contentType: att.contentType || 'application/octet-stream',
        contentBase64: att.contentBase64 || att.content || '',
        size: Number(att.size) || 0,
      }))
      : [];

    /* ─────────────────────────────────────────────
       2) Upload to GridFS with 20MB per-file limit
       ───────────────────────────────────────────── */
    let uploadedFiles = [];
    if (safeAttachments.length) {
      const filesForGrid = safeAttachments.map((att) => {
        const raw = (att.contentBase64 || '').trim();
        const base64 = raw.includes(',') ? raw.split(',').pop() : raw;

        if (!base64) {
          const err = new Error(`Attachment "${att.filename}" has no content`);
          err.statusCode = 400;
          throw err;
        }

        const buffer = Buffer.from(base64, 'base64');

        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          const err = new Error(
            `Attachment "${att.filename}" is too large. Max allowed size is 20MB.`
          );
          err.statusCode = 413;
          throw err;
        }

        return {
          originalname: att.filename,
          mimetype: att.contentType,
          buffer,
          size: buffer.length,
        };
      });

      uploadedFiles = await uploadToGridFS(filesForGrid, {
        req,
        prefix: 'email',
        metadata: {
          kind: 'email-attachment',
          brandId: brand.brandId || String(brand._id),
          influencerId: influencer.influencerId || String(influencer._id),
          direction: 'influencer_to_brand',
        },
      });
    }

    /* ─────────────────────────────────────────────
       3) Attachments for SES (keep base64 string)
       ───────────────────────────────────────────── */
    const sesAttachments = safeAttachments.length
      ? safeAttachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        content: att.contentBase64,
        size: att.size,
      }))
      : undefined;

    const sesResult = await sendViaSES({
      fromAlias,
      fromName,
      toRealEmail: brand.email,
      subject,
      htmlBody,
      textBody,
      // 🔑 Reply-To MUST be the influencer proxy now
      replyTo: thread.influencerAliasEmail,
      attachments: sesAttachments,
    });

    /* ─────────────────────────────────────────────
       4) Save attachment metadata (with URL) in EmailMessage
       ───────────────────────────────────────────── */
    let attachmentMeta = [];
    if (uploadedFiles.length) {
      attachmentMeta = uploadedFiles.map((file) => ({
        filename: file.originalName || file.filename,
        contentType: file.mimeType,
        size: file.size,
        storageKey: String(file.id),
        url: file.url,
      }));
    }

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: 'influencer_to_brand',
      fromUser: influencer._id,
      fromUserModel: 'Influencer',

      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.influencerAliasEmail,
      fromRealEmail: influencer.email,
      toRealEmail: brand.email,
      toProxyEmail: thread.brandAliasEmail,

      subject,
      htmlBody,
      textBody,
      template: templateId || null,
      attachments: attachmentMeta.length ? attachmentMeta : undefined,

      sentAt: new Date(),
      messageId: sesResult?.MessageId || undefined,
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = 'influencer_to_brand';
    thread.lastMessageSnippet = textBody.slice(0, 200);
    await thread.save();

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: brand.email, // internal only
      brandAliasEmail: thread.brandAliasEmail,
      influencerAliasEmail: thread.influencerAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error('sendInfluencerToBrand error:', err);
    const status = err.statusCode || err?.$metadata?.httpStatusCode || 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
  }
};

exports.sendCampaignInvitation = async (req, res) => {
  try {
    // Delegate to the internal helper so we reuse the same logic
    const result = await sendCampaignInvitationInternal({
      ...req.body,  // includes brandId, campaignId, influencerId/invitationId, attachments, etc.
      _request: req, // pass Express req so GridFS can build URLs
    });

    // Internal helper already returns a nice payload
    return res.status(200).json(result);
  } catch (err) {
    console.error('sendCampaignInvitation error:', err);
    const status = err.statusCode || 500;
    return res
      .status(status)
      .json({ error: err.message || 'Internal server error' });
  }
};

/**
 * GET /api/email/threads/brand/:brandId
 */
exports.getThreadsForBrand = async (req, res) => {
  try {
    const { brandId } = req.params;
    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const threads = await EmailThread.find({ brand: brand._id }).populate(
      'influencer',
      'name email'
    );

    return res.status(200).json({ threads });
  } catch (err) {
    console.error('getThreadsForBrand error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * GET /api/email/threads/influencer/:influencerId
 */
exports.getThreadsForInfluencer = async (req, res) => {
  try {
    const { influencerId } = req.params;
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const threads = await EmailThread.find({
      influencer: influencer._id,
    }).populate('brand', 'name email');

    return res.status(200).json({ threads });
  } catch (err) {
    console.error('getThreadsForInfluencer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function extractCampaignLinkFromText(text = '') {
  // Example in your textBody:
  // "View Campaign: https://collabglam.com/influencer/new-collab/view-campaign?id=..."
  const m = String(text).match(/View\s*Campaign:\s*(https?:\/\/\S+)/i);
  return m?.[1] || '';
}

function extractCampaignLinkFromHtml(html = '') {
  const str = String(html);

  // Prefer the influencer view-campaign link if present
  let m = str.match(/href="(https?:\/\/[^"]*\/influencer\/new-collab\/view-campaign\?id=[^"]+)"/i);
  if (m?.[1]) return m[1];

  // Otherwise allow /campaigns/... link
  m = str.match(/href="(https?:\/\/[^"]*\/campaigns\/[^"]+)"/i);
  if (m?.[1]) return m[1];

  // Last resort: first href
  m = str.match(/href="(https?:\/\/[^"]+)"/i);
  return m?.[1] || '';
}

function getCampaignLinkForMessage(m) {
  // If you later store campaignLink in DB, this will be used automatically
  return (
    m.campaignLink ||
    extractCampaignLinkFromText(m.textBody) ||
    extractCampaignLinkFromHtml(m.htmlBody) ||
    ''
  );
}

exports.getMessagesForThread = async (req, res) => {
  try {
    const { threadId } = req.params;

    const messages = await EmailMessage.find({ thread: threadId })
      .sort({ createdAt: 1 })
      .lean();

    const enriched = messages.map((m) => ({
      ...m,
      campaignLink: getCampaignLinkForMessage(m) || null, // ✅ separate key
    }));

    return res.status(200).json({ messages: enriched });
  } catch (err) {
    console.error('getMessagesForThread error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getInfluencerEmailListForBrand = async (req, res) => {
  try {
    const { brandId } = req.query;

    if (!brandId) {
      return res
        .status(400)
        .json({ error: 'brandId query param is required.' });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // NewInvitation stores brandId as a string (usually brand.brandId)
    const brandKey = brand.brandId || String(brand._id);

    // 🔥 1) Remove status filter → return ALL invitations for this brand
    const invitations = await Invitation.find({
      brandId: brandKey,
    }).lean();

    if (!invitations.length) {
      return res.status(200).json({ influencers: [] });
    }

    const influencers = [];

    for (const inv of invitations) {
      try {
        // Reuse existing helper to resolve influencer + email
        const { influencer, influencerName, recipientEmail } =
          await resolveInfluencerAndEmail({
            influencerId: null,
            invitationId: inv.invitationId,
            brand,
          });

        if (!recipientEmail) {
          // Safety: skip if somehow email is missing
          continue;
        }

        const email = recipientEmail.toLowerCase();

        // 🔥 2) NO dedupe → one entry per invitation
        influencers.push({
          _id: influencer._id,
          influencerId: influencer.influencerId,
          name:
            influencer.name ||
            influencerName ||
            email.split('@')[0],
          email,
          handle: inv.handle,
          platform: inv.platform,
          invitationId: inv.invitationId,
          status: inv.status,      // optional, useful in UI
          campaignId: inv.campaignId || null,
        });
      } catch (err) {
        const status = err?.statusCode || err?.status;

        // For 4xx (invitation/email not found or not belonging to this brand),
        // just skip that invitation.
        if (status && status >= 400 && status < 500) {
          console.warn(
            'Skipping invitation in email-list:',
            inv.invitationId,
            err.message
          );
          continue;
        }

        // For unexpected errors, abort with 500
        console.error(
          'getInfluencerEmailListForBrand resolve error:',
          inv.invitationId,
          err
        );
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    return res.status(200).json({ influencers });
  } catch (err) {
    console.error('getInfluencerEmailListForBrand error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getCampaignInvitationPreview = async (req, res) => {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      invitationId,
      campaignLink,
      compensation,
      deliverables,
      additionalNotes,
    } = req.body;

    if (!brandId || !campaignId) {
      return res
        .status(400)
        .json({ error: 'brandId and campaignId are required.' });
    }

    if (!influencerId && !invitationId) {
      return res.status(400).json({
        error: 'Either influencerId or invitationId is required.',
      });
    }

    // Brand + campaign lookup
    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Resolve influencer + email (re-uses same helper as sendCampaignInvitation)
    const { influencer, influencerName, recipientEmail } =
      await resolveInfluencerAndEmail({ influencerId, invitationId, brand });

    const brandName = brand.name;

    const campaignTitle =
      campaign.productOrServiceName ||
      campaign.campaignType ||
      campaign.brandName ||
      'Our Campaign';

    const campaignObjective = campaign.goal || '';

    let defaultDeliverables = '';
    if (Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length) {
      defaultDeliverables = campaign.creativeBrief.join(', ');
    } else if (campaign.creativeBriefText) {
      defaultDeliverables = campaign.creativeBriefText;
    } else {
      defaultDeliverables = 'Content deliverables to be discussed with you.';
    }
    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      'Compensation will be discussed based on your standard rates and the campaign scope.';

    let timelineText = 'Flexible / To be discussed';
    if (
      campaign.timeline &&
      campaign.timeline.startDate &&
      campaign.timeline.endDate
    ) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString('en-US', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes =
      additionalNotes || campaign.additionalNotes || campaign.description || '';

    const baseUrl = process.env.CAMPAIGN_BASE_URL || '';
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : '#');

    // Build full invitation email (same as sendCampaignInvitation)
    const templateResult = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    // Just return the template; do NOT send via SES or create threads
    return res.status(200).json({
      success: true,
      subject: templateResult.subject,
      htmlBody: templateResult.htmlBody,
      textBody: templateResult.textBody,
      meta: {
        brandName,
        influencerName,
        campaignTitle,
        campaignObjective,
        deliverables: finalDeliverables,
        compensation: finalCompensation,
        timeline: timelineText,
        additionalNotes: notes,
        campaignLink: link,
        recipientEmail,
        influencerId: influencer?.influencerId || influencer?._id,
      },
    });
  } catch (err) {
    console.error('getCampaignInvitationPreview error:', err);
    const status = err.statusCode || 500;
    return res
      .status(status)
      .json({ error: err.message || 'Internal server error' });
  }
};

exports.handleEmailInvitation = async (req, res) => {
  try {
    // Optional extras from frontend
    const {
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments, // OPTIONAL: [{ filename, contentType, contentBase64, size }]
    } = req.body;

    const rawEmail = (req.body?.email || '').trim().toLowerCase();
    const rawBrandId = (req.body?.brandId || '').trim();
    const rawCampaignId = (req.body?.campaignId || '').trim();
    const rawHandle = (req.body?.handle || '').trim();
    const rawPlatform = (req.body?.platform || '').trim();

    // 1) Basic validation
    if (!rawEmail) {
      return res.status(400).json({
        status: 'error',
        message: 'email is required',
      });
    }
    if (!rawBrandId) {
      return res.status(400).json({
        status: 'error',
        message: 'brandId is required',
      });
    }

    const email = rawEmail;

    // 2) Load brand for response context
    const brand = await Brand.findOne({ brandId: rawBrandId }, 'brandId name').lean();
    if (!brand) {
      return res.status(404).json({
        status: 'error',
        message: 'Brand not found for given brandId',
      });
    }

    const brandName = brand.name || rawBrandId;

    // 3) Check if influencer already exists by email
    const influencer = await Influencer.findOne({ email }).lean();

    // ─────────────────────────────────────────────
    // CASE A: Existing influencer → send email ONLY (no chat room)
    // ─────────────────────────────────────────────
    if (influencer && influencer.influencerId && influencer.otpVerified) {
      const influencerId = influencer.influencerId;
      const influencerName =
        influencer.name ||
        influencer.fullname ||
        influencer.email ||
        email;

      // Use internal helper to send the campaign / generic invitation email
      const sendResult = await sendCampaignInvitationInternal({
        brandId: rawBrandId,
        campaignId: rawCampaignId || undefined,
        influencerId,          // existing influencer path
        compensation,
        deliverables,
        additionalNotes,
        subject: customSubject,
        body: customBody,
        attachments,           // forward attachments
        _request: req,         // needed so GridFS can build URLs
      });

      return res.json({
        status: 'success',
        message: 'Existing influencer found, invitation email sent.',
        isExistingInfluencer: true,
        influencerId,
        influencerName,
        brandName,
        emailSent: true,
        emailMeta: {
          recipientEmail: sendResult.recipientEmail,
          threadId: sendResult.threadId,
          messageId: sendResult.messageId,
          subject: sendResult.subject,
          campaignId: sendResult.campaignId,
        },
      });
    }

    // ─────────────────────────────────────────────
    // CASE B: No verified influencer account → create Invitation + send email
    // ─────────────────────────────────────────────

    // We now require handle + platform so we can tie an Invitation
    if (!rawHandle || !rawPlatform) {
      return res.status(400).json({
        status: 'error',
        message:
          'handle and platform are required when influencer is not signed up',
      });
    }

    // Normalize handle
    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    // Normalize platform with aliases
    const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!platform) {
      return res.status(400).json({
        status: 'error',
        message:
          'Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)',
      });
    }

    // 🔥 1) Ensure we have a MissingEmail record for this creator
    let missing = await MissingEmail.findOne({ email });
    if (!missing) {
      // fallback by handle (may already exist with no email)
      missing = await MissingEmail.findOne({ handle });
    }

    if (!missing) {
      // Create a new MissingEmail entry with this email + handle
      missing = await MissingEmail.create({
        email,
        handle,
        platform,
        // brandId is optional – only include if your MissingEmail schema has it
        brandId: rawBrandId,
      });
    } else {
      // Update existing record with the latest email / handle / platform
      let changed = false;

      if (email && email !== missing.email) {
        missing.email = email;
        changed = true;
      }
      if (handle && handle !== missing.handle) {
        missing.handle = handle;
        changed = true;
      }
      if (platform && platform !== missing.platform) {
        missing.platform = platform;
        changed = true;
      }

      if (changed) {
        await missing.save();
      }
    }

    // 🔥 2) Find or create Invitation for (brandId, handle, platform)
    let invitation = await Invitation.findOne({
      brandId: rawBrandId,
      handle,
      platform,
    });

    let isNewInvitation = false;

    if (!invitation) {
      // No invitation yet → create with status "available"
      invitation = await Invitation.create({
        brandId: rawBrandId,
        handle,
        platform,
        campaignId: rawCampaignId || null,
        status: 'available',
        // link to the MissingEmail record we just ensured
        missingEmailId: missing.missingEmailId,
      });
      isNewInvitation = true;
    } else {
      // Update existing invitation's campaignId / missingEmailId if needed
      let saveNeeded = false;

      if (rawCampaignId && invitation.campaignId !== rawCampaignId) {
        invitation.campaignId = rawCampaignId;
        saveNeeded = true;
      }

      if (
        missing.missingEmailId &&
        invitation.missingEmailId !== missing.missingEmailId
      ) {
        invitation.missingEmailId = missing.missingEmailId;
        saveNeeded = true;
      }

      if (saveNeeded) {
        await invitation.save();
      }
    }

    // 🔥 3) Send the actual invitation email using the internal helper
    const sendResult = await sendCampaignInvitationInternal({
      brandId: rawBrandId,
      campaignId: rawCampaignId || undefined,
      invitationId: invitation.invitationId, // use invitation-based flow
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,          // forward attachments
      _request: req,        // again, for GridFS URL building
    });

    return res.json({
      status: 'success',
      message: 'Email invitation created and sent to this creator.',
      isExistingInfluencer: false,
      brandName,
      invitationId: invitation.invitationId,
      emailSent: true,
      emailMeta: {
        recipientEmail: sendResult.recipientEmail,
        threadId: sendResult.threadId,
        messageId: sendResult.messageId,
        subject: sendResult.subject,
        campaignId: sendResult.campaignId,
      },
      isNewInvitation,
    });
  } catch (err) {
    console.error('Error in /emails/invitation:', err);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Internal server error',
    });
  }
};

async function sendCampaignInvitationInternal(payload = {}) {
  const {
    brandId,
    campaignId, // OPTIONAL
    influencerId,
    invitationId,
    campaignLink,
    compensation,
    deliverables,
    additionalNotes,
    subject: customSubject,
    body: customBody, // text the brand typed in the compose modal
    attachments,      // OPTIONAL [{ filename, contentType, contentBase64, size }]
    _request,         // OPTIONAL Express req (from HTTP controller)
  } = payload;

  // ✅ Only brandId is strictly required here
  if (!brandId) {
    const err = new Error('brandId is required.');
    err.statusCode = 400;
    throw err;
  }

  // Still require at least influencerId or invitationId
  if (!influencerId && !invitationId) {
    const err = new Error('Either influencerId or invitationId is required.');
    err.statusCode = 400;
    throw err;
  }

  const brand = await findBrandByIdOrBrandId(brandId);
  if (!brand) {
    const err = new Error('Brand not found');
    err.statusCode = 404;
    throw err;
  }

  // Resolve influencer + email (works for both normal influencers and invitations)
  const { influencer, influencerName, recipientEmail } =
    await resolveInfluencerAndEmail({ influencerId, invitationId, brand });

  let subject = customSubject;
  let htmlBody;
  let textBody;

  /* ────────────────────────────────────────────── */
  /* PATH 1: Campaign-based invitation             */
  /* ────────────────────────────────────────────── */
  if (campaignId) {
    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) {
      const err = new Error('Campaign not found');
      err.statusCode = 404;
      throw err;
    }

    const brandName = brand.name;

    const campaignTitle =
      campaign.productOrServiceName ||
      campaign.campaignType ||
      campaign.brandName ||
      'Our Campaign';

    const campaignObjective = campaign.goal || '';

    let defaultDeliverables = '';
    if (
      Array.isArray(campaign.creativeBrief) &&
      campaign.creativeBrief.length
    ) {
      defaultDeliverables = campaign.creativeBrief.join(', ');
    } else if (campaign.creativeBriefText) {
      defaultDeliverables = campaign.creativeBriefText;
    } else {
      defaultDeliverables = 'Content deliverables to be discussed with you.';
    }
    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      'Compensation will be discussed based on your standard rates and the campaign scope.';

    let timelineText = 'Flexible / To be discussed';
    if (
      campaign.timeline &&
      campaign.timeline.startDate &&
      campaign.timeline.endDate
    ) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString('en-US', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes =
      additionalNotes ||
      campaign.additionalNotes ||
      campaign.description ||
      '';

    const baseUrl = process.env.CAMPAIGN_BASE_URL || '';
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : '#');

    // Build full campaign invitation email
    const templateResult = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    subject = subject || templateResult.subject;

    // If the brand typed custom text, prepend it above "Campaign Details"
    if (customBody && customBody.trim()) {
      const customHtmlBlock = `<p>${customBody
        .split('\n')
        .map((line) => line.trim())
        .join('<br/>')}</p><br/>`;

      const marker =
        '<h3 style="margin-top:24px;margin-bottom:8px;font-size:16px;color:#111827;">Campaign Details</h3>';

      if (templateResult.htmlBody.includes(marker)) {
        htmlBody = templateResult.htmlBody.replace(
          marker,
          `${customHtmlBlock}${marker}`
        );
      } else {
        // Fallback – just prepend the custom block
        htmlBody = `${customHtmlBlock}${templateResult.htmlBody}`;
      }

      // Plain text: prepend the custom note + template text
      textBody = `${customBody.trim()}\n\n${templateResult.textBody}`;
    } else {
      // No custom body → just use the full template
      htmlBody = templateResult.htmlBody;
      textBody = templateResult.textBody;
    }
  } else {
    /* ──────────────────────────────────────────── */
    /* PATH 2: NO CAMPAIGN (generic collab email)  */
    /* ──────────────────────────────────────────── */

    subject =
      subject || `Collaboration opportunity with ${brand.name}`;

    if (customBody && customBody.trim()) {
      const safeBody = customBody.trim();

      htmlBody = `<p>${safeBody
        .split('\n')
        .map((line) => line.trim())
        .join('<br/>')}</p>
        <hr/>
        <p style="font-size:12px;color:#666;">
          Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
        </p>`;

      textBody = safeBody;
    } else {
      const lines = [];

      lines.push(`Hi ${influencerName || 'there'},`);
      lines.push('');
      lines.push(
        `${brand.name} would love to explore a collaboration with you on upcoming content.`
      );

      const deliverablesText = Array.isArray(deliverables)
        ? deliverables.join(', ')
        : deliverables || '';

      const compText = compensation || '';
      const notesText = additionalNotes || '';
      const linkText = campaignLink || '';

      if (deliverablesText) {
        lines.push('');
        lines.push('Here’s what we have in mind:');
        lines.push(deliverablesText);
      }

      if (compText) {
        lines.push('');
        lines.push(`Compensation: ${compText}`);
      }

      if (linkText) {
        lines.push('');
        lines.push(`You can find more details here: ${linkText}`);
      }

      if (notesText) {
        lines.push('');
        lines.push(notesText);
      }

      lines.push('');
      lines.push(
        'If this sounds interesting, just hit reply and we can go over the details together.'
      );
      lines.push('');
      lines.push('Best,');
      lines.push(`${brand.name} team`);

      const safeBody = lines.join('\n');

      htmlBody = `<p>${safeBody
        .split('\n')
        .map((line) => line.trim())
        .join('<br/>')}</p>
        <hr/>
        <p style="font-size:12px;color:#666;">
          Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
        </p>`;

      textBody = safeBody;
    }
  }

  /* ─────────────────────────────────────────────
     1) Normalize incoming attachments
     ───────────────────────────────────────────── */
  const safeAttachments = Array.isArray(attachments)
    ? attachments.map((att) => ({
      filename: att.filename || att.name || 'attachment',
      contentType: att.contentType || 'application/octet-stream',
      contentBase64: att.contentBase64 || att.content || '',
      size: Number(att.size) || 0,
    }))
    : [];

  /* ─────────────────────────────────────────────
     2) Upload to GridFS with 20MB per-file limit
     ───────────────────────────────────────────── */
  let uploadedFiles = [];
  if (safeAttachments.length) {
    const filesForGrid = safeAttachments.map((att) => {
      const raw = (att.contentBase64 || '').trim();
      const base64 = raw.includes(',') ? raw.split(',').pop() : raw;

      if (!base64) {
        const err = new Error(`Attachment "${att.filename}" has no content`);
        err.statusCode = 400;
        throw err;
      }

      const buffer = Buffer.from(base64, 'base64');

      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        const err = new Error(
          `Attachment "${att.filename}" is too large. Max allowed size is 20MB.`
        );
        err.statusCode = 413;
        throw err;
      }

      return {
        originalname: att.filename,
        mimetype: att.contentType,
        buffer,
        size: buffer.length,
      };
    });

    uploadedFiles = await uploadToGridFS(filesForGrid, {
      req: _request,
      prefix: 'email',
      metadata: {
        kind: 'email-attachment',
        brandId: brand.brandId || String(brand._id),
        influencerId: influencer.influencerId || String(influencer._id),
        invitationId: invitationId || null,
        campaignId: campaignId || null,
        direction: 'brand_to_influencer',
        context: 'campaign-invitation',
      },
    });
  }

  /* ─────────────────────────────────────────────
     3) Attachments for SES
     ───────────────────────────────────────────── */
  const sesAttachments = safeAttachments.length
    ? safeAttachments.map((att) => ({
      filename: att.filename,
      contentType: att.contentType,
      content: att.contentBase64,
      size: att.size,
    }))
    : undefined;

  // Create / reuse thread + send via SES
  const thread = await getOrCreateThread({
    brand,
    influencer,
    createdBy: 'brand',
  });

  const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
  const relayAlias = thread.brandAliasEmail;

  const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || 'CollabGlam'
    }`;

  await sendViaSES({
    fromAlias: fromAliasPretty,
    fromName,
    toRealEmail: recipientEmail,
    subject,
    htmlBody,
    textBody,
    replyTo: relayAlias,
    attachments: sesAttachments,
  });

  /* ─────────────────────────────────────────────
     4) Save attachment metadata in EmailMessage
     ───────────────────────────────────────────── */
  let attachmentMeta = [];
  if (uploadedFiles.length) {
    attachmentMeta = uploadedFiles.map((file) => ({
      filename: file.originalName || file.filename,
      contentType: file.mimeType,
      size: file.size,
      storageKey: String(file.id),
      url: file.url,
    }));
  }

  const messageDoc = await EmailMessage.create({
    thread: thread._id,
    direction: 'brand_to_influencer',
    fromUser: brand._id,
    fromUserModel: 'Brand',
    fromAliasEmail: fromAliasPretty,
    toRealEmail: recipientEmail,
    subject,
    htmlBody,
    textBody,
    template: null,
    attachments: attachmentMeta.length ? attachmentMeta : undefined,
  });

  return {
    success: true,
    threadId: thread._id,
    messageId: messageDoc._id,
    recipientEmail,
    brandAliasEmail: thread.brandAliasEmail,
    influencerAliasEmail: thread.influencerAliasEmail,
    brandDisplayAlias: thread.brandDisplayAlias,
    influencerDisplayAlias: thread.influencerDisplayAlias,
    subject,
    campaignId: campaignId || null,
  };
}

// export internal helper so other controllers (admin) can use it
exports._sendCampaignInvitationInternal = sendCampaignInvitationInternal;

exports.getConversationsForCurrentInfluencer = async (req, res) => {
  try {
    const auth = req.influencer;
    if (!auth || !auth.influencerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const influencer = await Influencer.findOne({
      influencerId: auth.influencerId,
    }).lean();
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate('brand', 'name brandId brandAliasEmail logoUrl')
      .sort({ lastMessageAt: -1 })
      .lean();

    const conversations = threads.map(t => ({
      id: String(t._id),
      brand: {
        brandId: t.brand?.brandId || null,
        name: t.brand?.name || t.brandSnapshot?.name || 'Brand',
        aliasEmail: t.brandAliasEmail,
        logoUrl: t.brand?.logoUrl || null,
      },
      subject: t.subject || t.lastMessageSnippet || '',
      lastMessageAt: t.lastMessageAt,
      lastMessageDirection: t.lastMessageDirection,
      lastMessageSnippet: t.lastMessageSnippet || '',
      influencerAliasEmail: t.influencerAliasEmail,
      // NOTE: we do NOT expose brand.email or influencerSnapshot.email
    }));

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error('getConversationsForCurrentInfluencer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getConversationForCurrentInfluencer = async (req, res) => {
  try {
    const auth = req.influencer;
    const { id: threadId } = req.params;

    if (!auth || !auth.influencerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const influencer = await Influencer.findOne({
      influencerId: auth.influencerId,
    });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    const thread = await EmailThread.findById(threadId)
      .populate('brand', 'name brandId brandAliasEmail logoUrl')
      .populate('influencer', 'name influencerId influencerAliasEmail')
      .lean();

    if (!thread) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (String(thread.influencer) !== String(influencer._id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const messages = await EmailMessage.find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    const mappedMessages = messages.map(m => ({
      id: String(m._id),
      direction: m.direction,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      subject: m.subject,
      htmlBody: m.htmlBody,
      textBody: m.textBody,
      // Only proxy addresses – no real emails
      fromAliasEmail: m.fromAliasEmail,
      fromProxyEmail: m.fromProxyEmail,
      toProxyEmail: m.toProxyEmail,
      attachments: m.attachments || [],
    }));

    return res.status(200).json({
      conversation: {
        id: String(thread._id),
        subject: thread.subject,
        brand: {
          brandId: thread.brand?.brandId || null,
          name: thread.brand?.name || thread.brandSnapshot?.name || 'Brand',
          aliasEmail: thread.brandAliasEmail,

          
          logoUrl: thread.brand?.logoUrl || null,
        },
        influencer: {
          influencerId: thread.influencer?.influencerId || auth.influencerId,
          name: thread.influencer?.name || influencer.name,
          aliasEmail: thread.influencerAliasEmail,
        },
        lastMessageAt: thread.lastMessageAt,
        lastMessageDirection: thread.lastMessageDirection,
        messages: mappedMessages,
      },
    });
  } catch (err) {
    console.error('getConversationForCurrentInfluencer error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};