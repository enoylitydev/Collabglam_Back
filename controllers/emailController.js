// controllers/emailController.js
const {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
} = require("@aws-sdk/client-ses");

const { v4: uuidv4 } = require("uuid");

const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const Campaign = require("../models/campaign");

const { EmailThread, EmailMessage, EmailTemplate } = require("../models/email");

const Invitation = require("../models/NewInvitations");
const MissingEmail = require("../models/MissingEmail");

const { buildInvitationEmail } = require("../template/invitationTemplate");
const { uploadToGridFS } = require("../utils/gridfs");
const {
  getOrCreateBrandAlias,
  getOrCreateInfluencerAlias,
} = require("../utils/emailAliases");

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20MB per file
const BRAND_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 2 days

// ---------- SES CLIENT ----------
const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
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
    } catch (e) { }
  }
  return brand;
}

// ---------- Relay display alias helpers ----------
const DEFAULT_RELAY_DOMAIN = "mail.collabglam.com";

function getRelayDomain() {
  return String(process.env.EMAIL_RELAY_DOMAIN || DEFAULT_RELAY_DOMAIN).trim().toLowerCase();
}

function slugifyLocalPart(name) {
  const slug =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 20) || "";
  return slug || "influencer";
}

function computeInfluencerDisplayAlias(influencer) {
  const domain = getRelayDomain();
  if (influencer?.otpVerified === true) {
    return `${slugifyLocalPart(influencer?.name)}@${domain}`;
  }
  return `influencer@${domain}`;
}

async function ensureThreadInfluencerDisplayAlias(thread, influencer) {
  if (!thread) return;
  const desired = computeInfluencerDisplayAlias(influencer);
  if (thread.influencerDisplayAlias !== desired) {
    thread.influencerDisplayAlias = desired;
    // Keep snapshot name reasonably fresh (optional, but helps for verified transition)
    if (thread.influencerSnapshot && influencer?.name) {
      thread.influencerSnapshot.name = influencer.name;
    }
    await thread.save();
  }
}

async function findInfluencerByIdOrInfluencerId(id) {
  if (!id) return null;
  let inf = await Influencer.findOne({ influencerId: id });
  if (!inf) {
    try {
      inf = await Influencer.findById(id);
    } catch (e) { }
  }
  return inf;
}

async function findCampaignByIdOrCampaignsId(id) {
  if (!id) return null;
  let campaign = await Campaign.findOne({ campaignsId: id });
  if (!campaign) {
    try {
      campaign = await Campaign.findById(id);
    } catch (e) { }
  }
  return campaign;
}

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const PLATFORM_MAP = new Map([
  ["youtube", "youtube"],
  ["yt", "youtube"],
  ["instagram", "instagram"],
  ["ig", "instagram"],
  ["tiktok", "tiktok"],
  ["tt", "tiktok"],
]);

function normalizeHandle(h) {
  if (!h) return "";
  const t = String(h).trim().toLowerCase();
  return t.startsWith("@") ? t : `@${t}`;
}

/**
 * ✅ Brand policy (as you described)
 * If influencer replied (any influencer_to_brand message exists) -> free conversation.
 * If influencer NEVER replied:
 *  - brand can send 1st email anytime
 *  - brand can send 2nd email only after 2 days since 1st email
 *  - after 2nd email, brand cannot send until influencer replies
 */
async function enforceBrandPolicyOrThrow(threadId) {
  // If influencer replied at least once => allow
  const influencerHasReplied = await EmailMessage.exists({
    thread: threadId,
    direction: "influencer_to_brand",
  });
  if (influencerHasReplied) return;

  // Influencer never replied -> apply rule based on brand messages count
  const brandCount = await EmailMessage.countDocuments({
    thread: threadId,
    direction: "brand_to_influencer",
  });

  // First email allowed
  if (brandCount === 0) return;

  // Second email allowed only after 2 days since FIRST email
  if (brandCount === 1) {
    const firstBrandMsg = await EmailMessage.findOne({
      thread: threadId,
      direction: "brand_to_influencer",
    })
      .sort({ createdAt: 1 })
      .select({ createdAt: 1 })
      .lean();

    const firstAt = firstBrandMsg?.createdAt || new Date();
    const nextAllowedAt = new Date(firstAt.getTime() + BRAND_COOLDOWN_MS);

    if (Date.now() < nextAllowedAt.getTime()) {
      const err = new Error(
        `You can send a follow-up after ${nextAllowedAt.toISOString()}`
      );
      err.statusCode = 429;
      err.code = "BRAND_EMAIL_COOLDOWN";
      err.meta = { nextAllowedAt };
      throw err;
    }
    return;
  }

  // brandCount >= 2 and no influencer reply => blocked
  const err = new Error(
    "You already sent a follow-up. Wait for the influencer to reply before sending another email."
  );
  err.statusCode = 409;
  err.code = "BRAND_WAITING_FOR_REPLY";
  throw err;
}

async function getOrCreateThread({ brand, influencer, createdBy, subject }) {
  let thread = await EmailThread.findOne({
    brand: brand._id,
    influencer: influencer._id,
  });

  if (thread) {
    if (!thread.subject && subject) {
      thread.subject = subject;
      await thread.save();
    }
    await ensureThreadInfluencerDisplayAlias(thread, influencer);
    return thread;
  }

  const brandAlias = await getOrCreateBrandAlias(brand);
  const influencerAlias = await getOrCreateInfluencerAlias(influencer);
  const influencerDisplayAlias = computeInfluencerDisplayAlias(influencer);

  thread = await EmailThread.create({
    brand: brand._id,
    influencer: influencer._id,

    brandSnapshot: { name: brand.name, email: brand.email },
    influencerSnapshot: { name: influencer.name || "Influencer", email: influencer.email },

    brandAliasEmail: brandAlias,
    influencerAliasEmail: influencerAlias,
    brandDisplayAlias: brandAlias,
    influencerDisplayAlias: influencerDisplayAlias,

    subject: subject || undefined,
    status: "active",
    createdBy: createdBy || "system",
  });

  return thread;
}

