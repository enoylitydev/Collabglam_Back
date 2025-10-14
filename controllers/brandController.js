// controllers/brandController.js
require('dotenv').config();
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const Brand = require('../models/brand');
const Influencer = require('../models/influencer'); // needed by requestOtp
const Country = require('../models/country');
const Milestone = require('../models/milestone');
const Subscription = require('../models/subscription');
const subscriptionHelper = require('../utils/subscriptionHelper');
const VerifyEmail = require('../models/verifyEmail');
const { escapeRegExp } = require('../utils/searchTokens'); // for exact match, case-insensitive

// ---- helpers ----
const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const exactEmailRegex = (email) => new RegExp(`^${escapeRegExp(String(email).trim())}$`, 'i');
const toNormEmail = (e) => String(e || '').trim().toLowerCase();

// ---- NEW: local enums (keep in sync with model) ----
const CATEGORY_ENUM = [
  'Beauty', 'Tech', 'Food', 'Fashion', 'Fitness', 'Travel', 'Education',
  'Gaming', 'Home', 'Auto', 'Finance', 'Health', 'Lifestyle', 'Other',
];
const COMPANY_SIZE_ENUM = ['1-10', '11-50', '51-200', '200+'];
const BUSINESS_TYPE_ENUM = ['Direct-to-Consumer', 'Agency', 'Marketplace', 'SaaS', 'Other'];

// ---- simple normalizers ----
const normalizeUrl = (u) => {
  const s = String(u || '').trim();
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};
const normalizeInsta = (h) => {
  const s = String(h || '').trim().replace(/^@/, '').toLowerCase();
  return s || undefined;
};

