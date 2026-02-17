// controllers/subscriptionController.js
const SubscriptionPlan = require("../models/subscription");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const subscriptionHelper = require("../utils/subscriptionHelper");

// Helper: normalize feature value into a numeric limit for usage tracking snapshot
// - number => that number
// - { unlimited: true } => -1
// - other => 0
function featureValueToLimit(value) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && value.unlimited === true) return -1;
  return 0;
}

// POST /subscription-plans/create
// body: full plan object (role, name, monthlyCost required)
exports.createPlan = async (req, res) => {
  try {
    const {
      role,
      name,
      displayName,
      label,

      monthlyCost,
      annualCost,
      currency,

      isCustomPricing,
      isStartingAt,

      bestFor,
      mainOutcome,
      overview,
      cta,

      features,
      addons,

      durationDays,
      durationMins,
      durationMinutes,
      autoRenew,
      status,
      sortOrder,
    } = req.body;

    if (!role || !name || monthlyCost == null) {
      return res
        .status(400)
        .json({ message: "role, name and monthlyCost are required" });
    }

    // Basic guard (you can loosen if your schema allows more)
    if (!["Brand", "Influencer"].includes(role)) {
      return res.status(400).json({ message: "role must be Brand or Influencer" });
    }

    const plan = new SubscriptionPlan({
      role,
      name,
      displayName: displayName || name.toUpperCase(),
      label: label || undefined,

      monthlyCost,
      annualCost: annualCost ?? undefined,
      currency: currency || "USD",

      isCustomPricing: !!isCustomPricing,
      isStartingAt: !!isStartingAt,

      bestFor: bestFor || undefined,
      mainOutcome: mainOutcome || undefined,
      overview: overview || undefined,
      cta: cta || undefined,

      features: Array.isArray(features) ? features : [],
      addons: Array.isArray(addons) ? addons : [],

      durationDays: durationDays ?? undefined,
      durationMins: durationMins ?? undefined,
      durationMinutes: durationMinutes ?? undefined,

      autoRenew: autoRenew ?? true,
      status: status || "active",
      sortOrder: sortOrder ?? 100,
    });

    await plan.save();
    return res.status(201).json({ message: "Subscription plan created", plan });
  } catch (err) {
    console.error("createPlan error:", err);

    // Duplicate key (role+name unique) or planId unique conflicts
    if (err?.code === 11000) {
      return res.status(409).json({
        message: "Plan already exists (duplicate role+name or planId).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/list
// body: { role?, includeArchived? }
exports.getPlans = async (req, res) => {
  const { role, includeArchived } = req.body || {};
  const filter = {};

  if (role) filter.role = role;
  if (!includeArchived) filter.status = "active";

  try {
    // sortOrder first (pricing table order), then monthlyCost
    const plans = await SubscriptionPlan.find(filter)
      .sort({ sortOrder: 1, monthlyCost: 1 })
      .lean();

    return res.status(200).json({ message: "Plans retrieved", plans });
  } catch (err) {
    console.error("getPlans error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// GET /subscription-plans/get?id=<planId>
exports.getPlanById = async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ message: "Query param id is required" });

  try {
    const plan = await SubscriptionPlan.findOne({ planId: id }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan retrieved", plan });
  } catch (err) {
    console.error("getPlanById error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/update
// body: { planId?: <planId>, id?: <planId>, ...fieldsToUpdate }
exports.updatePlan = async (req, res) => {
  const { planId, id, ...updates } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "planId (or id) is required" });
  }

  // Prevent changing planId via update
  delete updates.planId;

  try {
    const plan = await SubscriptionPlan.findOneAndUpdate(
      { planId: targetPlanId },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan updated", plan });
  } catch (err) {
    console.error("updatePlan error:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        message: "Update causes duplicate role+name (or duplicate unique field).",
        detail: err.keyValue,
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/delete
// body: { planId?: <planId>, id?: <planId> }
exports.deletePlan = async (req, res) => {
  const { planId, id } = req.body || {};
  const targetPlanId = planId || id;

  if (!targetPlanId) {
    return res.status(400).json({ message: "Plan id (planId or id) is required" });
  }

  try {
    const plan = await SubscriptionPlan.findOneAndDelete({ planId: targetPlanId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    return res.status(200).json({ message: "Plan deleted" });
  } catch (err) {
    console.error("deletePlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/assign
// body: { userType: 'Brand'|'Influencer', userId, planId }
exports.assignPlan = async (req, res) => {
  try {
    const { userType, userId, planId } = req.body || {};
    if (!userType || !userId || !planId) {
      return res
        .status(400)
        .json({ message: "userType, userId & planId are required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const plan = await SubscriptionPlan.findOne({ planId }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const expire = subscriptionHelper.computeExpiry(plan);

    // Snapshot for usage tracking:
    // numeric => limit=number
    // unlimited => limit=-1
    // other => limit=0
    const featureSnapshot = (plan.features || []).map((f) => ({
      key: f.key,
      limit: featureValueToLimit(f.value),
      used: 0,
    }));

    const update = {
      "subscription.planId": plan.planId,
      "subscription.planName": plan.name,
      "subscription.startedAt": now,
      "subscription.expiresAt": expire,
      "subscription.features": featureSnapshot,
      subscriptionExpired: false,
    };

    const query =
      userType === "Brand" ? { brandId: userId } : { influencerId: userId };

    const updated = await Model.findOneAndUpdate(query, update, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    return res.json({
      message: `${userType} subscribed to "${plan.name}". It will expire at ${expire.toISOString()}`,
      subscription: updated.subscription,
    });
  } catch (error) {
    console.error("assignPlan error:", error);
    return res
      .status(500)
      .json({ message: "Internal server error while assigning plan." });
  }
};

// POST /subscription-plans/renew
// body: { userType: 'Brand'|'Influencer', userId }
exports.renewPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};
    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const user = await Model.findOne(
      userType === "Brand" ? { brandId: userId } : { influencerId: userId }
    );

    if (!user) {
      return res
        .status(404)
        .json({ message: `${userType} with ID ${userId} not found` });
    }

    const currentPlanId = user?.subscription?.planId;
    if (!currentPlanId) {
      return res.status(400).json({ message: "User has no active subscription planId" });
    }

    const plan = await SubscriptionPlan.findOne({ planId: currentPlanId });
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    const now = new Date();
    const newExpires = subscriptionHelper.computeExpiry(plan, user.subscription.expiresAt);

    user.subscription.startedAt = now;
    user.subscription.expiresAt = newExpires;
    user.subscription.features = (plan.features || []).map((f) => ({
      key: f.key,
      limit: featureValueToLimit(f.value),
      used: 0,
    }));
    user.subscriptionExpired = false;

    await user.save();

    return res.json({
      message: `${userType} subscription renewed until ${newExpires.toISOString()}`,
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("renewPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// POST /subscription-plans/my-plan
// body: { userType: 'Brand'|'Influencer', userId }
exports.getMyPlan = async (req, res) => {
  try {
    const { userType, userId } = req.body || {};
    if (!userType || !userId) {
      return res.status(400).json({ message: "userType & userId required" });
    }

    if (!["Brand", "Influencer"].includes(userType)) {
      return res.status(400).json({ message: "userType must be Brand or Influencer" });
    }

    const Model = userType === "Brand" ? Brand : Influencer;

    const user = await Model.findOne(
      userType === "Brand" ? { brandId: userId } : { influencerId: userId }
    ).lean();

    if (!user) return res.status(404).json({ message: `${userType} not found` });

    const sub = user.subscription || {};
    const planDoc = sub.planId
      ? await SubscriptionPlan.findOne({ planId: sub.planId }).lean()
      : null;

    return res.json({
      message: "Current subscription fetched",
      plan: planDoc, // full plan metadata
      startedAt: sub.startedAt || null,
      expiresAt: sub.expiresAt || null,
      expired: !!user.subscriptionExpired,
    });
  } catch (err) {
    console.error("getMyPlan error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};
