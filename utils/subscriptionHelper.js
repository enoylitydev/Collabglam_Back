// utils/subscriptionHelper.js

exports.computeExpiry = (plan = {}, fromDate = new Date(), overrides = null) => {
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const isPlainObject = (v) =>
    v && typeof v === "object" && !(v instanceof Date);

  if (isPlainObject(fromDate)) {
    overrides = fromDate;
    fromDate = new Date();
  }

  overrides = isPlainObject(overrides) ? overrides : {};

  const start = new Date(fromDate);

  // 1) explicit expiresAt wins
  if (overrides.expiresAt) {
    const dt = new Date(overrides.expiresAt);
    if (Number.isNaN(dt.getTime())) throw new Error("Invalid expiresAt");
    if (dt.getTime() <= start.getTime()) {
      // never past
      return new Date(start.getTime() + 60 * 1000);
    }
    return dt;
  }

  // 2) duration overrides (admin-controlled)
  let minutesOverride = 0;
  if (overrides.durationMins != null) {
    minutesOverride = toNum(overrides.durationMins);
  } else if (overrides.durationMinutes != null) {
    minutesOverride = toNum(overrides.durationMinutes);
  } else if (overrides.durationDays != null) {
    minutesOverride = toNum(overrides.durationDays) * 1440;
  }

  // 3) plan defaults (your existing priority)
  const planMinutes =
    (toNum(plan.durationMins) > 0 && toNum(plan.durationMins)) ||
    (toNum(plan.durationMinutes) > 0 && toNum(plan.durationMinutes)) ||
    (toNum(plan.durationDays) > 0 && toNum(plan.durationDays) * 1440) ||
    0;

  // 4) fallback default (monthly/annual optional)
  const defaultMinutes =
    overrides.billingCycle === "annual" ? 525600 : 43200; // 365d vs 30d

  const minutes =
    (minutesOverride > 0 && minutesOverride) ||
    (planMinutes > 0 && planMinutes) ||
    defaultMinutes;

  const exp = new Date(start.getTime() + minutes * 60 * 1000);

  // Safety guard: never return a past date
  if (exp.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 1000);
  }
  return exp;
};