// Very simple template renderer: replaces {{brandName}}, {{influencerName}}, {{platformName}}
function renderTemplateString(str, context = {}) {
  if (!str) return str;
  const map = {
    brandName: context.brandName || "",
    influencerName: context.influencerName || "",
    platformName: process.env.PLATFORM_NAME || "CollabGlam",
  };
  return str.replace(
    /{{\s*(brandName|influencerName|platformName)\s*}}/gi,
    (_, key) => map[key] || ""
  );
}

function buildStandardHtml(bodyText) {
  const safe = String(bodyText || "");
  return `<p>${safe.replace(/\n/g, "<br/>")}</p>
<hr/>
<p style="font-size:12px;color:#666;">
  Sent via ${process.env.PLATFORM_NAME || "CollabGlam"} – your email is hidden.
</p>`;
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((att) => ({
      filename: att.filename || att.name || "attachment",
      contentType: att.contentType || "application/octet-stream",
      contentBase64: att.contentBase64 || att.content || "",
      size: Number(att.size) || 0,
    }))
    : [];
}

async function uploadEmailAttachmentsToGridFS({ req, safeAttachments, metadata }) {
  if (!safeAttachments.length) return [];

  const filesForGrid = safeAttachments.map((att) => {
    const raw = (att.contentBase64 || "").trim();
    const base64 = raw.includes(",") ? raw.split(",").pop() : raw;
    if (!base64) {
      const err = new Error(`Attachment "${att.filename}" has no content`);
      err.statusCode = 400;
      throw err;
    }

    const buffer = Buffer.from(base64, "base64");
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

  return uploadToGridFS(filesForGrid, {
    req,
    prefix: "email",
    metadata,
  });
}

/**
 * Send an email via SES, with optional Reply-To.
 * Supports attachments via RAW email.
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
  const nl = "\r\n";

  try {
    if (attachments && attachments.length) {
      const mixedBoundary = `Mixed_${uuidv4()}`;
      const altBoundary = `Alt_${uuidv4()}`;

      const headers = [
        `From: ${fromName} <${fromAlias}>`,
        `To: ${toRealEmail}`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      ];
      if (replyTo) headers.push(`Reply-To: ${replyTo}`);

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

        const filename = (att.filename || "attachment").replace(/"/g, "'");
        const contentType = att.contentType || "application/octet-stream";

        let base64 = "";
        if (Buffer.isBuffer(att.content)) {
          base64 = att.content.toString("base64");
        } else if (typeof att.content === "string") {
          const trimmed = att.content.trim();
          base64 = trimmed.includes(",") ? trimmed.split(",").pop() : trimmed;
        }
        if (!base64) continue;

        raw += `--${mixedBoundary}${nl}`;
        raw += `Content-Type: ${contentType}; name="${filename}"${nl}`;
        raw += `Content-Disposition: attachment; filename="${filename}"${nl}`;
        raw += `Content-Transfer-Encoding: base64${nl}${nl}`;
        raw += `${base64}${nl}${nl}`;
      }

      raw += `--${mixedBoundary}--`;

      cmd = new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(raw) },
      });
    } else {
      const params = {
        Source: `${fromName} <${fromAlias}>`,
        Destination: { ToAddresses: [toRealEmail] },
        Message: {
          Subject: { Charset: "UTF-8", Data: subject },
          Body: {},
        },
      };

      if (replyTo) params.ReplyToAddresses = [replyTo];
      if (htmlBody) params.Message.Body.Html = { Charset: "UTF-8", Data: htmlBody };
      if (textBody) params.Message.Body.Text = { Charset: "UTF-8", Data: textBody };

      cmd = new SendEmailCommand(params);
    }

    return await ses.send(cmd);
  } catch (err) {
    console.error("SES send error:", err);

    const sesError = (err && err.Error) || {};
    const code = sesError.Code || err.name;
    const message = sesError.Message || err.message || "SES send failed";

    // sandbox "not verified" handling
    if (code === "MessageRejected" && /not verified/i.test(message)) {
      let failingEmail = "";
      const match = message.match(/: ([^ ]+@[^ ]+)/);
      if (match && match[1]) failingEmail = match[1];

      const region = process.env.AWS_REGION || "us-east-1";
      const friendly = failingEmail
        ? `AWS SES rejected the email because "${failingEmail}" is not verified in region ${region}. In SES sandbox mode you must verify both the sender and the recipient email addresses before you can send.`
        : `AWS SES rejected the email because an address is not verified in region ${region}. In SES sandbox mode you must verify both the sender and the recipient email addresses.`;

      const e = new Error(friendly);
      e.statusCode = 400;
      e.code = "SES_IDENTITY_NOT_VERIFIED";
      throw e;
    }

    throw err;
  }
}

/**
 * Resolve influencer + email:
 * - influencerId: existing influencer
 * - invitationId: Invitation -> MissingEmail (cold outreach)
 */
async function resolveInfluencerAndEmail({ influencerId, invitationId, brand }) {
  let influencer = null;
  let influencerName = "";
  let recipientEmail = "";

  if (influencerId) {
    influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!influencer) {
      const err = new Error("Influencer not found");
      err.statusCode = 404;
      throw err;
    }
    recipientEmail = influencer.email;
    influencerName = influencer.name || (influencer.email || "").split("@")[0];
  } else if (invitationId) {
    const invitation = await Invitation.findOne({ invitationId });
    if (!invitation) {
      const err = new Error("Invitation not found");
      err.statusCode = 404;
      throw err;
    }

    // Optional: ensure belongs to brand
    if (brand && invitation.brandId && invitation.brandId !== brand.brandId) {
      const err = new Error("Invitation does not belong to this brand");
      err.statusCode = 403;
      throw err;
    }

    let missing = null;
    if (invitation.missingEmailId) {
      missing = await MissingEmail.findOne({ missingEmailId: invitation.missingEmailId });
    }
    if (!missing) {
      missing = await MissingEmail.findOne({ handle: invitation.handle.toLowerCase() });
    }
    if (!missing) {
      const err = new Error("Recipient email not found for this invitation");
      err.statusCode = 404;
      throw err;
    }

    recipientEmail = missing.email;

    if (missing.youtube && missing.youtube.title) {
      influencerName = missing.youtube.title;
    } else if (missing.handle) {
      influencerName = missing.handle.replace(/^@/, "");
    } else {
      influencerName = (missing.email || "").split("@")[0];
    }

    // reuse influencer by email or create minimal
    influencer = await Influencer.findOne({ email: recipientEmail.toLowerCase() });
    if (!influencer) {
      influencer = await Influencer.create({
        email: recipientEmail.toLowerCase(),
        name: influencerName,
        otpVerified: false,
      });
    }
  } else {
    const err = new Error("Either influencerId or invitationId is required");
    err.statusCode = 400;
    throw err;
  }

  return { influencer, influencerName, recipientEmail };
}

// ---------- Link extraction ----------
function extractCampaignLinkFromText(text = "") {
  const m = String(text).match(/View\s*Campaign:\s*(https?:\/\/\S+)/i);
  return m?.[1] || "";
}

function extractCampaignLinkFromHtml(html = "") {
  const str = String(html);

  let m = str.match(
    /href="(https?:\/\/[^"]*\/influencer\/new-collab\/view-campaign\?id=[^"]+)"/i
  );
  if (m?.[1]) return m[1];

  m = str.match(/href="(https?:\/\/[^"]*\/campaigns\/[^"]+)"/i);
  if (m?.[1]) return m[1];

  m = str.match(/href="(https?:\/\/[^"]+)"/i);
  return m?.[1] || "";
}

