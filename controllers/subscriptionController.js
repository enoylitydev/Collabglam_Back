// controllers/subscriptionController.js
const SubscriptionPlan = require('../models/subscription');
const Brand            = require('../models/brand');
const Influencer       = require('../models/influencer');
const subscriptionHelper = require('../utils/subscriptionHelper');

// POST /subscription-plans/create
// body: { role, name, monthlyCost, features, durationDays, autoRenew }
exports.createPlan = async (req, res) => {
  const { role, name, monthlyCost, features, durationDays, autoRenew } = req.body;
  if (!role || !name || monthlyCost == null) {
    return res.status(400).json({ message: 'role, name and monthlyCost are required' });
  }
  try {
    const plan = new SubscriptionPlan({ role, name, monthlyCost, features, durationDays, autoRenew });
    await plan.save();
    res.status(201).json({ message: 'Subscription plan created', plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /subscription-plans/list
// body: { role? }
exports.getPlans = async (req, res) => {
  const { role } = req.body;
  const filter = role ? { role } : {};
  try {
    const plans = await SubscriptionPlan.find(filter).sort({ monthlyCost: 1 }).lean();
    res.status(200).json({ message: 'Plans retrieved', plans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// GET /subscription-plans/get?id=<planId>
exports.getPlanById = async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ message: 'Query param id is required' });
  }
  try {
    const plan = await SubscriptionPlan.findOne({ planId: id }).lean();
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.status(200).json({ message: 'Plan retrieved', plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /subscription-plans/update
// body: { id: planId, ...fieldsToUpdate }
exports.updatePlan = async (req, res) => {
  // Pull planId out, everything else becomes the updates
  const { planId, ...updates } = req.body;

  if (!planId) {
    return res.status(400).json({ message: 'planId is required' });
  }

  try {
    const plan = await SubscriptionPlan.findOneAndUpdate(
      { planId },          // search criterion
      updates,             // fields to change
      { new: true, runValidators: true }
    ).lean();

    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    return res.status(200).json({ message: 'Plan updated', plan });
  } catch (err) {
    console.error('Error updating plan:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /subscription-plans/delete
// body: { id: planId }
exports.deletePlan = async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ message: 'Plan id is required' });
  }
  try {
    const plan = await SubscriptionPlan.findOneAndDelete({ planId: id });
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.status(200).json({ message: 'Plan deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.assignPlan = async (req, res) => {
  try {
    const { userType, userId, planId } = req.body;
    if (!userType || !userId || !planId) {
      return res.status(400).json({ message: 'userType, userId & planId are required' });
    }

    const Model = userType === 'Brand' ? Brand : Influencer;
    const plan = await SubscriptionPlan.findOne({ planId }).lean();
    if (!plan) {
      return res.status(404).json({ message: 'Plan not found' });
    }

    const now = new Date();
    const expire = subscriptionHelper.computeExpiry(plan);

    const featureSnapshot = plan.features.map(f => ({
      key:   f.key,
      limit: typeof f.value === 'number' ? f.value : 0,
      used:  0
    }));

    const update = {
      'subscription.planId':    plan.planId,
      'subscription.planName':  plan.name,
      'subscription.startedAt': now,
      'subscription.expiresAt': expire,
      'subscription.features':  featureSnapshot,
      subscriptionExpired:      false
    };

    const query = userType === 'Brand'
      ? { brandId: userId }
      : { influencerId: userId };

    const updated = await Model.findOneAndUpdate(query, update, {
      new: true,
      runValidators: true
    });
    if (!updated) {
      return res.status(404).json({ message: `${userType} with ID ${userId} not found` });
    }

    return res.json({
      message: `${userType} subscribed to "${plan.name}". It will expire at ${expire.toISOString()}"`,
      subscription: updated.subscription
    });
  } catch (error) {
    console.error('Error in assignPlan:', error);
    return res.status(500).json({ message: 'Internal server error while assigning plan.' });
  }
};

exports.renewPlan = async (req, res) => {
  const { userType, userId } = req.body;
  if (!userType || !userId) {
    return res.status(400).json({ message: 'userType & userId required' });
  }

  const Model = userType === 'Brand' ? Brand : Influencer;
  const user = await Model.findOne(
    userType === 'Brand' ? { brandId: userId } : { influencerId: userId }
  );
  if (!user) {
    return res.status(404).json({ message: `${userType} with ID ${userId} not found` });
  }

  const plan = await SubscriptionPlan.findOne({ planId: user.subscription.planId });
  if (!plan) {
    return res.status(404).json({ message: 'Plan not found' });
  }

  const now = new Date();
  // renew for another 5 minutes
  const newExpires = subscriptionHelper.computeExpiry(plan, user.subscription.expiresAt);
  user.subscription.startedAt = now;
  user.subscription.expiresAt = newExpires;
  user.subscription.features = plan.features.map(f => ({
    key:   f.key,
    limit: typeof f.value === 'number' ? f.value : 0,
    used:  0
  }));
  user.subscriptionExpired = false;

  await user.save();

  return res.json({
    message: `${userType} subscription renewed until ${newExpires.toISOString()}"`,
    subscription: user.subscription
  });
};

// POST /subscription-plans/my-plan
exports.getMyPlan = async (req, res) => {
  const { userType, userId } = req.body;
  if (!userType || !userId) {
    return res.status(400).json({ message: 'userType & userId required' });
  }

  const Model = userType === 'Brand' ? Brand : Influencer;

  const user = await Model.findOne(
    userType === 'Brand' ? { brandId: userId } : { influencerId: userId }
  ).lean();

  if (!user) {
    return res.status(404).json({ message: `${userType} not found` });
  }

  const sub = user.subscription || {};
  const planDoc = sub.planId
    ? await SubscriptionPlan.findOne({ planId: sub.planId }).lean()
    : null;

  return res.json({
    message: 'Current subscription fetched',
    plan: planDoc,                      // full plan metadata
    startedAt: sub.startedAt || null,
    expiresAt: sub.expiresAt || null,
    expired: !!user.subscriptionExpired
  });
};
