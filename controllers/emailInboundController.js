// controllers/emailInboundController.js

const Brand       = require('../models/brand');
const Influencer  = require('../models/influencer');
const { EmailThread, EmailMessage } = require('../models/email');
const { findAliasByProxy, getOrCreateBrandAlias, getOrCreateInfluencerAlias } =
  require('../utils/emailAliases');

const RELAY_DOMAIN = (process.env.EMAIL_RELAY_DOMAIN || 'collabglam.com').toLowerCase();

function norm(e) {
  return String(e || '').trim().toLowerCase();
}

// local copy of your helper to avoid cycles, or export from emailController
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
    return thread;
  }

  const brandAlias      = await getOrCreateBrandAlias(brand);
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

    brandAliasEmail:      brandAlias,
    influencerAliasEmail: influencerAlias,
    brandDisplayAlias:      brandAlias,
    influencerDisplayAlias: influencerAlias,

    subject: subject || undefined,
    status: 'active',
    createdBy: createdBy || 'system',
  });

  return thread;
}

/**
 * Generic inbound handler.
 * Wire this either as:
 *   - Express route: POST /emails/inbound
 *   - Or call from Lambda after parsing SES/Mailgun payload into same shape.
 */
exports.handleInboundEmail = async (req, res) => {
  try {
    const {
      from,
      fromName,
      to = [],
      cc = [],
      bcc = [],
      subject,
      html,
      text,
      messageId,
      inReplyTo,
      references = [],
    } = req.body || {};

    const fromRealEmail = norm(from);
    if (!fromRealEmail) {
      return res.status(400).json({ error: 'Missing from address' });
    }

    const allRecipients = [...to, ...cc, ...bcc].map(norm).filter(Boolean);
    const proxyRecipients = allRecipients.filter(addr =>
      addr.endsWith(`@${RELAY_DOMAIN}`)
    );

    if (!proxyRecipients.length) {
      // Not for us
      return res.status(204).end();
    }

    // In 99% of cases there is only one proxy in To:
    const proxyEmail = proxyRecipients[0];
    const alias = await findAliasByProxy(proxyEmail);
    if (!alias) {
      console.warn('[inbound] No EmailAlias for proxy:', proxyEmail);
      return res.status(204).end();
    }

    let brand, influencer;
    let direction;

    if (alias.ownerModel === 'Brand') {
      // Email sent to brand alias -> sender is influencer side
      brand = await Brand.findById(alias.owner);
      if (!brand) {
        console.warn('[inbound] Brand not found for alias:', proxyEmail);
        return res.status(204).end();
      }

      direction = 'influencer_to_brand';

      // try find influencer by external email; create minimal if unknown
      influencer =
        (await Influencer.findOne({ email: fromRealEmail })) ||
        (await Influencer.create({
          email: fromRealEmail,
          name: fromName || fromRealEmail.split('@')[0],
          otpVerified: false,
        }));
    } else {
      // alias.ownerModel === 'Influencer'
      // Email sent to influencer alias -> sender is brand side
      influencer = await Influencer.findById(alias.owner);
      if (!influencer) {
        console.warn('[inbound] Influencer not found for alias:', proxyEmail);
        return res.status(204).end();
      }

      direction = 'brand_to_influencer';

      brand =
        (await Brand.findOne({ email: fromRealEmail })) ||
        (await Brand.create({
          name: fromName || fromRealEmail.split('@')[0],
          email: fromRealEmail,
          password: 'TEMP_PLACEHOLDER_!change', // will be reset if they ever claim
        }));
    }

    const thread = await getOrCreateThread({
      brand,
      influencer,
      createdBy: direction === 'brand_to_influencer' ? 'brand' : 'influencer',
      subject,
    });

    const htmlBody = html || (text ? `<pre>${text}</pre>` : '');
    const textBody = text || '';

    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction,
      fromUser: direction === 'brand_to_influencer' ? brand._id : influencer._id,
      fromUserModel: direction === 'brand_to_influencer' ? 'Brand' : 'Influencer',

      fromAliasEmail: proxyEmail,        // what they replied TO
      fromProxyEmail: proxyEmail,
      fromRealEmail,

      // route to the other side’s real email (internal use only)
      toProxyEmail:
        direction === 'brand_to_influencer'
          ? thread.influencerAliasEmail
          : thread.brandAliasEmail,
      toRealEmail:
        direction === 'brand_to_influencer' ? influencer.email : brand.email,

      subject,
      htmlBody,
      textBody,

      messageId,
      inReplyTo,
      references,

      receivedAt: new Date(),
    });

    thread.lastMessageAt = messageDoc.createdAt;
    thread.lastMessageDirection = direction;
    thread.lastMessageSnippet = textBody.slice(0, 200);
    await thread.save();

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('handleInboundEmail error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
