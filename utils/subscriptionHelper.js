const SubscriptionPlan = require('../models/subscription');

exports.getFreePlan = async (role) => {
  const targetName = role === 'Brand' ? 'free' : 'basic';

  // Try exact name (include hidden fields); then case-insensitive fallback
  let plan = await SubscriptionPlan
    .findOne({ role, name: targetName })
    .select('+features +featureList +perks +durationMins +durationMinutes +durationDays');

  if (!plan) {
    plan = await SubscriptionPlan
      .findOne({ role, name: new RegExp(`^${targetName}$`, 'i') })
      .select('+features +featureList +perks +durationMins +durationMinutes +durationDays');
  }

  if (!plan) return null;

  // Normalize to plain object and ensure features exist
  const out = typeof plan.toObject === 'function' ? plan.toObject() : plan;

  let features = Array.isArray(out.features) ? out.features : [];
  if (!features.length) {
    if (Array.isArray(out.featureList) && out.featureList.length) {
      features = out.featureList;
    } else if (Array.isArray(out.perks) && out.perks.length) {
      features = out.perks;
    }
  }
  out.features = features;

  return out;
};


exports.computeExpiry = (plan = {}) => {
  const minutes =
    (Number.isFinite(plan.durationMins) && plan.durationMins > 0 && plan.durationMins) ||
    (Number.isFinite(plan.durationMinutes) && plan.durationMinutes > 0 && plan.durationMinutes) ||
    (Number.isFinite(plan.durationDays) && plan.durationDays > 0 && plan.durationDays * 1440) ||
    43200; // 30 days

  return new Date(Date.now() + minutes * 60 * 1000);
};
