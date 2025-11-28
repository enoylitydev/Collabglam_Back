// controllers/emailController.js
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const { EmailThread, EmailMessage, EmailTemplate } = require('../models/email');
const Invitation = require('../models/NewInvitations');
const MissingEmail = require('../models/MissingEmail');
const Campaign = require('../models/campaign');
const { buildInvitationEmail } = require('../template/invitationTemplate');

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

/**
 * Get or create a thread for a Brand + Influencer pair.
 *
 * Semantics:
 * - brandAliasEmail: per-thread relay (unique). Used as Reply-To and inbound routing.
 * - brandDisplayAlias: pretty brand alias (adidas@collabglam.com) for UI / From.
 * - influencerAliasEmail: global alias influencer@collabglam.com (same for all).
 */
async function getOrCreateThread({ brand, influencer, createdBy }) {
  let thread = await EmailThread.findOne({
    brand: brand._id,
    influencer: influencer._id,
  });

  if (thread) return thread;

  // Technical relay address for this thread (brand-based)
  const relayAliasEmail = EmailThread.generateAliasEmail(brand.name, 'b');

  // Pretty alias for brand (UI + From)
  const brandPrettyAlias = EmailThread.generatePrettyAlias(brand.name);

  // Global influencer alias (same for all)
  const influencerGlobalAlias = `influencer@${process.env.EMAIL_RELAY_DOMAIN}`;

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

    brandAliasEmail: relayAliasEmail, // technical relay
    influencerAliasEmail: influencerGlobalAlias, // global alias
    brandDisplayAlias: brandPrettyAlias, // pretty brand alias
    influencerDisplayAlias: influencerGlobalAlias, // for UI

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
  return ses.send(cmd);
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
 * From: "Brand via CollabGlam" <adidas@collabglam.com>
 * Reply-To: <b-adidas-xxxxxx@collabglam.com> (relay)
 */
exports.sendBrandToInfluencer = async (req, res) => {
  try {
    const { brandId, influencerId, subject, body, templateId } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res
        .status(400)
        .json({
          error: 'brandId, influencerId, subject and body are required.',
        });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);

    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: 'brand',
    });

    const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
    const relayAlias = thread.brandAliasEmail;

    const fromName = `${brand.name} via ${
      process.env.PLATFORM_NAME || 'CollabGlam'
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
    return res.status(500).json({ error: 'Internal server error' });
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
 * From: "Influencer via CollabGlam" <influencer@collabglam.com>
 * Reply-To: <b-adidas-xxxxxx@collabglam.com> (same relay)
 */
exports.sendInfluencerToBrand = async (req, res) => {
  try {
    const { brandId, influencerId, subject, body, templateId } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res
        .status(400)
        .json({
          error: 'brandId, influencerId, subject and body are required.',
        });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);

    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: 'influencer',
    });

    const globalInfluencerAlias = thread.influencerAliasEmail; // influencer@collabglam.com
    const relayAlias = thread.brandAliasEmail;

    const fromName = `${influencer.name || 'Influencer'} via ${
      process.env.PLATFORM_NAME || 'CollabGlam'
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

/**
 * POST /api/email/campaign-invitation
 *
 * ... (unchanged from your latest version, just using sendViaSES above)
 */
exports.sendCampaignInvitation = async (req, res) => {
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
      subject: customSubject,
      body: customBody,
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

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

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

    const subject = customSubject || templateResult.subject;
    const htmlBody = customBody || templateResult.htmlBody;
    const textBody = templateResult.textBody;

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: 'brand',
    });

    const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
    const relayAlias = thread.brandAliasEmail;

    const fromName = `${brand.name} via ${
      process.env.PLATFORM_NAME || 'CollabGlam'
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
    });
  } catch (err) {
    console.error('sendCampaignInvitation error:', err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'Internal server error' });
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

    const threads = await EmailThread.find({ influencer: influencer._id }).populate(
      'brand',
      'name email'
    );

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