// ---- env / mailer ----
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ---------- 1) Request OTP (signup) ----------
exports.requestOtp = async (req, res) => {
  try {
    const { email, role="Brand" } = req.body;
    if (!email || !role) {
      return res.status(400).json({ message: 'Both email and role are required' });
    }

    const normalizedEmail = toNormEmail(email);
    const normalizedRole = String(role).trim();

    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Invalid email' });
    }
    if (!['Brand', 'Influencer'].includes(normalizedRole)) {
      return res.status(400).json({ message: 'role must be "Brand" or "Influencer"' });
    }

    // If already registered for that role, block OTP
    const alreadyRegistered =
      normalizedRole === 'Brand'
        ? await Brand.findOne({ email: exactEmailRegex(normalizedEmail) }, '_id')
        : await Influencer.findOne({ email: exactEmailRegex(normalizedEmail) }, '_id');

    if (alreadyRegistered) {
      return res.status(409).json({ message: 'User already present' });
    }

    // Generate code & expiry
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Upsert verification record for (email, role)
    await VerifyEmail.findOneAndUpdate(
      { email: normalizedEmail, role: normalizedRole },
      {
        $set: {
          otpCode: code,
          otpExpiresAt: expiresAt,
          verified: false,
          verifiedAt: null,
        },
        $inc: { attempts: 1 },
        $setOnInsert: { email: normalizedEmail, role: normalizedRole },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Send OTP email
    await transporter.sendMail({
      from: `"No-Reply" <${SMTP_USER}>`,
      to: normalizedEmail,
      subject: 'Your verification code',
      text: `Your OTP is ${code}. It expires in 10 minutes.`,
    });

    return res.json({ message: 'OTP sent to email' });
  } catch (err) {
    console.error('Error in requestOtp:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 2) Verify OTP (signup) ----------
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp, role="Brand" } = req.body;
    if (!email || otp == null || !role) {
      return res.status(400).json({ message: 'email, otp and role are required' });
    }

    const normalizedEmail = toNormEmail(email);
    const normalizedRole = String(role).trim();

    if (!['Brand', 'Influencer'].includes(normalizedRole)) {
      return res.status(400).json({ message: 'role must be "Brand" or "Influencer"' });
    }

    const doc = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: normalizedRole,
      otpCode: String(otp).trim(),
      otpExpiresAt: { $gt: new Date() },
    });

    if (!doc) {
      return res.status(400).json({ message: 'Invalid or expired OTP' });
    }

    // Mark verified and clear OTP values
    doc.verified = true;
    doc.verifiedAt = new Date();
    doc.otpCode = undefined;
    doc.otpExpiresAt = undefined;
    await doc.save();

    return res.json({ message: 'OTP verified' });
  } catch (err) {
    console.error('Error in verifyOtp:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.register = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      countryId,
      callingId,

      // NEW fields
      category,                // required
      website,                 // optional
      instagramHandle,         // optional
      logoUrl,                 // optional
      companySize,             // optional
      businessType,            // optional
      referralCode,            // optional
      isVerifiedRepresentative // required: must be true
    } = req.body;

    // required checks
    if (!name || !email || !password || !phone || !countryId || !callingId) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // NEW required checks
    if (!category || !CATEGORY_ENUM.includes(String(category))) {
      return res.status(400).json({ message: 'Invalid or missing brand category' });
    }
    if (isVerifiedRepresentative !== true) {
      return res.status(400).json({ message: 'You must confirm you are an official representative of this brand' });
    }

    const normalizedEmail = toNormEmail(email);
    const exactCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, 'i');

    // Must be verified via VerifyEmail for BRAND role
    const emailDoc = await VerifyEmail.findOne({
      email: normalizedEmail,
      role: 'Brand',
      verified: true,
    });
    if (!emailDoc) {
      return res.status(400).json({ message: 'Email not verified' });
    }

    // Prevent duplicate registration
    const existing = await Brand.findOne({ email: exactCI }, '_id');
    if (existing) {
      return res.status(400).json({ message: 'Already registered' });
    }

    // Validate country / calling code
    const [countryDoc, callingDoc] = await Promise.all([
      Country.findById(countryId),
      Country.findById(callingId),
    ]);
    if (!countryDoc || !callingDoc) {
      return res.status(400).json({ message: 'Invalid country or calling code' });
    }

    // Normalize optionals
    const websiteNorm = normalizeUrl(website);
    const logoUrlNorm = normalizeUrl(logoUrl);
    const instaNorm = normalizeInsta(instagramHandle);

    // Validate enums if provided
    if (companySize && !COMPANY_SIZE_ENUM.includes(String(companySize))) {
      return res.status(400).json({ message: 'Invalid company size' });
    }
    if (businessType && !BUSINESS_TYPE_ENUM.includes(String(businessType))) {
      return res.status(400).json({ message: 'Invalid business type' });
    }

    // Create brand
    const brand = new Brand({
      name,
      email: normalizedEmail,
      password, // hashed by pre-save hook
      phone,
      country: countryDoc.countryName,
      callingcode: callingDoc.callingCode,
      countryId,
      callingId,

      // NEW fields
      category: String(category),
      website: websiteNorm,
      instagramHandle: instaNorm,
      logoUrl: logoUrlNorm,
      companySize: companySize ? String(companySize) : undefined,
      businessType: businessType ? String(businessType) : undefined,
      referralCode: referralCode ? String(referralCode).trim() : undefined,
      isVerifiedRepresentative: true,
    });

    // Free plan
    const freePlan = await subscriptionHelper.getFreePlan('Brand');
    if (freePlan) {
      brand.subscription = {
        planId: freePlan.planId,
        planName: freePlan.name,
        role: 'Brand',
        startedAt: new Date(),
        expiresAt: subscriptionHelper.computeExpiry(freePlan),
        features: (freePlan.features || []).map((f) => ({
          key: f.key,
          limit: typeof f.value === 'number' ? f.value : 0,
          used: 0,
        })),
      };
      brand.subscriptionExpired = false;
    }

    await brand.save();

    // Clean up verification record
    await VerifyEmail.deleteOne({ email: normalizedEmail, role: 'Brand' });

    return res.status(201).json({
      message: 'Brand registered successfully',
      brandId: brand.brandId,
      subscription: brand.subscription,
    });
  } catch (error) {
    console.error('Error in register:', error);

    // Friendly validation surfacing
    if (error?.name === 'ValidationError') {
      const first = Object.values(error.errors)[0];
      return res.status(400).json({ message: first?.message || 'Validation error' });
    }

    return res.status(500).json({ message: 'Internal server error during registration' });
  }
};

