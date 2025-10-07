// scripts/seedSubscriptionPlans.js
require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/subscription'); // adjust path if needed

// ─────────────────────────────────────────────────────────────────────────────
//  Subscription plans to seed
// ─────────────────────────────────────────────────────────────────────────────
const plans = [
  // ── BRAND PLANS ───────────────────────────────────────────────────────────
  {
    role: 'Brand',
    name: 'free',
    monthlyCost: 0,
    autoRenew: true,             // ⬅️ renew forever
    durationMins: 5,
    features: [
      { key: 'influencer_search_quota', value: 10 }, // per month
      { key: 'live_campaigns_limit', value: 1 },
      { key: 'email_outreach_credits', value: 0 },
      { key: 'dedicated_manager_support', value: 0 }  // 0 → none, 1 → included
    ]
  },
  {
    role: 'Brand',
    name: 'growth',
    monthlyCost: 99,
    features: [
      { key: 'influencer_search_quota', value: 250 },
      { key: 'live_campaigns_limit', value: 10 },
      { key: 'email_outreach_credits', value: 250 },
      { key: 'dedicated_manager_support', value: 0 }
    ]
  },
  {
    role: 'Brand',
    name: 'pro',
    monthlyCost: 199,
    features: [
      { key: 'influencer_search_quota', value: 500 },
      { key: 'live_campaigns_limit', value: 0 }, // 0 → unlimited
      { key: 'email_outreach_credits', value: 500 },
      { key: 'dedicated_manager_support', value: 1 }
    ]
  },
  {
    role: 'Brand',
    name: 'premium',
    monthlyCost: 299,
    features: [
      { key: 'influencer_search_quota', value: 5000 },
      { key: 'live_campaigns_limit', value: 0 },
      { key: 'email_outreach_credits', value: 5000 },
      { key: 'dedicated_manager_support', value: 1 }
    ]
  },

  // ── INFLUENCER PLANS ───────────────────────────────────────────────────────
  {
    role: 'Influencer',
    name: 'basic',
    monthlyCost: 0,
    autoRenew: true,             // ⬅️ renew forever
    durationMins: 5,
    features: [
      { key: 'apply_to_campaigns_quota', value: 3 },
      { key: 'email_outreach_credits', value: 0 },
      { key: 'pitch_templates_access', value: 0 }, // 0 → no
      { key: 'dedicated_support_access', value: 0 }
    ]
  },
  {
    role: 'Influencer',
    name: 'starter',
    monthlyCost: 19,
    features: [
      { key: 'apply_to_campaigns_quota', value: 10 },
      { key: 'email_outreach_credits', value: 250 },
      { key: 'pitch_templates_access', value: 1 },
      { key: 'dedicated_support_access', value: 1 }
    ]
  },
  {
    role: 'Influencer',
    name: 'creator',
    monthlyCost: 29,
    features: [
      { key: 'apply_to_campaigns_quota', value: 50 },
      { key: 'email_outreach_credits', value: 500 },
      { key: 'pitch_templates_access', value: 1 },
      { key: 'dedicated_support_access', value: 1 }
    ]
  },
  {
    role: 'Influencer',
    name: 'elite',
    monthlyCost: 49,
    features: [
      { key: 'apply_to_campaigns_quota', value: 0 }, // 0 → unlimited
      { key: 'email_outreach_credits', value: 5000 },
      { key: 'pitch_templates_access', value: 1 },
      { key: 'dedicated_support_access', value: 1 }
    ]
  },
];

async function seed() {
  try {
    // 1️⃣ Connect
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');

    // 2️⃣ Clear existing plans
    await SubscriptionPlan.deleteMany({});
    console.log('🗑️  Cleared existing subscription plans');

    // 3️⃣ Insert new ones
    const inserted = await SubscriptionPlan.insertMany(plans);
    console.log(`✅ Inserted ${inserted.length} subscription plans`);

  } catch (err) {
    console.error('❌ Error seeding plans:', err);
    process.exit(1);
  } finally {
    // 4️⃣ Cleanup
    await mongoose.disconnect();
    console.log('🔌 MongoDB disconnected');
    process.exit(0);
  }
}

seed();
