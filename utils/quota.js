// utils/quota.js
const Brand = require('../models/brand');
const getFeature = require('./getFeature'); // adjust path if needed

function readLimit(featureRow) {
  if (!featureRow) return 0;
  const raw = featureRow.limit ?? featureRow.value ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) {
    throw new Error('brandId is required for quota checks');
  }

  // Only fetch subscription; keep it light
  const brand = await Brand.findOne({ brandId }, 'subscription').lean();
  if (!brand || !brand.subscription) {
    throw new Error('Brand subscription not configured');
  }

  const feature = getFeature.getFeature(brand.subscription, featureKey);

  // Missing feature → unlimited
  if (!feature) {
    return { limit: 0, used: 0, remaining: Infinity };
  }

  const limit = readLimit(feature); // 0 or NaN -> unlimited
  const used = Number(feature.used || 0) || 0;

  // 0 => unlimited
  if (limit === 0) {
    return { limit: 0, used, remaining: Infinity };
  }

  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = 'QUOTA_EXCEEDED';
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }

  await Brand.updateOne(
    { brandId, 'subscription.features.key': featureKey },
    { $inc: { 'subscription.features.$.used': amount } }
  );

  return {
    limit,
    used: used + amount,
    remaining: limit - (used + amount),
  };
}

module.exports = {
  ensureBrandQuota,
  readLimit,
};
