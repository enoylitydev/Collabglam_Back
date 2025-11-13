// utils/subscriptionHelper.js
const SubscriptionPlan = require('../models/subscription');

exports.getFreePlan = async (role) => {
  const targetName = role === 'Brand' ? 'free' : 'basic';

  let plan = await SubscriptionPlan
    .findOne({ role, name: targetName })
    .select('+features +featureList +perks +durationMins +durationMinutes +durationDays');

  if (!plan) {
    plan = await SubscriptionPlan
      .findOne({ role, name: new RegExp(`^${targetName}$`, 'i') })
      .select('+features +featureList +perks +durationMins +durationMinutes +durationDays');
  }

  if (!plan) return null;

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

// 👇 NEW: compute from a provided start date (fallback to now), and guarantee expiry > start
exports.computeExpiry = (plan = {}, fromDate = new Date()) => {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Accept various duration fields (strings or numbers). Priority: minutes → minutesAlt → days.
  // If none set, default remains 30 days (43200 mins). If you want exactly 1 day, set plan.durationDays = 1.
  const minutes =
    (toNum(plan.durationMins) > 0 && toNum(plan.durationMins)) ||
    (toNum(plan.durationMinutes) > 0 && toNum(plan.durationMinutes)) ||
    (toNum(plan.durationDays) > 0 && toNum(plan.durationDays) * 1440) ||
    43200; // 30 days

  const start = new Date(fromDate);
  const exp = new Date(start.getTime() + minutes * 60 * 1000);

  // Ensure strictly greater than start (handles any weird zero-duration edge cases)
  if (exp.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 1000); // +1 minute minimum
  }
  return exp;
};
