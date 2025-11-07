// scripts/seedSubscriptionPlans.js
require('dotenv').config();
const mongoose = require('mongoose');
const SubscriptionPlan = require('../models/subscription'); // adjust path if needed

// ─────────────────────────────────────────────────────────────────────────────
//  Shared add-ons
// ─────────────────────────────────────────────────────────────────────────────
const DISCOVERY_PACK = {
  key: 'discovery_pack_50',
  name: 'Discovery Pack (+50 credits)',
  type: 'one_time',
  price: 99,
  currency: 'USD',
  payload: { credits: 50 }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Subscription plans (V1) – from “CollabGlam — V1 Subscription Report”
//  Notes:
//   • brand.free: cached-only search, preview-only profiles, 0 credits
//   • brand.growth: 3 credits/mo (≈3 profiles or ~20 fresh searches)
//   • brand.pro (Best Value): 8 credits/mo
//   • brand.premium: credits not specified in V1 doc → set to 0 for now; adjust in ops
//   • influencer quotas & media-kit capacities per V1
// ─────────────────────────────────────────────────────────────────────────────
const plans = [
  // ── BRAND PLANS ───────────────────────────────────────────────────────────
  {
    role: 'Brand',
    name: 'free',
    monthlyCost: 0,
    autoRenew: true,                   // renew forever (useful for testing)
    durationMins: 5,
    label: undefined,
    features: [
      { key: 'live_campaigns_limit', value: 1 },
      { key: 'invites_per_month', value: 10 },
      { key: 'monthly_credits', value: 0, note: 'No fresh pulls; cached-only' },
      { key: 'search_cached_only', value: 1 },
      { key: 'profile_preview_only', value: 1 },
      { key: 'view_full_profiles_uses_credits', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contracts_access', value: 0 },
      { key: 'milestones_access', value: 0 },
      { key: 'dispute_support', value: 0 }
    ],
    addons: [DISCOVERY_PACK]
  },
  {
    role: 'Brand',
    name: 'growth',
    monthlyCost: 99,
    label: undefined,
    features: [
      { key: 'live_campaigns_limit', value: 3 },
      { key: 'invites_per_month', value: 50 },
      { key: 'monthly_credits', value: 3, note: '~3 profiles or ~20 fresh searches' },
      { key: 'search_fresh_uses_credits', value: 1 },
      { key: 'view_full_profiles_uses_credits', value: 1 },
      { key: 'milestones_access', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contracts_access', value: 1 },
      { key: 'dispute_support', value: 1 }
    ],
    addons: [DISCOVERY_PACK]
  },
  {
    role: 'Brand',
    name: 'pro',
    monthlyCost: 199,
    label: 'Best Value',
    features: [
      { key: 'live_campaigns_limit', value: 10 },
      { key: 'invites_per_month', value: 200 },
      { key: 'monthly_credits', value: 8, note: '~8 profiles or ~53 fresh searches' },
      { key: 'search_fresh_uses_credits', value: 1 },
      { key: 'view_full_profiles_uses_credits', value: 1 },
      { key: 'milestones_access', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contracts_access', value: 1 },
      { key: 'dispute_support', value: 1 }
    ],
    addons: [DISCOVERY_PACK]
  },
  {
    role: 'Brand',
    name: 'premium',
    monthlyCost: 299,
    label: undefined,
    features: [
      { key: 'live_campaigns_limit', value: 25 },
      { key: 'invites_per_month', value: 1000 },
      // V1 doc doesn’t specify credits for Premium; defaulting to 0 so ops can adjust safely.
      { key: 'monthly_credits', value: 0, note: 'TBD per ops; not in V1 doc' },
      { key: 'search_fresh_uses_credits', value: 1 },
      { key: 'view_full_profiles_uses_credits', value: 1 },
      { key: 'milestones_access', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contracts_access', value: 1 },
      { key: 'dispute_support', value: 1 }
    ],
    addons: [DISCOVERY_PACK]
  },

  // ── INFLUENCER PLANS ───────────────────────────────────────────────────────
  {
    role: 'Influencer',
    name: 'free',
    monthlyCost: 0,
    autoRenew: true,                   // renew forever (useful for testing)
    durationMins: 5,
    features: [
      { key: 'connect_instagram', value: 1 },
      { key: 'connect_youtube', value: 1 },
      { key: 'connect_tiktok', value: 1 },
      { key: 'media_kit_builder', value: 1 },
      { key: 'apply_to_campaigns_quota', value: 10 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contract_esign_basic', value: 1 },     // standard template
      { key: 'contract_esign_download_pdf', value: 0 },
      { key: 'dispute_channel', value: 1 }
      // Media kit item cap not specified in V1 for Free
    ]
  },
  {
    role: 'Influencer',
    name: 'basic',
    monthlyCost: 10,
    features: [
      { key: 'apply_to_campaigns_quota', value: 50 },
      { key: 'media_kit_items_limit', value: 24 },
      { key: 'saved_searches', value: 1 },
      { key: 'connect_instagram', value: 1 },
      { key: 'connect_youtube', value: 1 },
      { key: 'connect_tiktok', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contract_esign_basic', value: 1 },
      { key: 'contract_esign_download_pdf', value: 0 },
      { key: 'dispute_channel', value: 1 }
    ]
  },
  {
    role: 'Influencer',
    name: 'creator',
    monthlyCost: 29,
    features: [
      { key: 'apply_to_campaigns_quota', value: 200 },
      { key: 'media_kit_items_limit', value: 60 },
      { key: 'saved_searches', value: 1 },
      { key: 'connect_instagram', value: 1 },
      { key: 'connect_youtube', value: 1 },
      { key: 'connect_tiktok', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contract_esign_basic', value: 1 },
      { key: 'contract_esign_download_pdf', value: 1 }, // can download signed PDF
      { key: 'dispute_channel', value: 1 },
      { key: 'media_kit_sections', value: ['bio', 'links', 'past_collabs', 'basic_rates'] }
    ]
  },
  {
    role: 'Influencer',
    name: 'elite',
    monthlyCost: 49,
    features: [
      { key: 'apply_to_campaigns_quota', value: 0 },  // 0 ⇒ unlimited
      { key: 'media_kit_items_limit', value: 120 },
      { key: 'saved_searches', value: 1 },
      { key: 'connect_instagram', value: 1 },
      { key: 'connect_youtube', value: 1 },
      { key: 'connect_tiktok', value: 1 },
      { key: 'in_app_messaging', value: 1 },
      { key: 'contract_esign_basic', value: 1 },
      { key: 'contract_esign_download_pdf', value: 1 },
      { key: 'dispute_channel', value: 1 },
      { key: 'media_kit_sections', value: ['bio', 'links', 'past_collabs', 'basic_rates'] }
    ]
  }
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