// ---------- 4) Login ----------
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // 1) Find brand by email (exact, case-insensitive)
    const brand = await Brand.findOne({
      email: exactEmailRegex(email),
    });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    // 2) If account is locked, block login
    const now = new Date();
    if (brand.lockUntil && brand.lockUntil > now) {
      const msLeft = brand.lockUntil.getTime() - now.getTime();
      const minutesLeft = Math.ceil(msLeft / (60 * 1000));
      return res.status(403).json({
        message: 'Account locked due to multiple failed login attempts. Try again after the lock period.',
        lockUntil: brand.lockUntil,
        minutesLeft,
      });
    }

    // 3) Compare provided password with hashed password
    const isMatch = await brand.comparePassword(password);

    if (!isMatch) {
      // Wrong password → increment attempts
      brand.failedLoginAttempts = (brand.failedLoginAttempts || 0) + 1;

      if (brand.failedLoginAttempts >= 3) {
        // Lock for 24 hours from *this* incorrect attempt
        const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
        brand.lockUntil = new Date(Date.now() + LOCK_WINDOW_MS);
      }

      await brand.save();

      if (brand.lockUntil && brand.lockUntil > now) {
        return res.status(403).json({
          message: 'Too many failed attempts. Account locked for 24 hours.',
          lockUntil: brand.lockUntil,
        });
      }

      const attemptsLeft = Math.max(0, 3 - brand.failedLoginAttempts);
      return res.status(400).json({
        message: 'Invalid credentials',
        attemptsLeft,
      });
    }

    // 4) Correct password & not locked → reset counters
    if (brand.failedLoginAttempts || brand.lockUntil) {
      brand.failedLoginAttempts = 0;
      brand.lockUntil = null;
      await brand.save();
    }

    // 5) Generate JWT (expires in 100 days)
    const token = jwt.sign(
      { brandId: brand.brandId, email: brand.email },
      JWT_SECRET,
      { expiresIn: '100d' }
    );

    return res.status(200).json({
      message: 'Login successful',
      brandId: brand.brandId,
      token,
    });
  } catch (error) {
    console.error('Error in brand.login:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 5) Verify JWT middleware ----------
exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ message: 'Token required' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ message: 'Token required' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    req.brand = decoded;
    next();
  });
};

// ---------- 6) Get Brand by ID ----------
exports.getBrandById = async (req, res) => {
  try {
    const brandId = req.query.id;
    if (!brandId) return res.status(400).json({ message: 'Query parameter id is required.' });

    const brandDoc = await Brand.findOne({ brandId })
      .select('-password -_id -__v')
      .lean();
    if (!brandDoc) return res.status(404).json({ message: 'Brand not found.' });

    const milestoneDoc = await Milestone.findOne({ brandId }).lean();
    const walletBalance = milestoneDoc ? milestoneDoc.walletBalance : 0;

    return res.status(200).json({ ...brandDoc, walletBalance });
  } catch (error) {
    console.error('Error in getBrandById:', error);
    return res.status(500).json({ message: 'Internal server error while fetching brand.' });
  }
};

