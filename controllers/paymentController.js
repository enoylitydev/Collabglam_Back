require("dotenv").config();
const crypto = require("crypto");
const Stripe = require("stripe");

const Payment = require("../models/payment");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const subscriptionHelper = require("../utils/subscriptionHelper");
const MilestonePayment = require("../models/milestonePayment");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const clientUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
const brandSuccessPath = process.env.STRIPE_BRAND_SUCCESS_PATH || "/brand/subscriptions";
const influencerSuccessPath = process.env.STRIPE_INFLUENCER_SUCCESS_PATH || "/influencer/subscriptions";
const milestoneSuccessPath =
  process.env.STRIPE_MILESTONE_SUCCESS_PATH || "/brand/active-campaign/active-inf";

const roleToSuccessPath = (role) => (role === "Influencer" ? influencerSuccessPath : brandSuccessPath);

/**
 * ✅ Protect against open-redirect:
 * - allow relative paths: "/brand/...."
 * - OR allow absolute URLs ONLY if they start with CLIENT_URL
 */
function safeRedirectUrl(url, fallbackAbsoluteUrl) {
  try {
    if (!url) return fallbackAbsoluteUrl;

    // relative path => join with clientUrl
    if (typeof url === "string" && url.startsWith("/")) {
      return `${clientUrl}${url}`;
    }

    // absolute URL => allow only same origin as clientUrl
    const u = new URL(url);
    if (u.origin === clientUrl) return url;

    // anything else => fallback
    return fallbackAbsoluteUrl;
  } catch {
    return fallbackAbsoluteUrl;
  }
}

/**
 * Create Stripe Checkout Session for plan purchase
 * route: /payment/Order
 */
