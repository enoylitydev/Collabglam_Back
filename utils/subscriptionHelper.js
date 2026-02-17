// utils/subscriptionHelper.js
const SubscriptionPlan = require("../models/subscription");

/**
 * Returns the FREE plan for a role ("Brand" or "Influencer").
 */
exports.getFreePlan = async (role) => {
  const targetName = "free";

  if (!["Brand", "Influencer"].includes(role)) {
    console.warn("[getFreePlan] Invalid role:", role);
    return null;
  }

  // Exact match first
  let plan = await SubscriptionPlan.findOne({ role, name: targetName })
    .select("+features +durationMins +durationMinutes +durationDays")
    .lean();

  if (!plan) {
    // Case-insensitive fallback
    plan = await SubscriptionPlan.findOne({ role, name: new RegExp(`^${targetName}$`, "i") })
      .select("+features +durationMins +durationMinutes +durationDays")
      .lean();
  }

  if (!plan) {
    console.warn("[getFreePlan] No free plan found for role:", role);
    return null;
  }

  plan.features = Array.isArray(plan.features) ? plan.features : [];
  return plan;
};

/**
 * Compute expiry date.
 * Priority:
 * 1) plan.durationMins (local testing)
 * 2) plan.durationMinutes (legacy)
 * 3) plan.durationDays
 * 4) Default: 30 days
 *
 * fromDate defaults to now, but you can pass existing expiry for renewals.
 */
exports.computeExpiry = (plan = {}, fromDate = new Date()) => {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const minutes =
    (toNum(plan.durationMins) > 0 && toNum(plan.durationMins)) ||
    (toNum(plan.durationMinutes) > 0 && toNum(plan.durationMinutes)) ||
    (toNum(plan.durationDays) > 0 && toNum(plan.durationDays) * 1440) ||
    43200; // 30 days default

  const start = new Date(fromDate);
  const exp = new Date(start.getTime() + minutes * 60 * 1000);

  // Safety guard: never return a past date
  if (exp.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 1000);
  }
  return exp;
};

exports.computePrice = (plan = {}, cycle = "monthly") => {
  if (!plan) return 0;

  if (cycle === "annual") {
    // If annualCost missing, fallback to 12 * monthlyCost
    if (typeof plan.annualCost === "number") return plan.annualCost;
    if (typeof plan.monthlyCost === "number") return plan.monthlyCost * 12;
    return 0;
  }

  return typeof plan.monthlyCost === "number" ? plan.monthlyCost : 0;
};
