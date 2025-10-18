// models/influencer.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/* --------------------------------- Utils --------------------------------- */
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
const phoneRegex = /^[0-9]{10}$/;
const UUIDv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------------------------- Shared sub-schemas --------------------------- */
const weightItemSchema = new mongoose.Schema(
  { code: String, name: String, weight: Number },
  { _id: false }
);

const userLiteSchema = new mongoose.Schema(
  {
    userId: String,
    fullname: String,
    username: String,
    url: String,
    picture: String,
    followers: Number,
    engagements: Number
  },
  { _id: false }
);

const sponsorSchema = new mongoose.Schema(
  { domain: String, logo_url: String, name: String },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    id: String,
    text: String,
    url: String,
    created: String,
    likes: Number,
    comments: Number,
    views: Number,
    video: String,
    image: String,
    thumbnail: String,
    type: String,
    title: String,
    mentions: [String],
    hashtags: [String],
    sponsors: [sponsorSchema]
  },
  { _id: false }
);

const audienceSchema = new mongoose.Schema(
  {
    notable: Number,
    genders: [weightItemSchema],
    geoCountries: [weightItemSchema],
    ages: [weightItemSchema],
    gendersPerAge: [{ code: String, male: Number, female: Number }],
    languages: [weightItemSchema],
    notableUsers: [userLiteSchema],
    audienceLookalikes: [userLiteSchema],
    geoCities: [{ name: String, weight: Number }],
    geoStates: [{ name: String, weight: Number }],
    credibility: Number,
    interests: [{ name: String, weight: Number }],
    brandAffinity: [{ name: String, weight: Number }],
    audienceReachability: [weightItemSchema],
    audienceTypes: [weightItemSchema],
    ethnicities: [weightItemSchema]
  },
  { _id: false }
);

/* ----------------------- Category link sub-schema ------------------------ */
/* Kept full for socialProfiles.categories */
const categoryLinkSchema = new mongoose.Schema(
  {
    categoryId: { type: Number, required: true, index: true },
    categoryName: { type: String, required: true, trim: true },
    subcategoryId: {
      type: String,
      required: true,
      index: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
  { _id: false }
);

/* -------- NEW: Minimal sub-schema for onboarding.subcategories ---------- */
const onboardingSubcategorySchema = new mongoose.Schema(
  {
    subcategoryId: {
      type: String,
      required: true,
      index: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
  { _id: false }
);

/* ----------------------- Social profile sub-schema ----------------------- */
const socialProfileSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['youtube', 'tiktok', 'instagram'], required: true, index: true },

    // Identity
    userId: String,
    username: String,
    fullname: String,
    handle: String,
    url: String,
    picture: String,

    // Metrics
    followers: Number,
    engagements: Number,
    engagementRate: Number,
    averageViews: Number,

    // State/meta
    isPrivate: Boolean,
    isVerified: Boolean,
    accountType: String,
    secUid: String,

    // Localization
    city: String,
    state: String,
    country: String,
    ageGroup: String,
    gender: String,
    language: { code: String, name: String },

    // Content stats & posts
    statsByContentType: mongoose.Schema.Types.Mixed,
    stats: mongoose.Schema.Types.Mixed,
    recentPosts: [postSchema],
    popularPosts: [postSchema],

    // Counts (normalized)
    postsCount: Number,
    avgLikes: Number,
    avgComments: Number,
    avgViews: Number,
    avgReelsPlays: Number,
    totalLikes: Number,
    totalViews: Number,

    // Bio/tags/brand
    bio: String,

    // Full category link objects (unchanged)
    categories: { type: [categoryLinkSchema], default: [] },

    hashtags: [{ tag: String, weight: Number }],
    mentions: [{ tag: String, weight: Number }],
    brandAffinity: [{ id: Number, name: String }],

    // Audience
    audience: audienceSchema,
    audienceCommenters: audienceSchema,
    lookalikes: [userLiteSchema],

    // Paid/sponsored
    sponsoredPosts: [postSchema],
    paidPostPerformance: Number,
    paidPostPerformanceViews: Number,
    sponsoredPostsMedianViews: Number,
    sponsoredPostsMedianLikes: Number,
    nonSponsoredPostsMedianViews: Number,
    nonSponsoredPostsMedianLikes: Number,

    // Misc extras
    audienceExtra: mongoose.Schema.Types.Mixed,

    // Keep untouched provider payload too
    providerRaw: mongoose.Schema.Types.Mixed
  },
  { _id: false, timestamps: true }
);

/* -------------------------- Language sub-schema -------------------------- */
const languageRefSchema = new mongoose.Schema(
  {
    languageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Language', required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true }
  },
  { _id: false }
);

/* -------------------------- Onboarding sub-schema ------------------------ */
const onboardingSchema = new mongoose.Schema(
  {
    // STEP 4.1
    formats: { type: [String], default: [] },
    budgets: { type: [{ format: String, range: String }], default: [] },
    projectLength: { type: String },
    capacity: { type: String },

    // STEP 4.2
    categoryId: { type: Number, index: true },
    categoryName: { type: String, trim: true },

    // ✅ Minimal subcategory objects (no categoryId/categoryName)
    subcategories: { type: [onboardingSubcategorySchema], default: [] },

    collabTypes: { type: [String], default: [] },
    allowlisting: { type: Boolean, default: false },
    cadences: { type: [String], default: [] },

    // STEP 4.3
    selectedPrompts: { type: [{ group: String, prompt: String }], default: [] },
    promptAnswers: {
      type: [{ group: String, prompt: String, answer: String }],
      default: []
    }
  },
  { _id: false }
);

/* -------------------------- Payment sub-schema --------------------------- */
const paymentSchema = new mongoose.Schema(
  {
    paymentId: { type: String, default: () => uuidv4() },
    // 0: PayPal, 1: Bank
    type: { type: Number, enum: [0, 1], required: true },
    bank: {
      accountHolder: { type: String, required: function () { return this.type === 1; } },
      accountNumber: { type: String, required: function () { return this.type === 1; } },
      ifsc: { type: String },
      swift: { type: String },
      bankName: { type: String, required: function () { return this.type === 1; } },
      branch: { type: String },
      countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.type === 1; } },
      countryName: { type: String, required: function () { return this.type === 1; } }
    },
    paypal: {
      email: { type: String, match: [emailRegex, 'Invalid PayPal email'], required: function () { return this.type === 0; } },
      username: { type: String }
    },
    isDefault: { type: Boolean, default: false }
  },
  { _id: false, timestamps: true }
);

