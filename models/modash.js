// models/modash.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const UUIDv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------------------------- Shared sub-schemas --------------------------- */
const weightItemSchema = new mongoose.Schema(
  { code: String, name: String, weight: Number },
  { _id: false }
);

const categoryLinkSchema = new mongoose.Schema(
  {
    categoryId: { type: Number, required: true },
    categoryName: { type: String, required: true, trim: true },
    subcategoryId: {
      type: String,
      required: true,
      match: [UUIDv4Regex, 'Invalid subcategoryId (must be UUID v4)']
    },
    subcategoryName: { type: String, required: true, trim: true }
  },
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

/* --------------------------- Modash Profile ------------------------------ */

const modashSchema = new mongoose.Schema(
  {
    // Link back to your main influencer (ObjectId reference)
    // This is for when you want to link a Modash profile to your Influencer collection
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      required: false,
      index: true,
    },

    // String version of influencer ID (for display/reference purposes)
    // This can be null/empty for profiles saved without explicit influencer link
    influencerId: {
      type: String,
      required: false,
      index: true
    },

    // Provider info
    provider: {
      type: String,
      enum: ['youtube', 'tiktok', 'instagram'],
      required: true,
      index: true
    },

    // CRITICAL: This is the Modash provider's userId (their internal ID)
    // This is the PRIMARY KEY along with provider
    userId: {
      type: String,
      required: true,  // Changed from optional to required
      index: true,
    },
    
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

    // Categories (for categorization)
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

    // Keep untouched provider payload
    providerRaw: mongoose.Schema.Types.Mixed
  },
  {
    timestamps: true
  }
);

/* ------------------------------ Indexes ---------------------------------- */

// PRIMARY INDEX: userId + provider (this is the main unique constraint)
// Every document MUST have userId and provider
modashSchema.index(
  { userId: 1, provider: 1 },
  {
    unique: true,
    name: 'userId_provider_unique'
  }
);

// Secondary index for looking up by influencer ObjectId reference
// This is non-unique because multiple platforms can link to same influencer
modashSchema.index(
  { influencer: 1, provider: 1 },
  {
    name: 'influencer_provider_lookup'
  }
);

// Index for searching by influencerId string (for display purposes)
modashSchema.index(
  { influencerId: 1 },
  {
    sparse: true,  // Only index documents that have this field
    name: 'influencerId_lookup'
  }
);

// Compound index for common queries
modashSchema.index(
  { provider: 1, username: 1 },
  {
    name: 'provider_username_lookup'
  }
);

/* ------------------------------ Pre-save Hook --------------------------- */

// Validate that userId is always present
modashSchema.pre('save', function(next) {
  if (!this.userId) {
    return next(new Error('userId is required for ModashProfile'));
  }
  if (!this.provider) {
    return next(new Error('provider is required for ModashProfile'));
  }
  next();
});

/* ------------------------------ Instance Methods ------------------------ */

// Helper to check if profile is linked to an influencer
modashSchema.methods.isLinkedToInfluencer = function() {
  return !!(this.influencer || this.influencerId);
};

// Get a display name for this profile
modashSchema.methods.getDisplayName = function() {
  return this.fullname || this.username || this.handle || 'Unknown';
};

/* ------------------------------ Static Methods -------------------------- */

// Find or create by userId and provider
modashSchema.statics.findByUserIdAndProvider = async function(userId, provider) {
  return this.findOne({ userId, provider });
};

// Find all profiles for a given influencer
modashSchema.statics.findByInfluencer = async function(influencerId) {
  return this.find({
    $or: [
      { influencer: influencerId },
      { influencerId: String(influencerId) }
    ]
  });
};

module.exports = mongoose.model('Modash', modashSchema);