function getCampaignLinkForMessage(m) {
  return (
    m.campaignLink ||
    extractCampaignLinkFromText(m.textBody) ||
    extractCampaignLinkFromHtml(m.htmlBody) ||
    ""
  );
}

// ==========================================
// CONTROLLERS
// ==========================================

/**
 * GET /api/email/templates/:key
 */
exports.getTemplateByKey = async (req, res) => {
  try {
    const { key } = req.params;
    const { brandId, influencerId } = req.query;

    const template = await EmailTemplate.findOne({ key });
    if (!template) return res.status(404).json({ error: "Template not found" });

    let brandName = "";
    let influencerName = "";

    if (brandId) {
      const brand = await findBrandByIdOrBrandId(brandId);
      if (brand) brandName = brand.name;
    }

    if (influencerId) {
      const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
      if (influencer) influencerName = influencer.name || "";
    }

    const context = { brandName, influencerName };
    return res.status(200).json({
      templateId: template._id,
      key: template.key,
      name: template.name,
      subject: renderTemplateString(template.subject, context),
      htmlBody: renderTemplateString(template.htmlBody, context),
      textBody: renderTemplateString(template.textBody || "", context),
    });
  } catch (err) {
    console.error("getTemplateByKey error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * POST /api/email/brand-to-influencer
 */
exports.sendBrandToInfluencer = async (req, res) => {
  try {
    const { brandId, influencerId, subject, body, templateId, attachments } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({
        error: "brandId, influencerId, subject and body are required.",
      });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await getOrCreateThread({ brand, influencer, createdBy: "brand", subject });

    // ✅ Enforce your rule BEFORE uploading/sending
    await enforceBrandPolicyOrThrow(thread._id);

    const fromAlias = thread.brandDisplayAlias || thread.brandAliasEmail;
    const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;
    const htmlBody = buildStandardHtml(body);
    const textBody = body;

    const safeAttachments = normalizeAttachments(attachments);

    const uploadedFiles = await uploadEmailAttachmentsToGridFS({
      req,
      safeAttachments,
      metadata: {
        kind: "email-attachment",
        brandId: brand.brandId || String(brand._id),
        influencerId: influencer.influencerId || String(influencer._id),
        direction: "brand_to_influencer",
      },
    });

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

    const attachmentMeta = uploadedFiles.length
      ? uploadedFiles.map((file) => ({
        filename: file.originalName || file.filename,
        contentType: file.mimeType,
        size: file.size,
        storageKey: String(file.id),
        url: file.url,
      }))
      : undefined;

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: "brand_to_influencer",
      fromUser: brand._id,
      fromUserModel: "Brand",
      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.brandAliasEmail,
      fromRealEmail: brand.email,
      toRealEmail: influencer.email,
      toProxyEmail: thread.influencerAliasEmail,
      subject,
      htmlBody,
      textBody,
      template: templateId || null,
      attachments: attachmentMeta,
      sentAt: new Date(),
      messageId: sesResult?.MessageId || undefined,
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = "brand_to_influencer";
    thread.lastMessageSnippet = (textBody || "").slice(0, 200);
    await thread.save();

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: influencer.email, // internal only
      brandAliasEmail: thread.brandAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error("sendBrandToInfluencer error:", err);
    const status = err.statusCode || err?.$metadata?.httpStatusCode || 500;
    return res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code || undefined,
      meta: err.meta || undefined,
    });
  }
};

/**
 * POST /api/email/influencer-to-brand
 */
exports.sendInfluencerToBrand = async (req, res) => {
  try {
    const { brandId, influencerId, subject, body, templateId, attachments } = req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({
        error: "brandId, influencerId, subject and body are required.",
      });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await getOrCreateThread({ brand, influencer, createdBy: "influencer", subject });

    const fromAlias = thread.influencerDisplayAlias || thread.influencerAliasEmail;
    const safeInfluencerName = influencer?.otpVerified === true ? (influencer.name || "Influencer") : "Influencer";
    const fromName = `${influencer.name || "Influencer"} via ${process.env.PLATFORM_NAME || "CollabGlam"
      }`;

    const htmlBody = buildStandardHtml(body);
    const textBody = body;

    const safeAttachments = normalizeAttachments(attachments);

    const uploadedFiles = await uploadEmailAttachmentsToGridFS({
      req,
      safeAttachments,
      metadata: {
        kind: "email-attachment",
        brandId: brand.brandId || String(brand._id),
        influencerId: influencer.influencerId || String(influencer._id),
        direction: "influencer_to_brand",
      },
    });

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
      replyTo: thread.influencerAliasEmail,
      attachments: sesAttachments,
    });

    const attachmentMeta = uploadedFiles.length
      ? uploadedFiles.map((file) => ({
        filename: file.originalName || file.filename,
        contentType: file.mimeType,
        size: file.size,
        storageKey: String(file.id),
        url: file.url,
      }))
      : undefined;

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction: "influencer_to_brand",
      fromUser: influencer._id,
      fromUserModel: "Influencer",
      fromAliasEmail: fromAlias,
      fromProxyEmail: thread.influencerAliasEmail,
      fromRealEmail: influencer.email,
      toRealEmail: brand.email,
      toProxyEmail: thread.brandAliasEmail,
      subject,
      htmlBody,
      textBody,
      template: templateId || null,
      attachments: attachmentMeta,
      sentAt: new Date(),
      messageId: sesResult?.MessageId || undefined,
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = "influencer_to_brand";
    thread.lastMessageSnippet = (textBody || "").slice(0, 200);

    // Optional: if your schema has this field, this will persist; otherwise it's harmless.
    if (thread.hasInfluencerReplied !== undefined) thread.hasInfluencerReplied = true;

    await thread.save();

    return res.status(200).json({
      success: true,
      threadId: thread._id,
      messageId: messageDoc._id,
      recipientEmail: brand.email, // internal only
      brandAliasEmail: thread.brandAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
    });
  } catch (err) {
    console.error("sendInfluencerToBrand error:", err);
    const status = err.statusCode || err?.$metadata?.httpStatusCode || 500;
    return res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code || undefined,
      meta: err.meta || undefined,
    });
  }
};

