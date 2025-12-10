// utils/subscriptionHelper.js
const SubscriptionPlan = require('../models/subscription');

exports.getFreePlan = async (role) => {
  const targetName = 'free';

  let plan = await SubscriptionPlan
    .findOne({ role, name: targetName })
    .select('+features +durationMins +durationMinutes +durationDays');

  if (!plan) {
    plan = await SubscriptionPlan
      .findOne({ role, name: new RegExp(`^${targetName}$`, 'i') })
      .select('+features +durationMins +durationMinutes +durationDays');
  }

  if (!plan) return null;

  const out = typeof plan.toObject === 'function' ? plan.toObject() : plan;

  // ALWAYS just use features
  out.features = Array.isArray(out.features) ? out.features : [];

  return out;
};

exports.computeExpiry = (plan = {}, fromDate = new Date()) => {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const minutes =
    (toNum(plan.durationMins) > 0 && toNum(plan.durationMins)) ||
    (toNum(plan.durationMinutes) > 0 && toNum(plan.durationMinutes)) ||
    (toNum(plan.durationDays) > 0 && toNum(plan.durationDays) * 1440) ||
    43200; // 30 days

  const start = new Date(fromDate);
  const exp = new Date(start.getTime() + minutes * 60 * 1000);

  if (exp.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 1000);
  }
  return exp;
};
