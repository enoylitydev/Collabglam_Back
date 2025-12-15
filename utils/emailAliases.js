// utils/emailAliases.js

const EmailAlias = require('../models/emailAlias');
const { EmailThread } = require('../models/email'); // destructure from module.exports
const Brand       = require('../models/brand');
const Influencer  = require('../models/influencer');

const RELAY_DOMAIN = process.env.EMAIL_RELAY_DOMAIN || 'collabglam.com';

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^-+|-+$/g, '');
}

async function reserveProxyEmail(base) {
  const local = slugify(base) || 'user';
  let alias = `${local}@${RELAY_DOMAIN}`;
  let n = 1;

  // ensure uniqueness across EmailAlias
  while (await EmailAlias.findOne({ proxyEmail: alias })) {
    alias = `${local}${n}@${RELAY_DOMAIN}`;
    n += 1;
  }
  return alias;
}

/**
 * Brand aliases: brandname@collabglam.com
 */
async function getOrCreateBrandAlias(brand) {
  if (brand.brandAliasEmail) return brand.brandAliasEmail;

  const base = brand.slug || brand.name || brand.brandId || brand._id.toString();
  const alias = await reserveProxyEmail(base);

  brand.brandAliasEmail = alias;
  await brand.save();

  await EmailAlias.findOneAndUpdate(
    { proxyEmail: alias },
    {
      $setOnInsert: {
        ownerModel: 'Brand',
        owner: brand._id,
        proxyEmail: alias,
      },
      $set: {
        externalEmail: String(brand.email || '').toLowerCase(),
        status: 'active',
      },
    },
    { upsert: true, new: true }
  );

  return alias;
}

/**
 * Influencer aliases: influencerhandle@collabglam.com
 * Prefer a public handle if you store one, fallback to name/email/id.
 */
async function getOrCreateInfluencerAlias(influencer) {
  if (influencer.influencerAliasEmail) return influencer.influencerAliasEmail;

  const base =
    influencer.publicHandle ||
    influencer.username ||
    influencer.name ||
    (influencer.email || '').split('@')[0] ||
    influencer.influencerId ||
    influencer._id.toString();

  const alias = await reserveProxyEmail(base);

  influencer.influencerAliasEmail = alias;
  await influencer.save();

  await EmailAlias.findOneAndUpdate(
    { proxyEmail: alias },
    {
      $setOnInsert: {
        ownerModel: 'Influencer',
        owner: influencer._id,
        proxyEmail: alias,
      },
      $set: {
        externalEmail: String(influencer.email || '').toLowerCase(),
        status: 'active',
      },
    },
    { upsert: true, new: true }
  );

  return alias;
}

/** Lookup alias record by proxy email (used by inbound handler). */
async function findAliasByProxy(proxyEmail) {
  if (!proxyEmail) return null;
  return EmailAlias.findOne({
    proxyEmail: String(proxyEmail).trim().toLowerCase(),
    status: 'active',
  });
}

/** For “claim external email” flow – attach external emails to an influencer. */
async function attachExternalEmailToInfluencer(influencer, externalEmail) {
  const normalized = String(externalEmail || '').trim().toLowerCase();
  if (!normalized) return;

  // Update all existing alias docs that already reference this external email
  await EmailAlias.updateMany(
    { externalEmail: normalized, ownerModel: 'Influencer' },
    {
      $set: {
        owner: influencer._id,
        status: 'active',
        verifiedAt: new Date(),
      },
    }
  );

  // If there is no alias yet for this external email, create a “secondary” mapping
  const existing = await EmailAlias.findOne({
    ownerModel: 'Influencer',
    owner: influencer._id,
    externalEmail: normalized,
  });
  if (!existing) {
    // We do NOT create a new proxy address here; we just store the mapping
    await EmailAlias.create({
      ownerModel: 'Influencer',
      owner: influencer._id,
      proxyEmail: influencer.influencerAliasEmail, // re-use their main alias
      externalEmail: normalized,
      status: 'active',
      verifiedAt: new Date(),
    });
  }
}

module.exports = {
  getOrCreateBrandAlias,
  getOrCreateInfluencerAlias,
  findAliasByProxy,
  attachExternalEmailToInfluencer,
};
