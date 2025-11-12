// scripts/seedSubscriptionPlans.js
require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/subscription');

// Optional shared add-on (kept for future use; not attached by default)
const DISCOVERY_PACK = {
  key: 'discovery_pack_50',
  name: 'Discovery Pack (+50 credits)',
  type: 'one_time',
  price: 99,
  currency: 'USD',
  payload: { credits: 50 }
};

const BRAND_CURRENCY = 'USD';
const INFLUENCER_CURRENCY = 'USD';

// ─────────────────────────────────────────────────────────────────────────────
// BRAND PLANS (INR)
// Keep points exactly as provided. Enterprise last, custom pricing.
// ─────────────────────────────────────────────────────────────────────────────
const brandPlans = [
  {
    role: 'Brand',
    name: 'free',
    displayName: 'FREE',
    monthlyCost: 0,
    currency: BRAND_CURRENCY,
    overview: undefined,
    sortOrder: 1,
    autoRenew: true,
    durationMins: 5, // handy for local testing; remove in prod if unwanted
    features: [
      { key: 'searches_per_month', value: 20 },
      { key: 'profile_views_per_month', value: 3 },
      { key: 'invites_per_month', value: 10 },
      { key: 'active_campaigns_limit', value: 5 },
      { key: 'message_templates_basic_limit', value: 1 },
      { key: 'support_channels', value: ['chat'] }
    ],
    addons: []
  },
  {
    role: 'Brand',
    name: 'growth',
    displayName: 'GROWTH',
    monthlyCost: 99,
    currency: BRAND_CURRENCY,
    sortOrder: 2,
    features: [
      { key: 'searches_per_month', value: 150 },
      { key: 'profile_views_per_month', value: 50 },
      { key: 'invites_per_month', value: 100 },
      { key: 'active_campaigns_limit', value: 10 },
      { key: 'custom_messaging', value: 1 },
      { key: 'advanced_filters', value: 1, note: 'MVP limited' },
      { key: 'support_channels', value: ['chat'] },
      { key: 'dispute_assistance', value: 1 }
    ],
    addons: []
  },
  {
    role: 'Brand',
    name: 'pro',
    displayName: 'PRO',
    monthlyCost: 199,
    currency: BRAND_CURRENCY,
    sortOrder: 3,
    features: [
      { key: 'searches_per_month', value: 500 },
      { key: 'profile_views_per_month', value: 150 },
      { key: 'invites_per_month', value: 200 },
      { key: 'active_campaigns_limit', value: 10 }, // "10 campaigns"
      { key: 'custom_messaging', value: 1 },
      { key: 'advanced_filters', value: 1 },
      { key: 'dedicated_account_manager', value: 1 },
      { key: 'support_channels', value: ['chat'] },
      { key: 'dispute_assistance', value: 1 }
    ],
    addons: []
  },
  {
    role: 'Brand',
    name: 'premium',
    displayName: 'PREMIUM',
    monthlyCost: 299,
    currency: BRAND_CURRENCY,
    sortOrder: 4,
    features: [
      { key: 'searches_per_month', value: 1000 },
      { key: 'profile_views_per_month', value: 300 },
      { key: 'invites_per_month', value: 1000 },
      { key: 'active_campaigns_limit', value: 30 },
      { key: 'advanced_filters', value: 1, note: 'MVP limited' },
      { key: 'dedicated_manager', value: 1 },
      { key: 'support_channels', value: ['chat'] },
      { key: 'dispute_assistance', value: 1 }
    ],
    addons: []
  },
  {
    role: 'Brand',
    name: 'enterprise',
    displayName: 'ENTERPRISE',
    monthlyCost: 0,                 // custom pricing
    currency: BRAND_CURRENCY,
    isCustomPricing: true,
    sortOrder: 999,                 // keep LAST
    features: [
      { key: 'public_quotas_visible', value: 1, note: 'What brands see (Public Quotas)' },
      { key: 'searches_per_month', value: 'custom' },
      { key: 'profile_views_per_month', value: 'unlimited', note: 'within allocation' },
      { key: 'invites_per_month', value: 'unlimited' },
      { key: 'active_campaigns_limit', value: 'unlimited' },
      { key: 'custom_messaging', value: 1 },
      { key: 'dedicated_manager', value: 1 },
      { key: 'setup_assistance', value: 1 },
      { key: 'priority_verification_queue', value: 1 },
      { key: 'strategy_calls', value: 1 },
      { key: 'sla_support', value: 1 },
      { key: 'flexible_billing', value: 1 },
      { key: 'support_channels', value: ['chat'] },
      { key: 'contact_admin_flow', value: 1, note: 'Route to Contact Us → admin configures custom plan' }
    ],
    addons: []
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// INFLUENCER PLANS (USD)
// Keep points exactly as provided, with overviews preserved.
// ─────────────────────────────────────────────────────────────────────────────
const influencerPlans = [
  {
    role: 'Influencer',
    name: 'free',
    displayName: 'FREE',
    monthlyCost: 0,
    currency: INFLUENCER_CURRENCY,
    overview:
      'Entry plan for new creators starting their influencer journey and exploring brand collaborations.',
    sortOrder: 1,
    autoRenew: true,
    durationMins: 5,
    features: [
      { key: 'apply_to_campaigns_quota', value: 10, note: 'per month' },
      { key: 'active_collaborations_limit', value: 1 },
      { key: 'media_kit', value: 'included_standard' },
      { key: 'support_channels', value: ['chat'] },
      { key: 'team_manager_tools', value: 'not_available' },
      { key: 'dashboard_access', value: 'basic' }
    ],
    addons: []
  },
  {
    role: 'Influencer',
    name: 'creator_plus',
    displayName: 'CREATOR PLUS',
    monthlyCost: 19,
    currency: INFLUENCER_CURRENCY,
    overview:
      'Best for creators growing steadily and applying to more brand opportunities.',
    sortOrder: 2,
    features: [
      { key: 'apply_to_campaigns_quota', value: 50, note: 'per month' },
      { key: 'active_collaborations_limit', value: 5 },
      { key: 'media_kit', value: 'included' },
      { key: 'support_channels', value: ['chat'] },
      { key: 'team_manager_tools', value: 'not_available' },
      { key: 'dashboard_access', value: 'standard' }
    ],
    addons: []
  },
  {
    role: 'Influencer',
    name: 'creator_pro',
    displayName: 'CREATOR PRO',
    monthlyCost: 29,
    currency: INFLUENCER_CURRENCY,
    overview:
      'Built for creators scaling their profile with brands and managing higher collaboration volume.',
    sortOrder: 3,
    features: [
      { key: 'apply_to_campaigns_quota', value: 100, note: 'per month' },
      { key: 'active_collaborations_limit', value: 15 },
      { key: 'media_kit', value: 'included' },
      { key: 'support_channels', value: ['email', 'chat'] },
      { key: 'team_manager_tools', value: 'not_available' },
      { key: 'dashboard_access', value: 'advanced' }
    ],
    addons: []
  },
  {
    role: 'Influencer',
    name: 'agency',
    displayName: 'AGENCY',
    monthlyCost: 99,
    currency: INFLUENCER_CURRENCY,
    overview:
      'Ideal for talent managers and influencer agencies handling multiple creators.',
    sortOrder: 4,
    features: [
      { key: 'apply_to_campaigns_quota', value: 0, note: '0 ⇒ Unlimited' },
      { key: 'active_collaborations_limit', value: 'team_managed' },
      { key: 'media_kit', value: 'shared_team_kit' },
      { key: 'support_channels', value: ['email', 'phone'] },
      { key: 'team_manager_tools_managed_creators', value: { min: 5, max: 200 } },
      { key: 'dashboard_access', value: 'team_workspace' }
    ],
    addons: []
  }
];

const plans = [...brandPlans, ...influencerPlans];

async function seed() {
  try {
    const { MONGODB_URI } = process.env;
    if (!MONGODB_URI) throw new Error('Set MONGODB_URI in .env');

    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB connected');

    await SubscriptionPlan.deleteMany({});
    console.log('🗑️  Cleared existing subscription plans');

    const inserted = await SubscriptionPlan.insertMany(plans);
    console.log(`✅ Inserted ${inserted.length} subscription plans`);

  } catch (err) {
    console.error('❌ Error seeding plans:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 MongoDB disconnected');
    process.exit(0);
  }
}

seed();
