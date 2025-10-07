const cron = require('node-cron');
const SubscriptionPlan = require('../models/subscription');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const subscriptionHelper = require('../utils/subscriptionHelper');
// Adjust path as needed
/**
 * Core logic to refresh subscriptions:
 * - Auto-renew free plans every 5 minutes
 * - Expire paid plans
 */
async function refreshSubscriptions() {
  const now = new Date();
  console.log(`🔄 subscriptionRefresh running at ${now.toISOString()}`);

  // 1) Fetch active autoRenew plans
  const autoPlans = await SubscriptionPlan.find({ autoRenew: true, status: 'active' })
    .select('planId')
    .lean();
  const autoIds = autoPlans.map(p => p.planId);

  // 2) Process Brands & Influencers
  for (const { Model, idField, role } of [
    { Model: Brand, idField: 'brandId', role: 'Brand' },
    { Model: Influencer, idField: 'influencerId', role: 'Influencer' }
  ]) {
    // A) Auto-renew free subscriptions after 5 minutes
    const renewUsers = await Model.find({
      'subscription.planId': { $in: autoIds },
      'subscription.expiresAt': { $lte: now }
    });
    for (const user of renewUsers) {
      const plan = await SubscriptionPlan.findOne({ planId: user.subscription.planId }).lean();
      if (!plan) continue; 
      const expire = subscriptionHelper.computeExpiry(plan);
      user.subscription.startedAt = now;
      user.subscription.expiresAt = expire;
      user.subscriptionExpired = false;
      await user.save();
      console.log(`🔁 Auto-renewed ${Model.modelName} ${user[idField]} until ${expire.toISOString()}`);
    }

    const expireUsers = await Model.find({
      'subscription.planId': { $nin: autoIds },
      'subscription.expiresAt': { $lte: now }
    });

    for (const user of expireUsers) {
      // Downgrade to the free/basic tier
      const freePlan = await subscriptionHelper.getFreePlan(role);

      const newExpire = subscriptionHelper.computeExpiry(freePlan);

      user.subscription.planId = freePlan.planId;
      user.subscription.planName = freePlan.name;
      user.subscription.startedAt = now;
      user.subscription.expiresAt = newExpire;
      user.subscription.features = freePlan.features.map(f => ({
        key: f.key, limit: typeof f.value === 'number' ? f.value : 0, used: 0
      }));
      user.subscriptionExpired = false;       // 👉 they still have a plan

      await user.save();
      console.log(`⬇️  Downgraded ${role} ${user[idField]} → free until ${newExpire.toISOString()}`);
    }
  }
}

// Schedule every minute to handle expiries precisely
cron.schedule('* * * * *', () => {
  refreshSubscriptions().catch(err => console.error('Subscription refresh error:', err));
}, { timezone: 'Asia/Kolkata' });

module.exports = { refreshSubscriptions };
