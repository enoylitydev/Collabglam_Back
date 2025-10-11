// controllers/influencerController.js

require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const Category = require('../models/categories');
const AudienceRange = require('../models/audience');
const Country = require('../models/country');
const subscriptionHelper = require('../utils/subscriptionHelper');
const Platform = require('../models/platform');
const Audience = require('../models/audienceRange');
const Campaign = require('../models/campaign');
const { escapeRegExp,edgeNgrams, charNgrams } = require('../utils/searchTokens');
const VerifyEmail = require('../models/verifyEmail');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

const uploadDir = path.join(__dirname, '../uploads/profile_images');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Only JPEG, JPG, and PNG files are allowed'));
  },
  limits: { fileSize: 2 * 1024 * 1024 }
});

exports.uploadProfileImage = upload.single('profileImage');

// Request OTP (upsert, now defensive)
exports.requestOtpInfluencer = async (req, res) => {
  const { email, role='Influencer' } = req.body;

  if (!email || !role) {
    return res.status(400).json({ message: 'Both email and role are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = String(role).trim();
  if (!['Influencer', 'Brand'].includes(normalizedRole)) {
    return res.status(400).json({ message: 'role must be "Influencer" or "Brand"' });
  }

  try {
    // If already registered for that role, block OTP
    const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
    const alreadyRegistered =
      normalizedRole === 'Influencer'
        ? await Influencer.findOne({ email: emailRegexCI }, '_id')
        : await Brand.findOne({ email: emailRegexCI }, '_id');

    if (alreadyRegistered) {
      return res.status(409).json({ message: 'User already present' });
    }

    // Issue OTP via VerifyEmail record (do NOT upsert Influencer/Brand)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: normalizedEmail, role: normalizedRole },
      {
        $set: {
          otpCode: code,
          otpExpiresAt: expiresAt,
          verified: false
        },
        $inc: { attempts: 1 }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    try {
      await transporter.sendMail({
        from: `"No-Reply" <${SMTP_USER}>`,
        to: normalizedEmail,
        subject: 'Verify your email',
        text: `Your verification code is ${code}. It expires in 10 minutes.`
      });
    } catch (mailErr) {
      console.warn('Failed to send OTP email:', mailErr.message);
      // continue: we still return success to avoid leaking existence
    }

    return res.json({ message: 'OTP sent to email' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'Conflict while creating/updating verification record.' });
    }
    console.error('Error in requestOtpInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.verifyOtpInfluencer = async (req, res) => {
  const { email, role='Influencer', otp } = req.body;

  if (!email || !role || otp == null) {
    return res.status(400).json({ message: 'email, role and otp are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedRole = String(role).trim();

  if (!['Influencer', 'Brand'].includes(normalizedRole)) {
    return res.status(400).json({ message: 'role must be "Influencer" or "Brand"' });
  }

  try {
    const doc = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: normalizedRole,
      otpCode: otp.toString().trim(),
      otpExpiresAt: { $gt: new Date() }
    });

    if (!doc) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    doc.verified = true;
    doc.verifiedAt = new Date();
    doc.otpCode = undefined;
    doc.otpExpiresAt = undefined;
    await doc.save();

    return res.json({ message: 'Email verified — you may now complete registration' });
  } catch (err) {
    console.error('Error in verifyOtpInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};



const safeParse = (v) => {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  if (typeof v === 'object') return v;
  return null;
};

// Build an in-memory index for Category → Subcategory lookups
async function buildCategoryIndex() {
  const rows = await Category.find({}, 'id name subcategories').lean();
  const bySubId = new Map();           // subcategoryId(UUID) -> { categoryId, categoryName, subcategoryId, subcategoryName }
  const bySubName = new Map();         // subcategoryName (lower) -> above
  const byCatId = new Map();           // categoryId (Number) -> { id, name, subcategories[] }

  for (const r of rows) {
    byCatId.set(r.id, r);
    for (const s of (r.subcategories || [])) {
      const node = {
        categoryId: r.id,
        categoryName: r.name,
        subcategoryId: s.subcategoryId,
        subcategoryName: s.name
      };
      bySubId.set(String(s.subcategoryId), node);
      bySubName.set(String(s.name).toLowerCase(), node);
    }
  }
  return { bySubId, bySubName, byCatId };
}

// Normalize an array of "raw" category inputs from provider payloads
// Accepts formats:
//   - [{ subcategoryId, subcategoryName?, categoryId? }]  (preferred)
//   - [{ categoryId, subcategoryName }] (maps by name within category)
//   - ["subcategory name", ...]                           (legacy free-text)
//   - [{ id, name }]                                      (legacy "interests" — tries to resolve by name; `id` treated as categoryId if possible)
function normalizeCategories(raw, idx) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];

  for (const item of list) {
    if (!item) continue;

    // String → assume subcategory name
    if (typeof item === 'string') {
      const hit = idx.bySubName.get(item.toLowerCase());
      if (hit) out.push(hit);
      continue;
    }

    // Has subcategoryId → direct resolve
    if (item.subcategoryId && UUIDv4Regex.test(String(item.subcategoryId))) {
      const hit = idx.bySubId.get(String(item.subcategoryId));
      if (hit) out.push(hit);
      continue;
    }

    // Has (categoryId + subcategoryName)
    if (typeof item.categoryId === 'number' && item.subcategoryName) {
      const cat = idx.byCatId.get(item.categoryId);
      if (cat && Array.isArray(cat.subcategories)) {
        const sub = cat.subcategories.find(
          s => String(s.name).toLowerCase() === String(item.subcategoryName).toLowerCase()
        );
        if (sub) {
          out.push({
            categoryId: cat.id,
            categoryName: cat.name,
            subcategoryId: sub.subcategoryId,
            subcategoryName: sub.name
          });
        }
      }
      continue;
    }

    // Legacy { id, name } (interests) → try as subcategory name
    if (typeof item.id === 'number' || typeof item.name === 'string') {
      const byName = item.name ? idx.bySubName.get(String(item.name).toLowerCase()) : null;
      if (byName) {
        out.push(byName);
        continue;
      }
      // If only category id provided with no subcategory, we skip (cannot resolve)
      continue;
    }
  }

  // Deduplicate by subcategoryId
  const seen = new Set();
  const deduped = [];
  for (const node of out) {
    if (!seen.has(node.subcategoryId)) {
      seen.add(node.subcategoryId);
      deduped.push(node);
    }
  }
  return deduped;
}

// Pull possible taxonomy arrays from provider raw payloads
function extractRawCategoriesFromProviderRaw(providerRaw) {
  const p = safeParse(providerRaw) || providerRaw || {};
  const root = p.profile || p;
  const prof = root.profile || {};
  // Prefer new "categories", fall back to legacy "interests"
  return prof.categories || root.categories || prof.interests || root.interests || [];
}

/* ================================ MAP PAYLOAD ================================ */
// unchanged signature but we STOP writing legacy `interests` and defer category mapping
const mapPayload = (provider, input) => {
  const p = safeParse(input);
  if (!p) return null;

  const root = p.profile || p;
  const prof = root.profile || {};

  return {
    provider,
    userId: root.userId || prof.userId,
    username: prof.username,
    fullname: prof.fullname,
    handle: prof.handle,
    url: prof.url,
    picture: prof.picture,
    followers: prof.followers,
    engagements: prof.engagements,
    engagementRate: prof.engagementRate,
    averageViews: prof.averageViews,

    isPrivate: root.isPrivate,
    isVerified: root.isVerified,
    accountType: root.accountType,
    secUid: root.secUid,

    city: root.city,
    state: root.state,
    country: root.country,
    ageGroup: root.ageGroup,
    gender: root.gender,
    language: root.language,

    statsByContentType: root.statsByContentType,
    stats: root.stats,
    recentPosts: root.recentPosts,
    popularPosts: root.popularPosts,

    postsCount: root.postsCount || root.postsCounts,
    avgLikes: root.avgLikes,
    avgComments: root.avgComments,
    avgViews: root.avgViews,
    avgReelsPlays: root.avgReelsPlays,
    totalLikes: root.totalLikes,
    totalViews: root.totalViews,

    bio: root.description || root.bio,

    // NOTE: categories will be populated later from providerRaw via normalization
    categories: [],

    hashtags: root.hashtags,
    mentions: root.mentions,
    brandAffinity: root.brandAffinity,

    audience: root.audience,
    audienceCommenters: root.audienceCommenters,
    lookalikes: root.lookalikes || root.audienceLookalikes,

    sponsoredPosts: root.sponsoredPosts,
    paidPostPerformance: root.paidPostPerformance,
    paidPostPerformanceViews: root.paidPostPerformanceViews,
    sponsoredPostsMedianViews: root.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: root.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: root.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: root.nonSponsoredPostsMedianLikes,

    audienceExtra: root.audienceExtra,
    providerRaw: p
  };
};

/* ============================== CONTROLLER API ============================== */

exports.registerInfluencer = async (req, res) => {
  try {
    let {
      name,
      email,
      password,
      phone,

      // minimal audience/location you kept
      countryId,
      callingId,

      // multi-platform payload inputs
      platforms,     // preferred: [{ provider: 'youtube'|'tiktok'|'instagram', data: <payload> }]
      youtube,       // optional: raw JSON or JSON-string
      tiktok,        // optional: raw JSON or JSON-string
      instagram      // optional: raw JSON or JSON-string
    } = req.body;

    // 1) Basic validations
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (!name || !phone || !countryId || !callingId) {
      return res.status(400).json({ message: 'Missing required fields (name, phone, countryId, callingId)' });
    }

    // 2) Ensure email was verified for Influencer role
    const verifiedRec = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: 'Influencer',
      verified: true
    });
    if (!verifiedRec) {
      return res.status(400).json({ message: 'Email not verified' });
    }

    // 3) Prevent duplicate registration (case-insensitive)
    const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');
    const already = await mongoose.model('Influencer').findOne({ email: emailRegexCI }, '_id');
    if (already) {
      return res.status(400).json({ message: 'Already registered' });
    }

    // 4) Validate Country + CallingCode refs
    const [countryDoc, callingDoc] = await Promise.all([
      Country.findById(countryId),
      Country.findById(callingId)
    ]);
    if (!countryDoc || !callingDoc) {
      return res.status(400).json({ message: 'Invalid countryId or callingId' });
    }

    // 5) Map platform payloads → socialProfiles[]
    const profiles = [];
    if (Array.isArray(platforms)) {
      for (const item of platforms) {
        if (!item || !item.provider) continue;
        const mapped = mapPayload(String(item.provider).toLowerCase(), item.data);
        if (mapped) profiles.push(mapped);
      }
    } else {
      const y = mapPayload('youtube', youtube);
      const tt = mapPayload('tiktok', tiktok);
      const ig = mapPayload('instagram', instagram);
      if (y) profiles.push(y);
      if (tt) profiles.push(tt);
      if (ig) profiles.push(ig);
    }
    if (!profiles.length) {
      return res.status(400).json({ message: 'No valid platform payloads provided' });
    }

    // 6) Resolve categories/subcategories for each profile (NEW)
    const idx = await buildCategoryIndex();
    for (const prof of profiles) {
      const rawCats = extractRawCategoriesFromProviderRaw(prof.providerRaw);
      prof.categories = normalizeCategories(rawCats, idx); // array of {categoryId, categoryName, subcategoryId, subcategoryName}
    }

    // 7) Create Influencer doc (password is hashed by schema pre-save)
    const inf = new (mongoose.model('Influencer'))({
      name,
      email: normalizedEmail,
      password,
      phone,

      primaryPlatform: profiles[0]?.provider || null,
      socialProfiles: profiles,

      countryId,
      country: countryDoc.countryName,
      callingId,
      callingcode: callingDoc.callingCode
    });

    // 8) Initialize free subscription
    const freePlan = await subscriptionHelper.getFreePlan('Influencer');
    if (freePlan) {
      inf.subscription = {
        planId: freePlan.planId,
        planName: freePlan.name,
        startedAt: new Date(),
        expiresAt: subscriptionHelper.computeExpiry(freePlan),
        features: freePlan.features.map(f => ({
          key: f.key,
          limit: typeof f.value === 'number' ? f.value : 0,
          used: 0
        }))
      };
      inf.subscriptionExpired = false;
    }

    await inf.save();

    // 9) Clean up verification record
    await VerifyEmail.deleteOne({ email: normalizedEmail, role: 'Influencer' });

    return res.status(201).json({
      message: 'Influencer registered successfully',
      influencerId: inf.influencerId,
      primaryPlatform: inf.primaryPlatform,
      socialProfilesCount: inf.socialProfiles.length,
      subscription: inf.subscription
    });
  } catch (err) {
    console.error('Error in registerInfluencer:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Both fields are required' });
  }

  try {
    const influencer = await Influencer.findOne({
      email: { $regex: `^${email.trim()}$`, $options: 'i' }
    });
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    // ⛔ If locked, block regardless of password correctness
    const now = new Date();
    if (influencer.lockUntil && influencer.lockUntil > now) {
      const msLeft = influencer.lockUntil.getTime() - now.getTime();
      const minutesLeft = Math.ceil(msLeft / (60 * 1000));
      return res.status(403).json({
        message: 'Account locked due to multiple failed login attempts. Try again after the lock period.',
        lockUntil: influencer.lockUntil,
        minutesLeft
      });
    }

    const isMatch = await influencer.comparePassword(password);
    if (!isMatch) {
      // ❌ Wrong password → count & maybe lock
      influencer.failedLoginAttempts = (influencer.failedLoginAttempts || 0) + 1;

      if (influencer.failedLoginAttempts >= 3) {
        const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
        influencer.lockUntil = new Date(Date.now() + LOCK_WINDOW_MS);
      }

      await influencer.save();

      if (influencer.lockUntil && influencer.lockUntil > now) {
        return res.status(403).json({
          message: 'Too many failed attempts. Account locked for 24 hours.',
          lockUntil: influencer.lockUntil
        });
      }

      const attemptsLeft = Math.max(0, 3 - influencer.failedLoginAttempts);
      return res.status(400).json({
        message: 'Invalid credentials',
        attemptsLeft
      });
    }

    // ✅ Correct password & not locked → reset counters
    if (influencer.failedLoginAttempts || influencer.lockUntil) {
      influencer.failedLoginAttempts = 0;
      influencer.lockUntil = null;
      await influencer.save();
    }

    const token = jwt.sign(
      { influencerId: influencer.influencerId, email: influencer.email },
      JWT_SECRET,
      { expiresIn: '100d' }
    );

    return res.status(200).json({
      message: 'Login successful',
      influencerId: influencer.influencerId,
      categoryId: influencer.categoryId,
      token
    });
  } catch (error) {
    console.error('Error in influencer.login:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(403).json({ message: 'Token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.influencer = decoded;
    next();
  });
};

exports.getList = async (req, res) => {
  try {
    const influencers = await Influencer.find({}, '-password -__v');
    return res.status(200).json(influencers);
  } catch (error) {
    console.error('Error fetching influencers:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getById = async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ message: 'influencerId query parameter is required' });
  }
  try {
    // Exclude sensitive/internal fields up front
    const projection =
      '-password -__v -_id -_ac -paymentMethods -platformId -audienceAgeRangeId -audienceId -countryId -callingId -categories -subscription.planId';

    const doc = await Influencer.findOne({ influencerId: id }, projection).lean();
    if (!doc) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const genderMap = { 0: 'male', 1: 'female', 2: 'other' };
    const out = { ...doc };

    // Preserve influencerId, then remove any remaining *Id keys at root
    const influId = out.influencerId;
    Object.keys(out).forEach((k) => {
      if (k !== 'influencerId' && /id$/i.test(k)) delete out[k];
    });

    // Ensure nested planId is gone (in case projection changes later)
    if (out.subscription && 'planId' in out.subscription) {
      delete out.subscription.planId;
    }

    // Rename influencerId -> InfluencerID
    delete out.influencerId;
    out.influencerId = influId;

    // Map gender number -> string
    if (typeof out.gender === 'number') {
      out.gender = genderMap[out.gender] ?? out.gender;
    } else if (typeof out.gender === 'string' && /^\d+$/.test(out.gender)) {
      const code = parseInt(out.gender, 10);
      out.gender = genderMap[code] ?? out.gender;
    }

    return res.status(200).json(out);
  } catch (error) {
    console.error('Error fetching influencer by ID:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCampaignsByInfluencer = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.body;

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const filter = { influencerId };
    if (search.trim()) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (Math.max(page, 1) - 1) * Math.max(limit, 1);
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const total = await Campaign.countDocuments(filter);

    const campaigns = await Campaign.find(filter)
      .sort({ [sortBy]: sortDirection })
      .skip(skip)
      .limit(limit);

    return res.status(200).json({
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
      campaigns
    });
  } catch (error) {
    console.error('Error in getCampaignsByInfluencer:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.requestPasswordResetOtpInfluencer = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const influencer = await Influencer.findOne({
    email: { $regex: `^${email.trim()}$`, $options: 'i' },
    name: { $exists: true, $ne: null },
    password: { $exists: true, $ne: null }
  });

  if (!influencer) {
    return res.status(200).json({ message: 'Email not exist' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  influencer.passwordResetCode = code;
  influencer.passwordResetExpiresAt = expiresAt;
  influencer.passwordResetVerified = false;
  await influencer.save();

  await transporter.sendMail({
    from: `"No-Reply" <${SMTP_USER}>`,
    to: influencer.email,
    subject: 'Password reset code',
    text: `Your password reset OTP is ${code}. It expires in 10 minutes.`
  });

  return res.status(200).json({ message: 'OTP has been sent.' });
};

exports.verifyPasswordResetOtpInfluencer = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || otp == null) {
    return res.status(400).json({ message: 'Email and otp required' });
  }

  const influencer = await Influencer.findOne({
    email: { $regex: `^${email.trim()}$`, $options: 'i' },
    passwordResetCode: otp.toString().trim(),
    passwordResetExpiresAt: { $gt: new Date() }
  });

  if (!influencer) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  influencer.passwordResetVerified = true;
  influencer.passwordResetCode = undefined;
  influencer.passwordResetExpiresAt = undefined;
  await influencer.save();

  const resetToken = jwt.sign(
    { influencerId: influencer.influencerId, email: influencer.email, prt: true },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  return res.status(200).json({ message: 'OTP verified', resetToken });
};

exports.resetPasswordInfluencer = async (req, res) => {
  const { resetToken, newPassword, confirmPassword } = req.body;
  if (!resetToken || !newPassword) {
    return res.status(400).json({ message: 'resetToken and newPassword required' });
  }
  if (confirmPassword != null && confirmPassword !== newPassword) {
    return res.status(400).json({ message: 'Passwords do not match' });
  }

  try {
    const decoded = jwt.verify(resetToken, JWT_SECRET);
    if (!decoded.prt) {
      return res.status(403).json({ message: 'Invalid reset token' });
    }

    const influencer = await Influencer.findOne({ influencerId: decoded.influencerId });
    if (!influencer) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    if (!influencer.passwordResetVerified) {
      return res.status(400).json({ message: 'Password reset not verified' });
    }

    // set new password (will hash via pre-save hook)
    influencer.password = newPassword;

    // 🔄 Clear lock & attempts after successful reset
    influencer.failedLoginAttempts = 0;
    influencer.lockUntil = null;

    // finalize reset flow
    influencer.passwordResetVerified = false;

    await influencer.save();

    return res.status(200).json({ message: 'Password reset successful. You can log in now.' });
  } catch (err) {
    console.error('Error in resetPasswordInfluencer:', err);
    return res.status(403).json({ message: 'Invalid or expired reset token' });
  }
};




exports.addPaymentMethod = async (req, res) => {
  try {
    const { type, bank = {}, paypal = {}, isDefault = false ,influencerId} = req.body;

    // validate type
    if (![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const paymentObj = {
      paymentId: uuidv4(),
      type: Number(type),
      bank: undefined,
      paypal: undefined,
      isDefault: Boolean(isDefault)
    };

    if (Number(type) === 1) {
      // 2) require new bank.countryId
      const required = ['accountHolder', 'accountNumber', 'bankName', 'countryId'];
      for (const f of required) {
        if (!bank[f] || !bank[f].toString().trim()) {
          return res.status(400).json({ message: `Missing bank field: ${f}` });
        }
      }

      // 3) fetch country to get its name
      const countryDoc = await Country.findById(bank.countryId);
      if (!countryDoc) {
        return res.status(400).json({ message: 'Invalid bank.countryId' });
      }

      paymentObj.bank = {
        accountHolder: bank.accountHolder.trim(),
        accountNumber: bank.accountNumber.trim(),
        ifsc: bank.ifsc?.trim(),
        swift: bank.swift?.trim(),
        bankName: bank.bankName.trim(),
        branch: bank.branch?.trim(),
        countryId: countryDoc._id,              // store the ObjectId
        countryName: countryDoc.countryName            // store the fetched name
      };

    } else {
      // PayPal
      if (!paypal.email || !paypal.email.trim()) {
        return res.status(400).json({ message: 'paypal.email is required' });
      }
      paymentObj.paypal = {
        email: paypal.email.trim(),
        username: paypal.username?.trim()
      };
    }

    // ensure only one default
    if (paymentObj.isDefault) {
      inf.paymentMethods.forEach(pm => (pm.isDefault = false));
    } else if (inf.paymentMethods.length === 0) {
      // first method becomes default
      paymentObj.isDefault = true;
    }

    inf.paymentMethods.push(paymentObj);
    await inf.save();

    return res.status(201).json({
      message: 'Payment method added',
      paymentId: paymentObj.paymentId,
      paymentMethods: inf.paymentMethods
    });

  } catch (err) {
    console.error('Error in addPaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};






exports.deletePaymentMethod = async (req, res) => {
  try {
    const { influencerId } = req.influencer || {};
    const { paymentId } = req.body;

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const idx = inf.paymentMethods.findIndex(pm => pm.paymentId === paymentId);
    if (idx === -1) return res.status(404).json({ message: 'Payment method not found' });

    const wasDefault = inf.paymentMethods[idx].isDefault;
    inf.paymentMethods.splice(idx, 1);

    if (wasDefault && inf.paymentMethods.length > 0) {
      inf.paymentMethods[0].isDefault = true;
    }

    await inf.save();
    return res.status(200).json({ message: 'Payment method deleted', paymentMethods: inf.paymentMethods });
  } catch (err) {
    console.error('Error in deletePaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};





const mask = (val = '', keep = 4) =>
  val.length <= keep ? val : '*'.repeat(val.length - keep) + val.slice(-keep);

exports.viewPaymentByType = async (req, res) => {
  try {
    const requester = req.influencer;
    const { influencerId, type } = req.body || {};

    // validate inputs
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }
    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }
    if (!requester || requester.influencerId !== influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const inf = await Influencer.findOne(
      { influencerId },
      'paymentMethods influencerId'
    );
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    let methods = inf.paymentMethods.filter(pm => pm.type === Number(type));

    if (Number(type) === 1) {
      // mask account numbers
      methods = methods.map(pm => {
        const obj = pm.toObject();
        if (obj.bank?.accountNumber) {
          obj.bank.accountNumber = mask(obj.bank.accountNumber);
        }
        // countryName is safe to return
        return obj;
      });
    }

    return res.status(200).json({
      influencerId: inf.influencerId,
      type: Number(type),
      paymentMethods: methods
    });

  } catch (err) {
    console.error('Error in viewPaymentByType:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};





exports.updatePaymentMethod = async (req, res) => {
  try {
    const {
      paymentId,
      type,
      bank = {},
      paypal = {},
      isDefault,
      influencerId
    } = req.body || {};

    // validate
    if (!paymentId) {
      return res.status(400).json({ message: 'paymentId is required' });
    }
    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({ message: 'type must be 0 (PayPal) or 1 (Bank)' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    const pm = inf.paymentMethods.id(paymentId) || inf.paymentMethods.find(p => p.paymentId === paymentId);
    if (!pm) {
      return res.status(404).json({ message: 'Payment method not found' });
    }

    // set new type
    pm.type = Number(type);

    if (pm.type === 1) {
      // bank update: require core fields + countryId
      const required = ['accountHolder', 'accountNumber', 'bankName', 'countryId'];
      for (const f of required) {
        const val = bank[f] ?? pm.bank?.[f];
        if (!val || !String(val).trim()) {
          return res.status(400).json({ message: `Missing bank field: ${f}` });
        }
      }

      // fetch country if changed or use existing
      let countryDoc;
      if (bank.countryId && bank.countryId !== String(pm.bank?.countryId)) {
        countryDoc = await Country.findById(bank.countryId);
        if (!countryDoc) {
          return res.status(400).json({ message: 'Invalid bank.countryId' });
        }
      } else {
        countryDoc = await Country.findById(pm.bank.countryId);
      }

      pm.bank = {
        accountHolder: (bank.accountHolder ?? pm.bank.accountHolder).trim(),
        accountNumber: (bank.accountNumber ?? pm.bank.accountNumber).trim(),
        ifsc: bank.ifsc?.trim() ?? pm.bank.ifsc,
        swift: bank.swift?.trim() ?? pm.bank.swift,
        bankName: (bank.bankName ?? pm.bank.bankName).trim(),
        branch: bank.branch?.trim() ?? pm.bank.branch,
        countryId: countryDoc._id,
        countryName: countryDoc.countryName
      };
      // clear PayPal
      pm.paypal = undefined;

    } else {
      // PayPal update
      const emailVal = paypal.email ?? pm.paypal?.email;
      if (!emailVal || !String(emailVal).trim()) {
        return res.status(400).json({ message: 'paypal.email is required' });
      }
      pm.paypal = {
        email: paypal.email?.trim() ?? pm.paypal.email,
        username: paypal.username?.trim() ?? pm.paypal.username
      };
      pm.bank = undefined;
    }

    // handle default flag
    if (typeof isDefault === 'boolean') {
      if (isDefault) {
        inf.paymentMethods.forEach(x => (x.isDefault = false));
        pm.isDefault = true;
      } else {
        pm.isDefault = false;
        // ensure at least one default
        if (!inf.paymentMethods.some(x => x.isDefault)) {
          pm.isDefault = true;
        }
      }
    }

    await inf.save();

    return res.status(200).json({
      message: 'Payment method updated',
      paymentMethod: pm,
      paymentMethods: inf.paymentMethods
    });

  } catch (err) {
    console.error('Error in updatePaymentMethod:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};






const delay = ms => new Promise(res => setTimeout(res, ms));

exports.searchInfluencers = async (req, res) => {
  try {
    const requester = req.brand;
    const { search, brandId } = req.body || {};

    if (!brandId) return res.status(400).json({ message: 'brandId is required' });
    if (!requester || requester.brandId !== brandId) return res.status(403).json({ message: 'Forbidden' });

    if (!search || !String(search).trim()) {
      return res.status(400).json({ message: 'search is required' });
    }

    await delay(300);

    const q = search.trim().toLowerCase();
    const rx = new RegExp('^' + escapeRegExp(q));

    const docs = await Influencer
      .find({ _ac: { $regex: rx } }, 'name influencerId')
      .limit(10)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({ message: 'No influencers found' });
    }

    const results = docs.map(d => ({ name: d.name, influencerId: d.influencerId }));
    return res.json({ results });
  } catch (err) {
    console.error('Error in searchInfluencers:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};




exports.searchBrands = async (req, res) => {
  try {
    const requester = req.influencer;
    const { search } = req.body || {};

    if (!requester || !requester.influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!search || !String(search).trim()) {
      return res.status(400).json({ message: 'search is required' });
    }

    await delay(300);

    const regex = new RegExp(search.trim(), 'i');
    const docs = await Brand.find({ name: regex }, 'name brandId')
      .limit(10)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({ message: 'No brands found' });
    }

    const results = docs.map(d => ({
      name: d.name,
      brandId: d.brandId
    }));
    return res.json({ results });
  } catch (err) {
    console.error('Error in searchBrands:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


exports.suggestInfluencers = async (req, res) => {
  try {
    const { q: rawQ = '', limit: rawLimit = 8 } = req.body || {};
    const q = String(rawQ).trim().toLowerCase();
    const limit = Math.max(1, Math.min(20, parseInt(rawLimit, 10) || 8));
    if (!q) return res.json({ success: true, suggestions: [] });

    const rx = new RegExp('^' + escapeRegExp(q));
    const candidates = await Influencer.find(
      { _ac: { $regex: rx } },
      { name: 1, categoryName: 1, platformName: 1, country: 1, socialMedia: 1 }
    ).limit(100).lean();

    const set = new Set();
    for (const c of candidates) {
      if (c.name) set.add(c.name);
      if (Array.isArray(c.categoryName)) c.categoryName.forEach(v => v && set.add(v));
      if (c.platformName) set.add(c.platformName);
      if (c.country) set.add(c.country);
      if (c.socialMedia) set.add(c.socialMedia);
    }

    const list = Array.from(set);
    const starts = list.filter(s => s.toLowerCase().startsWith(q));
    const contains = list.filter(s => !s.toLowerCase().startsWith(q) && s.toLowerCase().includes(q));
    const ordered = [...starts, ...contains].slice(0, limit);

    res.json({ success: true, suggestions: ordered });
  } catch (err) {
    console.error('Suggestion error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};


// =====================================
// 1) updateProfile  (no email updates)
// =====================================
exports.updateProfile = async (req, res) => {
  try {
    const {
      influencerId,
      // DO NOT accept email here – email changes via requestEmailUpdate + verifyotp only
      name,
      password,
      phone,
      socialMedia,
      gender,
      platformId,
      manualPlatformName,
      profileLink,
      malePercentage,
      femalePercentage,
      categories,
      audienceAgeRangeId,
      audienceId,
      countryId,
      callingId,
      bio
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) {
      return res.status(404).json({ message: 'Influencer not found' });
    }

    if (typeof req.body.email !== 'undefined') {
      return res.status(400).json({ message: 'Email cannot be updated here. Use requestEmailUpdate & verifyotp.' });
    }

    // Optional: update profile image if sent (use the same upload middleware on the route)
    if (req.file) {
      inf.profileImage = `/uploads/profile_images/${req.file.filename}`;
    }

    if (typeof name !== 'undefined') inf.name = name;
    if (typeof password !== 'undefined' && password) inf.password = password; // hashed by pre-save hook
    if (typeof phone !== 'undefined') inf.phone = phone;
    if (typeof socialMedia !== 'undefined') inf.socialMedia = socialMedia;
    if (typeof gender !== 'undefined') inf.gender = Number(gender);
    if (typeof profileLink !== 'undefined') inf.profileLink = profileLink;
    if (typeof bio !== 'undefined') inf.bio = bio;

    // Platform update (optional)
    if (typeof platformId !== 'undefined') {
      let platformDoc = await Platform.findOne({ platformId });
      if (!platformDoc) {
        return res.status(400).json({ message: 'Invalid platformId' });
      }
      if (platformDoc.name === 'Other') {
        if (!manualPlatformName?.trim()) {
          return res.status(400).json({ message: 'manualPlatformName is required when platform is Other' });
        }
        platformDoc = await new Platform({ name: manualPlatformName.trim() }).save();
      }
      inf.platformId = platformDoc._id;
      inf.platformName = platformDoc.name;
    }

    // Categories (optional)
    if (typeof categories !== 'undefined') {
      let parsed = categories;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { return res.status(400).json({ message: 'categories must be a JSON array' }); }
      }
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) {
        return res.status(400).json({ message: 'You must select between 1 and 3 categories' });
      }
      const interestDocs = await Interest.find({ _id: { $in: parsed } });
      if (interestDocs.length !== parsed.length) {
        return res.status(400).json({ message: 'Invalid category IDs' });
      }
      inf.categories = interestDocs.map(d => d._id);
      inf.categoryName = interestDocs.map(d => d.name);
    }

    // Audience bifurcation (optional)
    const hasMale = typeof malePercentage !== 'undefined';
    const hasFemale = typeof femalePercentage !== 'undefined';
    if (hasMale || hasFemale) {
      inf.audienceBifurcation = {
        malePercentage: hasMale ? Number(malePercentage) : inf.audienceBifurcation?.malePercentage,
        femalePercentage: hasFemale ? Number(femalePercentage) : inf.audienceBifurcation?.femalePercentage
      };
    }

    // Audience Age Range (optional)
    if (typeof audienceAgeRangeId !== 'undefined') {
      const ageRangeDoc = await Audience.findOne({ audienceId: audienceAgeRangeId });
      if (!ageRangeDoc) return res.status(400).json({ message: 'Invalid audienceAgeRangeId' });
      inf.audienceAgeRangeId = ageRangeDoc._id;
      inf.audienceAgeRange = ageRangeDoc.range;
    }

    // Audience Count Range (optional)
    if (typeof audienceId !== 'undefined') {
      const countRangeDoc = await AudienceRange.findById(audienceId);
      if (!countRangeDoc) return res.status(400).json({ message: 'Invalid audienceId' });
      inf.audienceId = countRangeDoc._id;
      inf.audienceRange = countRangeDoc.range;
    }

    // Country / Calling code (optional)
    if (typeof countryId !== 'undefined') {
      const countryDoc = await Country.findById(countryId);
      if (!countryDoc) return res.status(400).json({ message: 'Invalid countryId' });
      inf.countryId = countryDoc._id;
      inf.country = countryDoc.countryName;
    }
    if (typeof callingId !== 'undefined') {
      const callingDoc = await Country.findById(callingId);
      if (!callingDoc) return res.status(400).json({ message: 'Invalid callingId' });
      inf.callingId = callingDoc._id;
      inf.callingcode = callingDoc.callingCode;
    }

    await inf.save();
    return res.status(200).json({ message: 'Profile updated successfully' });
  } catch (err) {
    console.error('Error in updateProfile:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};



// =====================================================
// 2) requestEmailUpdate  (send OTP to old & new emails)
// =====================================================
exports.requestEmailUpdate = async (req, res) => {
  try {
    const { influencerId, newEmail, role='Influencer' } = req.body || {};
    if (!influencerId || !newEmail || !role) {
      return res.status(400).json({ message: 'influencerId, newEmail and role are required' });
    }
    if (!['Influencer', 'Brand'].includes(String(role))) {
      return res.status(400).json({ message: 'role must be "Influencer" or "Brand"' });
    }
    // This API updates an Influencer only
    if (role !== 'Influencer') {
      return res.status(400).json({ message: 'This endpoint is for Influencer role only' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const oldEmail = String(inf.email || '').trim().toLowerCase();
    const nextEmail = String(newEmail).trim().toLowerCase();
    if (!nextEmail) return res.status(400).json({ message: 'newEmail is required' });
    if (nextEmail === oldEmail) return res.status(400).json({ message: 'New email must be different from current email' });

    // Ensure new email is not already taken by another Influencer
    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, 'i');
    const exists = await Influencer.findOne({ email: emailRegexCI }, '_id influencerId');
    if (exists && String(exists.influencerId) !== String(influencerId)) {
      return res.status(409).json({ message: 'New email already in use' });
    }

    // Generate OTPs
    const codeOld = Math.floor(100000 + Math.random() * 900000).toString();
    const codeNew = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Upsert VerifyEmail for OLD email (keep role = Influencer). Do not change verified flag here.
    await VerifyEmail.findOneAndUpdate(
      { email: oldEmail, role: 'Influencer' },
      {
        $set: { otpCode: codeOld, otpExpiresAt: expiresAt },
        $inc: { attempts: 1 }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // Upsert VerifyEmail for NEW email (role = Influencer). Leave verified=false until success.
    await VerifyEmail.findOneAndUpdate(
      { email: nextEmail, role: 'Influencer' },
      {
        $set: { otpCode: codeNew, otpExpiresAt: expiresAt, verified: false },
        $inc: { attempts: 1 }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // Send OTPs
    try {
      await transporter.sendMail({
        from: `"No-Reply" <${SMTP_USER}>`,
        to: oldEmail,
        subject: 'Confirm your email change (OLD email)',
        text: `OTP to confirm email change (old email): ${codeOld}. It expires in 10 minutes.`
      });
    } catch (e) {
      console.warn('Failed to send OTP to old email:', e.message);
    }

    try {
      await transporter.sendMail({
        from: `"No-Reply" <${SMTP_USER}>`,
        to: nextEmail,
        subject: 'Confirm your email change (NEW email)',
        text: `OTP to confirm email change (new email): ${codeNew}. It expires in 10 minutes.`
      });
    } catch (e) {
      console.warn('Failed to send OTP to new email:', e.message);
    }

    return res.status(200).json({ message: 'OTPs sent to old and new emails' });
  } catch (err) {
    console.error('Error in requestEmailUpdate:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};


// ======================================================================
// 3) verifyotp  (verify both OTPs; swap email; flip old verified=false)
// ======================================================================
exports.verifyotp = async (req, res) => {
  try {
    const { influencerId, role='Influencer', oldEmailOtp, newEmailOtp, newEmail } = req.body || {};
    if (!influencerId || !role || !oldEmailOtp || !newEmailOtp || !newEmail) {
      return res.status(400).json({ message: 'influencerId, role, oldEmailOtp, newEmailOtp, and newEmail are required' });
    }
    if (String(role) !== 'Influencer') {
      return res.status(400).json({ message: 'role must be "Influencer" for this endpoint' });
    }

    const inf = await Influencer.findOne({ influencerId });
    if (!inf) return res.status(404).json({ message: 'Influencer not found' });

    const oldEmail = String(inf.email || '').trim().toLowerCase();
    const nextEmail = String(newEmail || '').trim().toLowerCase();
    if (!nextEmail) return res.status(400).json({ message: 'newEmail is required' });
    if (nextEmail === oldEmail) return res.status(400).json({ message: 'New email must be different from current email' });

    // Double-check new email is still available
    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, 'i');
    const exists = await Influencer.findOne({ email: emailRegexCI }, '_id influencerId');
    if (exists && String(exists.influencerId) !== String(influencerId)) {
      return res.status(409).json({ message: 'New email already in use' });
    }

    const now = new Date();

    // Verify OLD email OTP
    const oldVE = await VerifyEmail.findOne({
      email: oldEmail,
      role: 'Influencer',
      otpCode: String(oldEmailOtp).trim(),
      otpExpiresAt: { $gt: now }
    });
    if (!oldVE) {
      return res.status(400).json({ message: 'Invalid or expired OTP for old email' });
    }

    // Verify NEW email OTP
    const newVE = await VerifyEmail.findOne({
      email: nextEmail,
      role: 'Influencer',
      otpCode: String(newEmailOtp).trim(),
      otpExpiresAt: { $gt: now }
    });
    if (!newVE) {
      return res.status(400).json({ message: 'Invalid or expired OTP for new email' });
    }

    // All good → update influencer email
    inf.email = nextEmail;
    await inf.save();

    // Update verifyEmail rows:
    // - Old email → set verified=false; clear OTP
    oldVE.verified = false;
    oldVE.otpCode = undefined;
    oldVE.otpExpiresAt = undefined;
    oldVE.verifiedAt = new Date();
    await oldVE.save();

    // - New email → set verified=true; clear OTP
    newVE.verified = true;
    newVE.otpCode = undefined;
    newVE.otpExpiresAt = undefined;
    newVE.verifiedAt = new Date();
    await newVE.save();

    return res.status(200).json({ message: 'Email updated successfully' });
  } catch (err) {
    console.error('Error in verifyotp:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
