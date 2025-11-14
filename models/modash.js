// models/modash.js
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

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

/* --------------------------- Modash Profile ------------------------------ */

const modashSchema = new mongoose.Schema(
  {
    // Link back to your main influencer
    influencer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Influencer',
      required: false,
      index: true,
    },

    // For safety, keep a copy of their influencerId string too (optional but handy)
    influencerId: {
      type: String,
      default: () => uuidv4(),
      index: true
    },

    // Provider info
    provider: {
      type: String,
      enum: ['youtube', 'tiktok', 'instagram'],
      required: true,
      index: true
    },

    // Identity
    userId: {
      type: String,
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

    // NOTE: categories were only used under socialProfiles in Influencer;
    // If you still need them, you can copy the categoryLinkSchema from influencer.
    categories: { type: [mongoose.Schema.Types.Mixed], default: [] },

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
  {
    timestamps: true
  }
);

/* ------------------------------ Indexes ---------------------------------- */
modashSchema.index(
  { influencer: 1, provider: 1 },
  { unique: true, sparse: true }
);

// If not linked: one doc per userId+provider
modashSchema.index(
  { userId: 1, provider: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $exists: true, $ne: null } },
  }
);


module.exports = mongoose.model('Modash', modashSchema);