exports.createOrder = async (req, res) => {
  try {
    const {
      amount,
      currency = "USD",
      receipt,
      userId,
      role,
      planId,
      planName,          // ✅ optional
      successUrl,        // ✅ optional (frontend can send)
      cancelUrl,         // ✅ optional (frontend can send)
    } = req.body;

    if (!userId || !role || !planId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: userId, role, planId",
      });
    }
    if (!["Brand", "Influencer"].includes(String(role))) {
      return res.status(400).json({
        success: false,
        message: 'role must be "Brand" or "Influencer"',
      });
    }

    // Fetch user
    let user;
    if (role === "Brand") user = await Brand.findOne({ brandId: userId });
    else user = await Influencer.findOne({ influencerId: userId });

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // FREE plan logic (unchanged)
    const isInfluencerFree = role === "Influencer" && planId === "a58683f0-8d6e-41b0-addd-a718c2622142";
    const isBrandFree = role === "Brand" && planId === "ca41f2c1-7fbd-4e22-b27c-d537ecbaf02a";

    if (isInfluencerFree || isBrandFree) {
      const freePlan = await subscriptionHelper.getFreePlan(role);
      if (!freePlan) {
        return res.status(500).json({ success: false, message: "Free plan is not configured" });
      }

      const features = (freePlan.features || []).map((f) => ({
        key: f.key,
        limit: typeof f.value === "number" ? f.value : 0,
        used: 0,
      }));

      const subPayload = {
        planId: freePlan.planId || planId,
        planName: freePlan.name || "free",
        startedAt: new Date(),
        expiresAt: subscriptionHelper.computeExpiry(freePlan),
        features,
      };

      user.subscription = subPayload;
      user.subscriptionExpired = false;
      await user.save();

      return res.status(200).json({
        success: true,
        free: true,
        message: "Free plan activated",
        subscription: subPayload,
      });
    }

    // Paid plan requires amount
    const amountNum = Number(amount);
    if (!amountNum || isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "amount is required for paid plans" });
    }

    const receiptId = receipt || crypto.randomBytes(10).toString("hex");

    const defaultSuccess = `${clientUrl}${roleToSuccessPath(role)}?stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancel = `${clientUrl}${roleToSuccessPath(role)}?stripe_cancel=1`;

    // ✅ Use safe redirect URLs (frontend can override)
    const finalSuccessUrl = safeRedirectUrl(successUrl, defaultSuccess);
    const finalCancelUrl = safeRedirectUrl(cancelUrl, defaultCancel);

    const stripeCurrency = String(currency).toLowerCase();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `CollabGlam - ${role} Plan`,
              description: `PlanId: ${planId}`,
            },
            unit_amount: Math.round(amountNum * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        kind: "plan",
        userId: String(userId),
        role: String(role),
        planId: String(planId),
        planName: String(planName || ""), // ✅ helpful for frontend
        receipt: String(receiptId),
      },
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
    });

    await Payment.create({
      orderId: session.id,
      amount: Math.round(amountNum * 100),
      currency: stripeCurrency.toUpperCase(),
      receipt: receiptId,
      userId,
      planId,
      role,
      status: "created",
      createdAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Error in createOrder:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Verify Stripe Checkout Session and mark payment paid
 * route: /payment/verify
 * body: { sessionId }
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: "sessionId is required" });
    }

    // ✅ idempotent: if already paid in DB, return success
    const existing = await Payment.findOne({ orderId: sessionId });
    if (existing?.status === "paid") {
      return res.json({
        success: true,
        message: "Payment already verified",
        planId: existing.planId || null,
        role: existing.role || null,
        userId: existing.userId || null,
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      await Payment.findOneAndUpdate({ orderId: sessionId }, { status: "failed" });
      return res.status(400).json({
        success: false,
        message: `Payment not completed (status: ${session?.payment_status || "unknown"})`,
      });
    }

    await Payment.findOneAndUpdate(
      { orderId: sessionId },
      {
        paymentId: session.payment_intent || null,
        signature: null,
        status: "paid",
        paidAt: new Date(),
      },
      { new: true }
    );

    return res.json({
      success: true,
      message: "Payment verified successfully",
      planId: session.metadata?.planId,
      planName: session.metadata?.planName,
      role: session.metadata?.role,
      userId: session.metadata?.userId,
    });
  } catch (error) {
    console.error("Error in verifyPayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Create Stripe Checkout Session for milestone payment
 * route: /payment/milestone-order
 * ✅ accepts successUrl/cancelUrl from frontend
 */
exports.createMilestoneOrder = async (req, res) => {
  try {
    const {
      amount,
      currency = "USD",
      receipt,
      brandId,
      influencerId,
      campaignId,
      campaignName,       // ✅ NEW (optional)
      milestoneTitle,
      successUrl,         // ✅ optional override from frontend
      cancelUrl,          // ✅ optional override from frontend
    } = req.body;

    if (!amount || !brandId || !influencerId || !campaignId) {
      return res.status(400).json({
        success: false,
        message: "amount, brandId, influencerId and campaignId are required for milestone payments",
      });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, message: "amount must be a positive number" });
    }

    const [brand, influencer] = await Promise.all([
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId }),
    ]);

    if (!brand) return res.status(404).json({ success: false, message: "Brand not found" });
    if (!influencer) return res.status(404).json({ success: false, message: "Influencer not found" });

    const receiptId = receipt || crypto.randomBytes(10).toString("hex");
    const stripeCurrency = String(currency).toLowerCase();

    // ✅ fallback base path (NO query in env)
    const basePath = (milestoneSuccessPath || "/brand/active-campaign/active-inf").startsWith("/")
      ? milestoneSuccessPath
      : `/${milestoneSuccessPath}`;

    // ✅ dynamic query
    const qs = `id=${encodeURIComponent(campaignId)}&name=${encodeURIComponent(campaignName || "")}`;

    const defaultSuccessUrl =
      `${clientUrl}${basePath}?${qs}&stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancelUrl =
      `${clientUrl}${basePath}?${qs}&stripe_cancel=1`;

    // ✅ allow frontend override, else fallback
    const finalSuccessUrl = safeRedirectUrl(successUrl, defaultSuccessUrl);
    const finalCancelUrl = safeRedirectUrl(cancelUrl, defaultCancelUrl);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: brand.email,
      line_items: [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: `Milestone Payment`,
              description: `${milestoneTitle || "Milestone"} (Campaign: ${campaignId})`,
            },
            unit_amount: Math.round(amountNum * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        kind: "milestone",
        receipt: String(receiptId),
        brandId: String(brandId),
        influencerId: String(influencerId),
        campaignId: String(campaignId),
        campaignName: String(campaignName || ""), // ✅ save it too
        milestoneTitle: String(milestoneTitle || ""),
      },
      success_url: finalSuccessUrl,
      cancel_url: finalCancelUrl,
    });

    await MilestonePayment.create({
      orderId: session.id,
      amount: Math.round(amountNum * 100),
      currency: stripeCurrency.toUpperCase(),
      receipt: receiptId,
      brandId,
      influencerId,
      campaignId,
      milestoneTitle,
      status: "created",
      createdAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Error in createMilestoneOrder:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Verify milestone Stripe Checkout Session and mark MilestonePayment as paid
 * route: /payment/milestone-verify
 * body: { sessionId }
 */
exports.verifyMilestonePayment = async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "sessionId is required",
      });
    }

    // ✅ idempotent: if already paid in DB, return success
    const existing = await MilestonePayment.findOne({ orderId: sessionId });
    if (existing?.status === "paid") {
      return res.json({
        success: true,
        message: "Milestone payment already verified",
        payment: existing,
        metadata: {},
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      await MilestonePayment.findOneAndUpdate({ orderId: sessionId }, { status: "failed" });
      return res.status(400).json({
        success: false,
        message: `Payment not completed (status: ${session?.payment_status || "unknown"})`,
      });
    }

    const paymentRecord = await MilestonePayment.findOneAndUpdate(
      { orderId: sessionId },
      {
        paymentId: session.payment_intent || null,
        signature: null,
        status: "paid",
        paidAt: new Date(),
      },
      { new: true }
    );

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        message: "Milestone payment record not found for this sessionId",
      });
    }

    return res.json({
      success: true,
      message: "Milestone payment verified successfully",
      payment: paymentRecord,
      metadata: session.metadata || {},
    });
  } catch (error) {
    console.error("Error in verifyMilestonePayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