// ---------- 7) Get All Brands ----------
exports.getAllBrands = async (req, res) => {
  try {
    const brands = await Brand.find()
      .select('-password -_id -__v')
      .lean();
    return res.status(200).json({ brands });
  } catch (error) {
    console.error('Error in getAllBrands:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 8) Password reset: request OTP ----------
exports.requestPasswordResetOtp = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  // Find registered brand (must have name + password set)
  const brand = await Brand.findOne({
    email: exactEmailRegex(email),
    name: { $exists: true, $ne: null },
    password: { $exists: true, $ne: null },
  });

  // Security-choice: respond generic even if not found.
  if (!brand) {
    return res
      .status(200)
      .json({ message: 'If an account with that email exists, an OTP has been sent.' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  brand.passwordResetCode = code;
  brand.passwordResetExpiresAt = expiresAt;
  brand.passwordResetVerified = false;
  await brand.save();

  await transporter.sendMail({
    from: `"No-Reply" <${SMTP_USER}>`,
    to: brand.email,
    subject: 'Password reset code',
    text: `Your password reset OTP is ${code}. It expires in 10 minutes.`,
  });

  return res
    .status(200)
    .json({ message: 'If an account with that email exists, an OTP has been sent.' });
};

// ---------- 9) Password reset: verify OTP ----------
exports.verifyPasswordResetOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || otp == null) {
    return res.status(400).json({ message: 'Email and otp required' });
  }

  const brand = await Brand.findOne({
    email: exactEmailRegex(email),
    passwordResetCode: String(otp).trim(),
    passwordResetExpiresAt: { $gt: new Date() },
  });

  if (!brand) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  brand.passwordResetVerified = true;
  // optional: clear code now to prevent reuse
  brand.passwordResetCode = undefined;
  brand.passwordResetExpiresAt = undefined;
  await brand.save();

  // Issue short-lived JWT authorizing password reset
  const resetToken = jwt.sign(
    { brandId: brand.brandId, email: brand.email, prt: true }, // prt=password reset token
    JWT_SECRET,
    { expiresIn: '100d' } // consider reducing in production (e.g., 15m)
  );

  return res.status(200).json({ message: 'OTP verified', resetToken });
};

// ---------- 10) Password reset: complete ----------
exports.resetPassword = async (req, res) => {
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

    const brand = await Brand.findOne({ brandId: decoded.brandId });
    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    if (!brand.passwordResetVerified) {
      return res.status(400).json({ message: 'Password reset not verified' });
    }

    // set new password (pre-save hook will hash)
    brand.password = newPassword;

    // CLEAR lock & attempts so user can log in immediately
    brand.failedLoginAttempts = 0;
    brand.lockUntil = null;

    // clear the flag so reset flow can't be reused
    brand.passwordResetVerified = false;

    await brand.save();

    return res.status(200).json({ message: 'Password reset successful. You can log in now.' });
  } catch (err) {
    console.error('Error in resetPassword:', err);
    return res.status(403).json({ message: 'Invalid or expired reset token' });
  }
};

// ---------- 11) Search brands (for influencer) ----------
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

exports.searchBrands = async (req, res) => {
  try {
    const requester = req.influencer;
    const { search, influencerId } = req.body || {};

    // 1) Validate inputs
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }
    // ensure the token’s influencerId matches the body
    if (!requester || requester.influencerId !== influencerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!search || !String(search).trim()) {
      return res.status(400).json({ message: 'search is required' });
    }

    await delay(300);

    const regex = new RegExp(String(search).trim(), 'i');
    const docs = await Brand.find({ name: regex }, 'name brandId').limit(10).lean();

    if (!docs || docs.length === 0) {
      return res.status(404).json({ message: 'No brands found' });
    }

    const results = docs.map((d) => ({
      name: d.name,
      brandId: d.brandId,
    }));

    return res.json({ results });
  } catch (err) {
    console.error('Error in searchBrands:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 12) Update profile ----------
exports.updateProfile = async (req, res) => {
  try {
    // read brandId from body
    const { brandId, name, phone, countryId, callingId } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }

    // OPTIONAL: if you still use verifyToken, ensure the body brandId matches the token
    if (req.brand && req.brand.brandId && req.brand.brandId !== brandId) {
      return res.status(403).json({ message: 'Forbidden: brandId mismatch' });
    }

    // require at least one change
    if (name == null && phone == null && countryId == null && callingId == null) {
      return res.status(400).json({ message: 'No changes provided' });
    }

    const brand = await Brand.findOne({ brandId });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    if (name != null) brand.name = String(name).trim();
    if (phone != null) brand.phone = String(phone).trim();

    if (countryId) {
      const countryDoc = await Country.findById(countryId);
      if (!countryDoc) return res.status(400).json({ message: 'Invalid countryId' });
      brand.countryId = countryId;
      brand.country = countryDoc.countryName;
    }

    if (callingId) {
      const callingDoc = await Country.findById(callingId);
      if (!callingDoc) return res.status(400).json({ message: 'Invalid callingId' });
      brand.callingId = callingId;
      brand.callingcode = callingDoc.callingCode;
    }

    await brand.save();

    const safe = brand.toObject();
    delete safe.password;
    delete safe._id;
    delete safe.__v;

    return res.status(200).json({ message: 'Profile updated', brand: safe });
  } catch (err) {
    console.error('Error in updateProfile:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 13) Request Email Update (Brand) ----------
exports.requestEmailUpdate = async (req, res) => {
  try {
    const { brandId, newEmail, role = 'Brand' } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }
    if (!role || String(role).trim() !== 'Brand') {
      return res.status(400).json({ message: 'role must be "Brand"' });
    }
    if (req.brand && req.brand.brandId && req.brand.brandId !== brandId) {
      return res.status(403).json({ message: 'Forbidden: brandId mismatch' });
    }

    if (!newEmail || !emailRegex.test(String(newEmail).trim())) {
      return res.status(400).json({ message: 'Valid newEmail is required' });
    }

    const brand = await Brand.findOne({ brandId });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    const oldEmail = toNormEmail(brand.email);
    const nextEmail = toNormEmail(newEmail);

    if (oldEmail === nextEmail) {
      return res.status(400).json({ message: 'New email cannot be the same as current email' });
    }

    // Ensure newEmail not used by any other brand
    const taken = await Brand.findOne({
      email: exactEmailRegex(nextEmail),
      brandId: { $ne: brandId },
    });
    if (taken) return res.status(409).json({ message: 'Email already in use' });

    // Generate OTPs and expiry
    const oldOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // OLD email → upsert VerifyEmail for role 'Brand'
    await VerifyEmail.findOneAndUpdate(
      { email: oldEmail, role: 'Brand' },
      {
        $setOnInsert: { email: oldEmail, role: 'Brand', verified: true, verifiedAt: new Date() },
        $set: { otpCode: oldOtp, otpExpiresAt: expiresAt },
        $inc: { attempts: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // NEW email → upsert VerifyEmail for role 'Brand'
    await VerifyEmail.findOneAndUpdate(
      { email: nextEmail, role: 'Brand' },
      {
        $setOnInsert: { email: nextEmail, role: 'Brand' },
        $set: { verified: false, verifiedAt: null, otpCode: newOtp, otpExpiresAt: expiresAt },
        $inc: { attempts: 1 },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Send both OTPs
    await transporter.sendMail({
      from: `"No-Reply" <${SMTP_USER}>`,
      to: oldEmail,
      subject: 'Confirm email change (old email verification)',
      text: `Your OTP to confirm changing away from this email is ${oldOtp}. It expires in 10 minutes.`,
    });

    await transporter.sendMail({
      from: `"No-Reply" <${SMTP_USER}>`,
      to: nextEmail,
      subject: 'Confirm email change (new email verification)',
      text: `Your OTP to confirm using this as your new email is ${newOtp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ message: 'OTPs sent to old and new emails' });
  } catch (err) {
    console.error('Error in requestEmailUpdate:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// ---------- 14) Verify Email Update (Brand) ----------
exports.verifyEmailUpdate = async (req, res) => {
  try {
    const { brandId, newEmail, oldOtp, newOtp, role = 'Brand' } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: 'brandId is required' });
    }
    if (!role || String(role).trim() !== 'Brand') {
      return res.status(400).json({ message: 'role must be "Brand"' });
    }
    if (req.brand && req.brand.brandId && req.brand.brandId !== brandId) {
      return res.status(403).json({ message: 'Forbidden: brandId mismatch' });
    }

    if (!newEmail || !emailRegex.test(String(newEmail).trim())) {
      return res.status(400).json({ message: 'Valid newEmail is required' });
    }
    if (!oldOtp || !newOtp) {
      return res.status(400).json({ message: 'Both oldOtp and newOtp are required' });
    }

    const brand = await Brand.findOne({ brandId });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });

    const oldEmail = toNormEmail(brand.email);
    const nextEmail = toNormEmail(newEmail);

    // 1) Check OTP for old email (role = Brand)
    const oldDoc = await VerifyEmail.findOne({
      email: oldEmail,
      role: 'Brand',
      otpCode: String(oldOtp).trim(),
      otpExpiresAt: { $gt: new Date() },
    });
    if (!oldDoc) {
      return res.status(400).json({ message: 'Invalid or expired OTP for old email' });
    }

    // 2) Check OTP for new email (role = Brand)
    const newDoc = await VerifyEmail.findOne({
      email: nextEmail,
      role: 'Brand',
      otpCode: String(newOtp).trim(),
      otpExpiresAt: { $gt: new Date() },
    });
    if (!newDoc) {
      return res.status(400).json({ message: 'Invalid or expired OTP for new email' });
    }

    // 3) Make sure no other brand owns that new email
    const taken = await Brand.findOne({
      email: exactEmailRegex(nextEmail),
      brandId: { $ne: brandId },
    });
    if (taken) return res.status(409).json({ message: 'Email already in use' });

    // 4) Update Brand email
    brand.email = nextEmail;
    await brand.save();

    // 5) Flip verification flags and clear OTPs (scoped to role='Brand')
    oldDoc.verified = false;
    oldDoc.verifiedAt = null;
    oldDoc.otpCode = undefined;
    oldDoc.otpExpiresAt = undefined;
    await oldDoc.save();

    newDoc.verified = true;
    newDoc.verifiedAt = new Date();
    newDoc.otpCode = undefined;
    newDoc.otpExpiresAt = undefined;
    await newDoc.save();

    // 6) Fresh JWT reflecting new email
    const token = jwt.sign(
      { brandId: brand.brandId, email: brand.email },
      JWT_SECRET,
      { expiresIn: '100d' }
    );

    return res
      .status(200)
      .json({ message: 'Email updated successfully', email: brand.email, token });
  } catch (err) {
    console.error('Error in verifyEmailUpdate:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