/**
 * POST /api/email/campaign-invitation
 */
exports.sendCampaignInvitation = async (req, res) => {
  try {
    const result = await sendCampaignInvitationInternal({
      ...req.body,
      _request: req,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("sendCampaignInvitation error:", err);
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code || undefined,
      meta: err.meta || undefined,
    });
  }
};

/**
 * GET /api/email/threads/brand/:brandId
 */
exports.getThreadsForBrand = async (req, res) => {
  try {
    const { brandId } = req.params;
    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const threads = await EmailThread.find({ brand: brand._id })
      .populate("influencer", "name otpVerified influencerId")
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    const sanitized = (threads || []).map((t) => {
      const influencerDoc = t.influencer || null;
      const safeInfluencerDisplay = computeInfluencerDisplayAlias(
        influencerDoc || { otpVerified: false, name: t?.influencerSnapshot?.name }
      );

      return {
        threadId: String(t._id),
        subject: t.subject || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        status: t.status || "active",
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        influencer: {
          influencerId: influencerDoc?.influencerId || null,
          name: influencerDoc?.name || t?.influencerSnapshot?.name || "Influencer",
        },
        brandDisplayAlias: t.brandDisplayAlias || t.brandAliasEmail,
        influencerDisplayAlias: safeInfluencerDisplay,
        brandAliasEmail: t.brandAliasEmail,
      };
    });

    return res.status(200).json({ threads: sanitized });
  } catch (err) {
    console.error("getThreadsForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /api/email/threads/influencer/:influencerId
 */
exports.getThreadsForInfluencer = async (req, res) => {
  try {
    const { influencerId } = req.params;
    const influencer = await findInfluencerByIdOrInfluencerId(influencerId);
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const threads = await EmailThread.find({ influencer: influencer._id }).populate(
      "brand",
      "name email"
    );
    return res.status(200).json({ threads });
  } catch (err) {
    console.error("getThreadsForInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * GET /api/email/messages/:threadId
 */
exports.getMessagesForThread = async (req, res) => {
  try {
    const { threadId } = req.params;

   const thread = await EmailThread.findById(threadId)
      .populate("influencer", "name otpVerified")
      .lean();
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const safeInfluencerDisplay = computeInfluencerDisplayAlias(
      thread.influencer || { otpVerified: false, name: thread?.influencerSnapshot?.name }
    );
    const safeBrandDisplay = thread.brandDisplayAlias || thread.brandAliasEmail;
    const messages = await EmailMessage.find({ thread: threadId })
      .sort({ createdAt: 1 })
      .lean();

    const routingInfluencerAlias = String(thread.influencerAliasEmail || "").toLowerCase();
    const routingBrandAlias = String(thread.brandAliasEmail || "").toLowerCase();

    const rewrite = (val) => {
      const v = String(val || "");
      const n = v.toLowerCase();
      if (routingInfluencerAlias && n === routingInfluencerAlias) return safeInfluencerDisplay;
      if (routingBrandAlias && n === routingBrandAlias) return safeBrandDisplay;
      return v;
    };

    const enriched = (messages || []).map((m) => {
      const out = {
        ...m,
        campaignLink: getCampaignLinkForMessage(m) || null,
      };

      // Replace specific fields called out in requirements
      if (out.fromAliasEmail) out.fromAliasEmail = rewrite(out.fromAliasEmail);
      if (out.fromProxyEmail) out.fromProxyEmail = rewrite(out.fromProxyEmail);
      if (out.toProxyEmail) out.toProxyEmail = rewrite(out.toProxyEmail);

      if (out.direction === "influencer_to_brand") {
        out.fromAliasEmail = safeInfluencerDisplay;
      }
      if (out.direction === "brand_to_influencer") {
        out.toProxyEmail = safeInfluencerDisplay;
      }

      return out;
    });

    return res.status(200).json({ messages: enriched });
  } catch (err) {
    console.error("getMessagesForThread error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ===============================
// Influencer conversation endpoints
// ===============================
exports.getConversationsForCurrentInfluencer = async (req, res) => {
  try {
    const auth = req.influencer;
    if (!auth || !auth.influencerId) return res.status(403).json({ error: "Forbidden" });

    const influencer = await Influencer.findOne({ influencerId: auth.influencerId }).lean();
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate("brand", "name brandId logoUrl")
      .sort({ lastMessageAt: -1 })
      .lean();

    const conversations = threads.map((t) => ({
      id: String(t._id),
      brand: {
        brandId: t.brand?.brandId || null,
        name: t.brand?.name || t.brandSnapshot?.name || "Brand",
        aliasEmail: t.brandAliasEmail,
        logoUrl: t.brand?.logoUrl || null,
      },
      subject: t.subject || t.lastMessageSnippet || "",
      lastMessageAt: t.lastMessageAt,
      lastMessageDirection: t.lastMessageDirection,
      lastMessageSnippet: t.lastMessageSnippet || "",
      influencerAliasEmail: t.influencerAliasEmail,
    }));

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error("getConversationsForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

exports.getConversationForCurrentInfluencer = async (req, res) => {
  try {
    const auth = req.influencer;
    const { id: threadId } = req.params;

    if (!auth || !auth.influencerId) return res.status(403).json({ error: "Forbidden" });

    const influencer = await Influencer.findOne({ influencerId: auth.influencerId });
    if (!influencer) return res.status(404).json({ error: "Influencer not found" });

    const thread = await EmailThread.findById(threadId)
      .populate("brand", "name brandId logoUrl")
      .populate("influencer", "name influencerId")
      .lean();

    if (!thread) return res.status(404).json({ error: "Conversation not found" });
    if (String(thread.influencer) !== String(influencer._id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const messages = await EmailMessage.find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    const mappedMessages = messages.map((m) => ({
      id: String(m._id),
      direction: m.direction,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      subject: m.subject,
      htmlBody: m.htmlBody,
      textBody: m.textBody,
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
          name: thread.brand?.name || thread.brandSnapshot?.name || "Brand",
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
    console.error("getConversationForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ===============================
// Combined Brand lists (keeps your routes working)
// GET  /api/email/influencer/list        -> invitation-based list (compose)
// POST /api/email/brand/influencer-list  -> threads+messages list (brand inbox)
// ===============================
async function invitationBasedList(req, res) {
  const { brandId } = req.query;
  if (!brandId) return res.status(400).json({ error: "brandId query param is required." });

  const brand = await findBrandByIdOrBrandId(brandId);
  if (!brand) return res.status(404).json({ error: "Brand not found" });

  const brandKey = brand.brandId || String(brand._id);
  const invitations = await Invitation.find({ brandId: brandKey }).lean();

  if (!invitations.length) return res.status(200).json({ influencers: [] });

  const influencers = [];
  for (const inv of invitations) {
    try {
      const { influencer, influencerName, recipientEmail } = await resolveInfluencerAndEmail({
        influencerId: null,
        invitationId: inv.invitationId,
        brand,
      });

      if (!recipientEmail) continue;
      const email = recipientEmail.toLowerCase();

      influencers.push({
        _id: influencer._id,
        influencerId: influencer.influencerId,
        name: influencer.name || influencerName || email.split("@")[0],
        email,
        handle: inv.handle,
        platform: inv.platform,
        invitationId: inv.invitationId,
        status: inv.status,
        campaignId: inv.campaignId || null,
      });
    } catch (err) {
      const status = err?.statusCode || err?.status;
      if (status && status >= 400 && status < 500) continue;
      throw err;
    }
  }

  return res.status(200).json({ influencers });
}

async function threadsAndMessagesList(req, res) {
  const brandId = req.body?.brandId || req.query?.brandId;
  const limitRaw = req.body?.limit || req.query?.limit || 20;
  const limit = Math.max(1, Math.min(Number(limitRaw) || 20, 100));

  if (!brandId) return res.status(400).json({ error: "brandId is required." });

  const brand = await findBrandByIdOrBrandId(brandId);
  if (!brand) return res.status(404).json({ error: "Brand not found" });

  const threads = await EmailThread.aggregate([
    { $match: { brand: brand._id } },
    { $sort: { lastMessageAt: -1, updatedAt: -1, createdAt: -1 } },
    { $limit: limit },

    {
      $lookup: {
        from: "influencers",
        localField: "influencer",
        foreignField: "_id",
        as: "influencerDoc",
      },
    },
    { $addFields: { influencerDoc: { $arrayElemAt: ["$influencerDoc", 0] } } },

    {
      $lookup: {
        from: "emailmessages",
        let: { threadId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$thread", "$$threadId"] } } },
          { $sort: { createdAt: 1 } },
          {
            $project: {
              _id: 1,
              direction: 1,
              createdAt: 1,
              sentAt: 1,
              receivedAt: 1,
              subject: 1,
              textBody: 1,
              htmlBody: 1,
              attachments: 1,
            },
          },
        ],
        as: "messages",
      },
    },

    { $addFields: { lastMsg: { $arrayElemAt: ["$messages", -1] } } },

    {
      $project: {
        _id: 1,
        subject: 1,
        lastMessageSnippet: 1,
        lastMessageAt: 1,
        lastMessageDirection: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
        influencerSnapshot: 1,
        influencerDoc: { name: 1, influencerId: 1 },
        messages: 1,
        lastMsg: 1,
      },
    },
  ]);

  const conversations = (threads || []).map((t) => {
    const influencerName =
      t?.influencerDoc?.name || t?.influencerSnapshot?.name || "Influencer";

    const subject = (t.subject || t.lastMsg?.subject || "").trim();
    const snippet =
      (t.lastMessageSnippet || (t.lastMsg?.textBody || "").slice(0, 200) || "").trim();

    const lastAt = t.lastMessageAt || t.lastMsg?.createdAt || t.updatedAt || t.createdAt || null;
    const lastDir = t.lastMessageDirection || t.lastMsg?.direction || null;

    return {
      threadId: String(t._id),
      influencer: {
        influencerId: t?.influencerDoc?.influencerId || null,
        name: influencerName,
      },
      subject,
      snippet,
      lastMessageAt: lastAt,
      lastMessageDirection: lastDir,
      status: t.status || "active",
      messages: Array.isArray(t.messages)
        ? t.messages.map((m) => ({
          id: String(m._id),
          direction: m.direction,
          createdAt: m.createdAt,
          sentAt: m.sentAt,
          receivedAt: m.receivedAt,
          subject: (m.subject || "").trim(),
          textBody: m.textBody || "",
          htmlBody: m.htmlBody || "",
          attachments: m.attachments || [],
        }))
        : [],
    };
  });

  return res.status(200).json({
    brand: { brandId: brand.brandId || String(brand._id), name: brand.name },
    conversations,
  });
}

exports.getInfluencerEmailListForBrand = async (req, res) => {
  try {
    if (req.method === "POST") return await threadsAndMessagesList(req, res);
    return await invitationBasedList(req, res);
  } catch (err) {
    console.error("getInfluencerEmailListForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ===============================
// Campaign invitation preview
// ===============================
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
      return res.status(400).json({ error: "brandId and campaignId are required." });
    }
    if (!influencerId && !invitationId) {
      return res.status(400).json({ error: "Either influencerId or invitationId is required." });
    }

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { influencer, influencerName, recipientEmail } = await resolveInfluencerAndEmail({
      influencerId,
      invitationId,
      brand,
    });

    const brandName = brand.name;
    const campaignTitle =
      campaign.productOrServiceName || campaign.campaignType || campaign.brandName || "Our Campaign";
    const campaignObjective = campaign.goal || "";

    let defaultDeliverables = "";
    if (Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length) {
      defaultDeliverables = campaign.creativeBrief.join(", ");
    } else if (campaign.creativeBriefText) {
      defaultDeliverables = campaign.creativeBriefText;
    } else {
      defaultDeliverables = "Content deliverables to be discussed with you.";
    }
    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes = additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = process.env.CAMPAIGN_BASE_URL || "";
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : "#");

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
    console.error("getCampaignInvitationPreview error:", err);
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || "Internal server error" });
  }
};

// ===============================
// Invitation endpoint (your flow)
// ===============================
exports.handleEmailInvitation = async (req, res) => {
  try {
    const {
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
    } = req.body;

    const rawEmail = (req.body?.email || "").trim().toLowerCase();
    const rawBrandId = (req.body?.brandId || "").trim();
    const rawCampaignId = (req.body?.campaignId || "").trim();
    const rawHandle = (req.body?.handle || "").trim();
    const rawPlatform = (req.body?.platform || "").trim();

    if (!rawEmail) return res.status(400).json({ status: "error", message: "email is required" });
    if (!rawBrandId) return res.status(400).json({ status: "error", message: "brandId is required" });

    const email = rawEmail;

    const brand = await Brand.findOne({ brandId: rawBrandId }, "brandId name").lean();
    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for given brandId",
      });
    }
    const brandName = brand.name || rawBrandId;

    const influencer = await Influencer.findOne({ email }).lean();

    // CASE A: Existing verified influencer
    if (influencer && influencer.influencerId && influencer.otpVerified) {
      const sendResult = await sendCampaignInvitationInternal({
        brandId: rawBrandId,
        campaignId: rawCampaignId || undefined,
        influencerId: influencer.influencerId,
        compensation,
        deliverables,
        additionalNotes,
        subject: customSubject,
        body: customBody,
        attachments,
        _request: req,
      });

      return res.json({
        status: "success",
        message: "Existing influencer found, invitation email sent.",
        isExistingInfluencer: true,
        influencerId: influencer.influencerId,
        influencerName: influencer.name || influencer.fullname || influencer.email || email,
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

    // CASE B: Not verified -> require handle/platform
    if (!rawHandle || !rawPlatform) {
      return res.status(400).json({
        status: "error",
        message: "handle and platform are required when influencer is not signed up",
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: 'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!platform) {
      return res.status(400).json({
        status: "error",
        message: "Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)",
      });
    }

    // Ensure MissingEmail
    let missing = await MissingEmail.findOne({ email });
    if (!missing) missing = await MissingEmail.findOne({ handle });

    if (!missing) {
      missing = await MissingEmail.create({
        email,
        handle,
        platform,
        brandId: rawBrandId,
      });
    } else {
      let changed = false;
      if (email && email !== missing.email) (missing.email = email), (changed = true);
      if (handle && handle !== missing.handle) (missing.handle = handle), (changed = true);
      if (platform && platform !== missing.platform) (missing.platform = platform), (changed = true);
      if (changed) await missing.save();
    }

    // Find/create Invitation
    let invitation = await Invitation.findOne({ brandId: rawBrandId, handle, platform });
    let isNewInvitation = false;

    if (!invitation) {
      invitation = await Invitation.create({
        brandId: rawBrandId,
        handle,
        platform,
        campaignId: rawCampaignId || null,
        status: "available",
        missingEmailId: missing.missingEmailId,
      });
      isNewInvitation = true;
    } else {
      let saveNeeded = false;
      if (rawCampaignId && invitation.campaignId !== rawCampaignId) {
        invitation.campaignId = rawCampaignId;
        saveNeeded = true;
      }
      if (missing.missingEmailId && invitation.missingEmailId !== missing.missingEmailId) {
        invitation.missingEmailId = missing.missingEmailId;
        saveNeeded = true;
      }
      if (saveNeeded) await invitation.save();
    }

    const sendResult = await sendCampaignInvitationInternal({
      brandId: rawBrandId,
      campaignId: rawCampaignId || undefined,
      invitationId: invitation.invitationId,
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
      _request: req,
    });

    return res.json({
      status: "success",
      message: "Email invitation created and sent to this creator.",
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
    console.error("Error in /emails/invitation:", err);
    return res.status(500).json({
      status: "error",
      message: err.message || "Internal server error",
    });
  }
};

// ===============================
// Internal helper: campaign invitation send
// ✅ policy enforced here too
// ===============================
async function sendCampaignInvitationInternal(payload = {}) {
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
    attachments,
    _request,
  } = payload;

  if (!brandId) {
    const err = new Error("brandId is required.");
    err.statusCode = 400;
    throw err;
  }

  if (!influencerId && !invitationId) {
    const err = new Error("Either influencerId or invitationId is required.");
    err.statusCode = 400;
    throw err;
  }

  const brand = await findBrandByIdOrBrandId(brandId);
  if (!brand) {
    const err = new Error("Brand not found");
    err.statusCode = 404;
    throw err;
  }

  const { influencer, influencerName, recipientEmail } = await resolveInfluencerAndEmail({
    influencerId,
    invitationId,
    brand,
  });

  // ✅ Create thread early and enforce policy early
  const thread = await getOrCreateThread({
    brand,
    influencer,
    createdBy: "brand",
    subject: customSubject || undefined,
  });

  await enforceBrandPolicyOrThrow(thread._id);

  // Build subject/body
  let subject = customSubject;
  let htmlBody = "";
  let textBody = "";

  if (campaignId) {
    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) {
      const err = new Error("Campaign not found");
      err.statusCode = 404;
      throw err;
    }

    const brandName = brand.name;
    const campaignTitle =
      campaign.productOrServiceName || campaign.campaignType || campaign.brandName || "Our Campaign";
    const campaignObjective = campaign.goal || "";

    let defaultDeliverables = "";
    if (Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length) {
      defaultDeliverables = campaign.creativeBrief.join(", ");
    } else if (campaign.creativeBriefText) {
      defaultDeliverables = campaign.creativeBriefText;
    } else {
      defaultDeliverables = "Content deliverables to be discussed with you.";
    }
    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes = additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = process.env.CAMPAIGN_BASE_URL || "";
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(/\/$/, "")}/influencer/new-collab/view-campaign?id=${campaign.campaignsId}`
        : "#");

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

    if (customBody && customBody.trim()) {
      const customHtmlBlock = `<p>${customBody
        .split("\n")
        .map((line) => line.trim())
        .join("<br/>")}</p><br/>`;

      const marker =
        '<h3 style="margin-top:24px;margin-bottom:8px;font-size:16px;color:#111827;">Campaign Details</h3>';

      if (templateResult.htmlBody.includes(marker)) {
        htmlBody = templateResult.htmlBody.replace(marker, `${customHtmlBlock}${marker}`);
      } else {
        htmlBody = `${customHtmlBlock}${templateResult.htmlBody}`;
      }

      textBody = `${customBody.trim()}\n\n${templateResult.textBody}`;
    } else {
      htmlBody = templateResult.htmlBody;
      textBody = templateResult.textBody;
    }
  } else {
    subject = subject || `Collaboration opportunity with ${brand.name}`;

    if (customBody && customBody.trim()) {
      textBody = customBody.trim();
      htmlBody = buildStandardHtml(textBody);
    } else {
      const lines = [];
      lines.push(`Hi ${influencerName || "there"},`);
      lines.push("");
      lines.push(`${brand.name} would love to explore a collaboration with you on upcoming content.`);
      lines.push("");
      lines.push("If this sounds interesting, just hit reply and we can go over the details together.");
      lines.push("");
      lines.push("Best,");
      lines.push(`${brand.name} team`);

      textBody = lines.join("\n");
      htmlBody = buildStandardHtml(textBody);
    }
  }

  // Attachments
  const safeAttachments = normalizeAttachments(attachments);

  const uploadedFiles = await uploadEmailAttachmentsToGridFS({
    req: _request,
    safeAttachments,
    metadata: {
      kind: "email-attachment",
      brandId: brand.brandId || String(brand._id),
      influencerId: influencer.influencerId || String(influencer._id),
      invitationId: invitationId || null,
      campaignId: campaignId || null,
      direction: "brand_to_influencer",
      context: "campaign-invitation",
    },
  });

  const sesAttachments = safeAttachments.length
    ? safeAttachments.map((att) => ({
      filename: att.filename,
      contentType: att.contentType,
      content: att.contentBase64,
      size: att.size,
    }))
    : undefined;

  // Send
  const fromAliasPretty = thread.brandDisplayAlias || thread.brandAliasEmail;
  const relayAlias = thread.brandAliasEmail;
  const fromName = `${brand.name} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;

  const sesResult = await sendViaSES({
    fromAlias: fromAliasPretty,
    fromName,
    toRealEmail: recipientEmail,
    subject,
    htmlBody,
    textBody,
    replyTo: relayAlias,
    attachments: sesAttachments,
  });

  // Save message
  const attachmentMeta = uploadedFiles.length
    ? uploadedFiles.map((file) => ({
      filename: file.originalName || file.filename,
      contentType: file.mimeType,
      size: file.size,
      storageKey: String(file.id),
      url: file.url,
    }))
    : undefined;

  const messageDoc = await EmailMessage.create({
    thread: thread._id,
    direction: "brand_to_influencer",
    fromUser: brand._id,
    fromUserModel: "Brand",
    fromAliasEmail: fromAliasPretty,
    fromProxyEmail: thread.brandAliasEmail,
    fromRealEmail: brand.email,
    toRealEmail: recipientEmail,
    toProxyEmail: thread.influencerAliasEmail,
    subject,
    htmlBody,
    textBody,
    template: null,
    attachments: attachmentMeta,
    sentAt: new Date(),
    messageId: sesResult?.MessageId || undefined,
  });

  thread.lastMessageAt = messageDoc.createdAt;
  thread.lastMessageDirection = "brand_to_influencer";
  thread.lastMessageSnippet = (textBody || "").slice(0, 200);
  await thread.save();

  return {
    success: true,
    threadId: thread._id,
    messageId: messageDoc._id,
    recipientEmail,
    brandAliasEmail: thread.brandAliasEmail,
    brandDisplayAlias: thread.brandDisplayAlias,
    influencerDisplayAlias: thread.influencerDisplayAlias,
    subject,
    campaignId: campaignId || null,
  };
}

// export internal helper
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

exports.getInfluencerEmailListForBrand = async (req, res) => {
  try {
    const brandId = req.body?.brandId || req.query?.brandId;
    const limitRaw = req.body?.limit || req.query?.limit || 20;
    const limit = Math.max(1, Math.min(Number(limitRaw) || 20, 100));

    if (!brandId) return res.status(400).json({ error: "brandId is required." });

    const brand = await findBrandByIdOrBrandId(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const threads = await EmailThread.aggregate([
      { $match: { brand: brand._id } },
      { $sort: { lastMessageAt: -1, updatedAt: -1, createdAt: -1 } },
      { $limit: limit },

      // influencer doc (NO email)
      {
        $lookup: {
          from: "influencers",
          localField: "influencer",
          foreignField: "_id",
          as: "influencerDoc",
        },
      },
      { $addFields: { influencerDoc: { $arrayElemAt: ["$influencerDoc", 0] } } },

      // ✅ ALL messages for each thread (oldest -> newest)
      {
        $lookup: {
          from: "emailmessages",
          let: { threadId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$thread", "$$threadId"] } } },
            { $sort: { createdAt: 1 } },
            {
              // ✅ ONLY INCLUDE SAFE FIELDS (no exclusion here)
              $project: {
                _id: 1,
                direction: 1,
                createdAt: 1,
                sentAt: 1,
                receivedAt: 1,
                subject: 1,
                textBody: 1,
                htmlBody: 1,
                attachments: 1,
              },
            },
          ],
          as: "messages",
        },
      },

      // last message fallback
      { $addFields: { lastMsg: { $arrayElemAt: ["$messages", -1] } } },

      {
        $project: {
          _id: 1,
          subject: 1,
          lastMessageSnippet: 1,
          lastMessageAt: 1,
          lastMessageDirection: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,

          influencerSnapshot: 1,
          influencerDoc: { name: 1, influencerId: 1 },

          messages: 1,
          lastMsg: 1,
        },
      },
    ]);

    const conversations = (threads || []).map((t) => {
      const influencerName =
        t?.influencerDoc?.name ||
        t?.influencerSnapshot?.name ||
        "Influencer";

      const subject = (t.subject || t.lastMsg?.subject || "").trim();
      const snippet =
        (t.lastMessageSnippet ||
          (t.lastMsg?.textBody || "").slice(0, 200) ||
          "").trim();

      const lastAt =
        t.lastMessageAt ||
        t.lastMsg?.createdAt ||
        t.updatedAt ||
        t.createdAt ||
        null;

      const lastDir = t.lastMessageDirection || t.lastMsg?.direction || null;

      return {
        threadId: String(t._id),
        influencer: {
          influencerId: t?.influencerDoc?.influencerId || null,
          name: influencerName,
        },
        subject,
        snippet,
        lastMessageAt: lastAt,
        lastMessageDirection: lastDir,
        status: t.status || "active",

        // ✅ ALL messages list
        messages: Array.isArray(t.messages)
          ? t.messages.map((m) => ({
            id: String(m._id),
            direction: m.direction,
            createdAt: m.createdAt,
            sentAt: m.sentAt,
            receivedAt: m.receivedAt,
            subject: (m.subject || "").trim(),
            textBody: m.textBody || "",
            htmlBody: m.htmlBody || "",
            attachments: m.attachments || [],
          }))
          : [],
      };
    });

    return res.status(200).json({
      brand: { brandId: brand.brandId || String(brand._id), name: brand.name },
      conversations,
    });
  } catch (err) {
    console.error("getInfluencerEmailListForBrand (threads+messages) error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
