// controllers/emailController.js
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const { EmailThread, EmailMessage, EmailTemplate } = require('../models/email');
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const ChatRoom = require('../models/chat');
const { buildInvitationEmail } = require('../template/invitationTemplate');
const { v4: uuidv4 } = require('uuid');

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

/**
 * Get or create a thread for a Brand + Influencer pair.
 *
 * Semantics:
 * - brandAliasEmail: per-BRAND alias (e.g. adidas@collabglam.cloud). Stored on Brand.
 * - brandDisplayAlias: same as brandAliasEmail; used for UI / From.
 * - influencerAliasEmail: global alias influencer@collabglam.cloud (same for all).
 */
async function getOrCreateThread({ brand, influencer, createdBy }) {
  let thread = await EmailThread.findOne({
    brand: brand._id,
    influencer: influencer._id,
  });

  if (thread) return thread;

  // ✅ Prefer alias stored on Brand (generated at signup)
  let brandAlias = brand.brandAliasEmail;

  // Backfill for legacy brands that don't have brandAliasEmail yet
  if (!brandAlias) {
    brandAlias = EmailThread.generateAliasEmail(brand.name);
    brand.brandAliasEmail = brandAlias;
    try {
      await brand.save();
    } catch (e) {
      console.error(
        'Failed to backfill brandAliasEmail on Brand:',
        e?.message || e
      );
    }
  }

  // Global influencer alias (same for all)
  const influencerGlobalAlias = `influencer@${process.env.EMAIL_RELAY_DOMAIN || 'collabglam.cloud'}`;

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

    // ✅ alias and display are the same
    brandAliasEmail: brandAlias,
    influencerAliasEmail: influencerGlobalAlias,
    brandDisplayAlias: brandAlias,
    influencerDisplayAlias: influencerGlobalAlias,

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
}) {
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

  const cmd = new SendEmailCommand(params);

  try {
    return await ses.send(cmd);
  } catch (err) {
    console.error('SES send error:', err);

    const sesError = (err && err.Error) || {};
    const code = sesError.Code || err.name;
    const message = sesError.Message || err.message || 'SES send failed';

    // 🔥 Handle sandbox "not verified" nicely
    if (code === 'MessageRejected' && /not verified/i.test(message)) {
      // try to extract failing email from Amazon message
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

    // anything else – bubble up as-is
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
    const { brandId, influencerId, subject, body, templateId } = req.body;

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
      createdBy: 'brand',
    });

    const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
    const relayAlias = thread.brandAliasEmail;

    const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || 'CollabGlam'
      }`;

    const htmlBody = `<p>${body.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <p style="font-size:12px;color:#666;">
        Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
      </p>`;
    const textBody = body;

    await sendViaSES({
      fromAlias: fromAliasPretty,
      fromName,
      toRealEmail: influencer.email,
      subject,
      htmlBody,
      textBody,
      replyTo: relayAlias,
    });

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: 'brand_to_influencer',
      fromUser: brand._id,
      fromUserModel: 'Brand',
      fromAliasEmail: fromAliasPretty,
      toRealEmail: influencer.email,
      subject,
      htmlBody,
      textBody,
      template: templateId || null,
    });

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: influencer.email,
      brandAliasEmail: thread.brandAliasEmail,
      influencerAliasEmail: thread.influencerAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error('sendBrandToInfluencer error:', err);
    const status =
      err.statusCode || err?.$metadata?.httpStatusCode || 500;
    return res
      .status(status)
      .json({ error: err.message || 'Internal server error' });
  }
};

/**
 * POST /api/email/influencer-to-brand
 * Body:
 *  - influencerId
 *  - brandId
 *  - subject
 *  - body
 *  - templateId (optional)
 *
 * Influencer -> Brand
 * From: "Influencer via CollabGlam" <influencer@collabglam.cloud>
 * Reply-To: <b-adidas-xxxxxx@collabglam.cloud> (same relay)
 */
exports.sendInfluencerToBrand = async (req, res) => {
  try {
    const { brandId, influencerId, subject, body, templateId } = req.body;

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
    });

    const globalInfluencerAlias = thread.influencerAliasEmail; // influencer@collabglam.cloud
    const relayAlias = thread.brandAliasEmail;

    const fromName = `${influencer.name || 'Influencer'} via ${process.env.PLATFORM_NAME || 'CollabGlam'
      }`;

    const htmlBody = `<p>${body.replace(/\n/g, '<br/>')}</p>
      <hr/>
      <p style="font-size:12px;color:#666;">
        Sent via ${process.env.PLATFORM_NAME || 'CollabGlam'} – your email is hidden.
      </p>`;
    const textBody = body;

    await sendViaSES({
      fromAlias: globalInfluencerAlias,
      fromName,
      toRealEmail: brand.email,
      subject,
      htmlBody,
      textBody,
      replyTo: relayAlias,
    });

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: 'influencer_to_brand',
      fromUser: influencer._id,
      fromUserModel: 'Influencer',
      fromAliasEmail: globalInfluencerAlias,
      toRealEmail: brand.email,
      subject,
      htmlBody,
      textBody,
      template: templateId || null,
    });

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: brand.email,
      brandAliasEmail: thread.brandAliasEmail,
      influencerAliasEmail: thread.influencerAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error('sendInfluencerToBrand error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

exports.sendCampaignInvitation = async (req, res) => {
  try {
    const {
      brandId,
      campaignId, // now OPTIONAL
      influencerId,
      invitationId,
      campaignLink,
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody, // text the brand typed in the compose modal
    } = req.body;

    // ✅ Only brandId is strictly required here
    if (!brandId) {
      return res
        .status(400)
        .json({ error: 'brandId is required.' });
    }

    // Still require at least influencerId or invitationId
    if (!influencerId && !invitationId) {
      return res.status(400).json({
        error: 'Either influencerId or invitationId is required.',
      });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Resolve influencer + email (works for both normal influencers and invitations)
    const { influencer, influencerName, recipientEmail } =
      await resolveInfluencerAndEmail({ influencerId, invitationId, brand });

    let subject = customSubject;
    let htmlBody;
    let textBody;

    /* ────────────────────────────────────────────────────────────── */
    /* PATH 1: Campaign-based invitation (campaignId present)        */
    /* ────────────────────────────────────────────────────────────── */
    if (campaignId) {
      const campaign = await findCampaignByIdOrCampaignsId(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
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
          ? `${baseUrl.replace(/\/$/, '')}/campaigns/${campaign.campaignsId}`
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
      /* ──────────────────────────────────────────────────────────── */
      /* PATH 2: NO CAMPAIGN (generic collab email)                  */
      /* ──────────────────────────────────────────────────────────── */

      // Default subject if none provided
      subject =
        subject ||
        `Collaboration opportunity with ${brand.name}`;

      const safeBody =
        (customBody && customBody.trim()) ||
        `Hi ${influencerName || 'there'},

${brand.name} would love to collaborate with you on upcoming content.

[Add your brief, deliverables, timelines, and budget details here]

Best,
${brand.name} team`;

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

    // Create / reuse thread + send via SES (same as before)
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
    });

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
    });

    return res.status(200).json({
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
    });
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

/**
 * GET /api/email/messages/:threadId
 * to list all messages in a thread (for showing chat-like view).
 */
exports.getMessagesForThread = async (req, res) => {
  try {
    const { threadId } = req.params;
    const messages = await EmailMessage.find({ thread: threadId }).sort({
      createdAt: 1,
    });

    return res.status(200).json({ messages });
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
        ? `${baseUrl.replace(/\/$/, '')}/campaigns/${campaign.campaignsId}`
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
    const brand = await Brand.findOne(
      { brandId: rawBrandId },
      'brandId name'
    ).lean();

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
    // CASE A: Existing influencer → ensure chat room
    // ─────────────────────────────────────────────
    if (influencer && influencer.influencerId && influencer.otpVerified) {
      const influencerId = influencer.influencerId;
      const influencerName =
        influencer.name ||
        influencer.fullname ||
        influencer.email ||
        email;

      // Look for an existing 1:1 room between this brand & influencer
      let room = await ChatRoom.findOne({
        'participants.userId': { $all: [rawBrandId, influencerId] },
        'participants.2': { $exists: false }, // ensure only 2 participants
      });

      if (!room) {
        const participants = [
          { userId: rawBrandId, name: brandName, role: 'brand' },
          { userId: influencerId, name: influencerName, role: 'influencer' },
        ].sort((a, b) => (a.userId > b.userId ? 1 : -1)); // same sortParticipants logic

        try {
          // IMPORTANT:
          // If you keep a UNIQUE index on messages.messageId,
          // either:
          //  - fix the index as discussed (drop unique or partial unique), OR
          //  - always create with at least one message with a unique messageId.
          //
          // If messages are optional, you can simply do:
          //   room = await ChatRoom.create({ participants });
          //
          // If you want to avoid the null-messageId conflict, use a system message:
          room = await ChatRoom.create({ participants });
        } catch (err) {
          // Handle race conditions / duplicate-key on messages.messageId gracefully
          if (
            err &&
            err.code === 11000 &&
            err.keyPattern &&
            err.keyPattern['messages.messageId']
          ) {
            // Another process may have created the room or a message concurrently.
            // Try to fetch the room again:
            room = await ChatRoom.findOne({
              'participants.userId': { $all: [rawBrandId, influencerId] },
              'participants.2': { $exists: false },
            });

            if (!room) {
              // Still no room – bubble the error so you can see it in logs
              console.error('Duplicate key on messages.messageId and no room found:', err);
              return res.status(500).json({
                status: 'error',
                message: 'Failed to create chat room (messages index conflict).',
              });
            }
          } else {
            console.error('Error creating chat room:', err);
            return res.status(500).json({
              status: 'error',
              message: 'Failed to create chat room.',
            });
          }
        }
      }

      // Success: existing influencer + chat room ready
      return res.json({
        status: 'success',
        message: 'Existing influencer found, redirect to chat room.',
        isExistingInfluencer: true,
        influencerId,
        influencerName,
        brandName,
        roomId: room.roomId,
      });
    }

    // ─────────────────────────────────────────────
    // CASE B: No influencer account → prepare email invitation
    // ─────────────────────────────────────────────

    // We now require handle + platform so we can tie an Invitation
    if (!rawHandle || !rawPlatform) {
      return res.status(400).json({
        status: 'error',
        message: 'handle and platform are required when influencer is not signed up',
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

    // Find or create Invitation for (brandId, handle, platform)
    let invitation = await Invitation.findOne({
      brandId: rawBrandId,
      handle,
      platform,
    });

    if (!invitation) {
      // No invitation yet → create with status "invited"
      invitation = await Invitation.create({
        brandId: rawBrandId,
        handle,
        platform,
        campaignId: rawCampaignId || null,
        status: 'invited',
      });
    } else if (rawCampaignId && invitation.campaignId !== rawCampaignId) {
      // Update existing invitation's campaignId if needed
      invitation.campaignId = rawCampaignId;
      await invitation.save();
    }

    return res.json({
      status: 'success',
      message: 'Email invitation ready for this creator.',
      isExistingInfluencer: false,
      brandName,
      invitationId: invitation.invitationId,
    });
  } catch (err) {
    console.error('Error in /emails/invitation:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error',
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
        ? `${baseUrl.replace(/\/$/, '')}/campaigns/${campaign.campaignsId}`
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

    // Subject: custom if provided, else a nice default
    subject =
      subject ||
      `Collaboration opportunity with ${brand.name}`;

    // If brand wrote a custom body in the compose modal, use it as-is
    // (apart from footer), to avoid surprising them.
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
      // Auto-generate a clean, generic collab email using optional fields
      const lines = [];

      lines.push(`Hi ${influencerName || 'there'},`);
      lines.push('');
      lines.push(
        `${brand.name} would love to explore a collaboration with you on upcoming content.`
      );

      const deliverablesText = Array.isArray(deliverables)
        ? deliverables.join(', ')
        : (deliverables || '');

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
  });

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