/* --------------------------- Influencer schema --------------------------- */
const influencerSchema = new mongoose.Schema(
  {
    influencerId: { type: String, required: true, unique: true, default: uuidv4 },
    name: { type: String, required: function () { return this.otpVerified; } },
    email: { type: String, required: true, unique: true, match: [emailRegex, 'Invalid email'] },
    password: { type: String, minlength: 8, required: function () { return this.otpVerified; } },
    phone: { type: String, match: [phoneRegex, 'Invalid phone'], required: function () { return this.otpVerified; } },

    primaryPlatform: { type: String, enum: ['youtube', 'tiktok', 'instagram', 'other', null], default: null },
    socialProfiles: { type: [socialProfileSchema], default: [] },

    countryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.otpVerified; } },
    country: { type: String, required: function () { return this.otpVerified; } },
    callingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Country', required: function () { return this.otpVerified; } },
    callingcode: { type: String, required: function () { return this.otpVerified; } },

    city: { type: String, trim: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ['Female', 'Male', 'Non-binary', 'Prefer not to say', ''], default: '' },

    languages: { type: [languageRefSchema], default: [] },

    onboarding: { type: onboardingSchema, default: {} },

    createdAt: { type: Date, default: Date.now },

    otpCode: { type: String },
    otpExpiresAt: { type: Date },
    otpVerified: { type: Boolean, default: false },

    passwordResetCode: { type: String },
    passwordResetExpiresAt: { type: Date },
    passwordResetVerified: { type: Boolean, default: false },

    paymentMethods: { type: [paymentSchema], default: [] },

    subscription: {
      planName: { type: String, required: true, default: 'free' },
      planId: { type: String, required: true, default: 'a58683f0-8d6e-41b0-addd-a718c2622142' },
      startedAt: { type: Date, default: Date.now },
      expiresAt: { type: Date },
      features: {
        type: [
          new mongoose.Schema(
            { key: { type: String, required: true }, limit: { type: Number, required: true }, used: { type: Number, required: true } },
            { _id: false }
          )
        ],
        default: []
      }
    },

    subscriptionExpired: { type: Boolean, default: false },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null }
  },
  { timestamps: true, minimize: true }
);

/* ---------------------- Helpful Indexes for Filters ---------------------- */
influencerSchema.index({ email: 1 }, { unique: true });
influencerSchema.index({ 'socialProfiles.provider': 1 });
influencerSchema.index({ 'socialProfiles.categories.subcategoryId': 1 });
influencerSchema.index({ 'languages.languageId': 1 });
influencerSchema.index({ 'onboarding.categoryId': 1 });
influencerSchema.index({ city: 1 });

// Lookup by selected subcategories in onboarding
influencerSchema.index({ 'onboarding.subcategories.subcategoryId': 1 });

/* -------------------- Only one default payment method -------------------- */
influencerSchema.pre('validate', function (next) {
  if (Array.isArray(this.paymentMethods)) {
    this.paymentMethods.forEach(pm => { if (!pm.paymentId) pm.paymentId = uuidv4(); });
    const defaults = this.paymentMethods.filter(pm => pm.isDefault);
    if (defaults.length > 1) return next(new Error('Only one payment method can be marked as default.'));
  }
  next();
});

influencerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (e) { next(e); }
});

influencerSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

influencerSchema.index(
  { 'paymentMethods.paymentId': 1 },
  { unique: true, partialFilterExpression: { 'paymentMethods.paymentId': { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Influencer', influencerSchema);
