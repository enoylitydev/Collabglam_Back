require("dotenv").config();
const crypto = require("crypto");
const Stripe = require("stripe");

const Payment = require("../models/payment");
const Brand = require("../models/brand");
const Influencer = require("../models/influencer");
const subscriptionHelper = require("../utils/subscriptionHelper");
const MilestonePayment = require("../models/milestonePayment");

// ✅ ADD THIS (your subscription plan model)
const SubscriptionPlan = require("../models/subscription");

const { sendPaymentSuccessEmailWithInvoice,generateInvoicePdfBuffer } = require("../emails/paymentEmailController");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const clientUrl = (process.env.CAMPAIGN_BASE_URL || "https://collabglam.com").replace(/\/$/, "");
const brandSuccessPath = process.env.STRIPE_BRAND_SUCCESS_PATH || "/brand/subscriptions";
const influencerSuccessPath = process.env.STRIPE_INFLUENCER_SUCCESS_PATH || "/influencer/subscriptions";
const milestoneSuccessPath =
  process.env.STRIPE_MILESTONE_SUCCESS_PATH || "/brand/active-campaign/active-inf";

const roleToSuccessPath = (role) => (role === "Influencer" ? influencerSuccessPath : brandSuccessPath);

function safeRedirectUrl(url, fallbackAbsoluteUrl) {
  try {
    if (!url) return fallbackAbsoluteUrl;

    if (typeof url === "string" && url.startsWith("/")) {
      return `${clientUrl}${url}`;
    }

    const u = new URL(url);
    if (u.origin === clientUrl) return url;

    return fallbackAbsoluteUrl;
  } catch {
    return fallbackAbsoluteUrl;
  }
}

// ✅ helper to resolve plan name
async function resolvePlanName({ planId, role, planName, name }) {
  const direct = (planName || name || "").trim();
  if (direct) return direct;

  try {
    const plan = await SubscriptionPlan.findOne({ planId, role });
    return (plan?.displayName || plan?.name || "").trim();
  } catch {
    return "";
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

      // ✅ supports both keys
      planName,
      name,

      successUrl,
      cancelUrl,
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

    // ✅ Fix plan name mismatch here
    const finalPlanName = await resolvePlanName({ planId, role, planName, name });

    const receiptId = receipt || crypto.randomBytes(10).toString("hex");

    const defaultSuccess = `${clientUrl}${roleToSuccessPath(role)}?stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancel = `${clientUrl}${roleToSuccessPath(role)}?stripe_cancel=1`;

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
              description: `Plan: ${finalPlanName || "Subscription"}`, // ✅ no planId
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

        // ✅ keep both for compatibility
        planName: String(finalPlanName || ""),
        name: String(finalPlanName || ""),

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

      // ✅ store resolved plan name in DB
      planName: finalPlanName || "",

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

    const existing = await Payment.findOne({ orderId: sessionId });

    // idempotent
    if (existing?.status === "paid") {
      if (!existing.invoiceEmailSentAt) {
        try {
          await sendPaymentSuccessEmailWithInvoice({
            kind: "plan",
            role: existing.role,
            userId: existing.userId,
            currency: existing.currency,
            amountCents: existing.amount,
            paidAt: existing.paidAt || new Date(),
            planName: existing.planName,
            invoiceNumber: existing.invoiceNumber || undefined,
          });
          await Payment.findOneAndUpdate(
            { orderId: sessionId },
            { invoiceEmailSentAt: new Date() }
          );
        } catch (e) {
          console.error("Invoice email failed (already-paid):", e);
        }
      }

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

    // ✅ plan name from metadata (supports both)
    const metaPlanName = (session.metadata?.planName || session.metadata?.name || "").trim();

    // ✅ if still missing, try DB or fetch from SubscriptionPlan
    let finalPlanName = metaPlanName;
    if (!finalPlanName && existing?.planName) finalPlanName = existing.planName;

    if (!finalPlanName) {
      finalPlanName = await resolvePlanName({
        planId: session.metadata?.planId,
        role: session.metadata?.role,
        planName: "",
        name: "",
      });
    }

    const updated = await Payment.findOneAndUpdate(
      { orderId: sessionId },
      {
        paymentId: session.payment_intent || null,
        signature: null,
        status: "paid",
        paidAt: new Date(),

        role: session.metadata?.role,
        userId: session.metadata?.userId,
        planId: session.metadata?.planId,
        planName: finalPlanName || "",
      },
      { new: true }
    );

    // ✅ send email + invoice
    try {
      const r = await sendPaymentSuccessEmailWithInvoice({
        kind: "plan",
        role: updated.role,
        userId: updated.userId,
        currency: updated.currency,
        amountCents: updated.amount,
        paidAt: updated.paidAt,
        planName: updated.planName,
        invoiceNumber: updated.invoiceNumber || undefined,
      });

      await Payment.findOneAndUpdate(
        { orderId: sessionId },
        {
          invoiceNumber: r.invoiceNumber,
          invoiceFilePath: r.invoiceFilePath,
          invoiceEmailTo: r.recipientEmail,
          invoiceEmailSentAt: new Date(),
        },
        { new: true }
      );
    } catch (e) {
      console.error("Invoice email failed:", e);
    }

    return res.json({
      success: true,
      message: "Payment verified successfully",
      planId: updated.planId,
      planName: updated.planName,
      role: updated.role,
      userId: updated.userId,
    });
  } catch (error) {
    console.error("Error in verifyPayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


/**
 * Create Stripe Checkout Session for milestone payment
 * route: /payment/milestone-order
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
      campaignName,
      milestoneTitle,
      successUrl,
      cancelUrl,
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

    const basePath = (milestoneSuccessPath || "/brand/active-campaign/active-inf").startsWith("/")
      ? milestoneSuccessPath
      : `/${milestoneSuccessPath}`;

    const qs = `id=${encodeURIComponent(campaignId)}&name=${encodeURIComponent(campaignName || "")}`;

    const defaultSuccessUrl = `${clientUrl}${basePath}?${qs}&stripe_success=1&session_id={CHECKOUT_SESSION_ID}`;
    const defaultCancelUrl = `${clientUrl}${basePath}?${qs}&stripe_cancel=1`;

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
        campaignName: String(campaignName || ""),
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
      campaignName: campaignName || "",
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

    const existing = await MilestonePayment.findOne({ orderId: sessionId });

    // ✅ idempotent: if already paid, only send invoice if not sent
    if (existing?.status === "paid") {
      let emailAttempted = false;
      let emailSent = Boolean(existing.invoiceEmailSentAt);

      if (!emailSent) {
        try {
          emailAttempted = true;

          // milestone payer is brand
          const brand = await Brand.findOne({ brandId: existing.brandId });
          if (brand?.email) {
            const r = await sendPaymentSuccessEmailWithInvoice({
              kind: "milestone",
              toEmail: brand.email,
              toName: brand.name || brand.brandName || "Brand",
              currency: existing.currency,
              amountCents: existing.amount,
              paidAt: existing.paidAt || new Date(),
              campaignId: existing.campaignId,
              campaignName: existing.campaignName,
              milestoneTitle: existing.milestoneTitle,
              invoiceNumber: existing.invoiceNumber || undefined,
            });

            await MilestonePayment.findOneAndUpdate(
              { orderId: sessionId },
              {
                invoiceNumber: r.invoiceNumber,
                invoiceFilePath: r.invoiceFilePath,
                invoiceEmailTo: r.recipientEmail,
                invoiceEmailSentAt: new Date(),
              }
            );
            emailSent = true;
          }
        } catch (e) {
          console.error("Milestone invoice email failed (already-paid case):", e);
        }
      }

      return res.json({
        success: true,
        message: "Milestone payment already verified",
        payment: existing,
        metadata: {},
        invoiceEmail: { attempted: emailAttempted, sent: emailSent },
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
        // store metadata for invoice
        campaignId: session.metadata?.campaignId,
        campaignName: session.metadata?.campaignName,
        milestoneTitle: session.metadata?.milestoneTitle,
        brandId: session.metadata?.brandId,
        influencerId: session.metadata?.influencerId,
      },
      { new: true }
    );

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        message: "Milestone payment record not found for this sessionId",
      });
    }

    // ✅ Send invoice email to Brand (payer)
    let invoiceEmail = { attempted: false, sent: false };
    try {
      invoiceEmail.attempted = true;
      const brand = await Brand.findOne({ brandId: paymentRecord.brandId });
      if (brand?.email) {
        const r = await sendPaymentSuccessEmailWithInvoice({
          kind: "milestone",
          toEmail: brand.email,
          toName: brand.name || brand.brandName || "Brand",
          currency: paymentRecord.currency,
          amountCents: paymentRecord.amount,
          paidAt: paymentRecord.paidAt,
          campaignId: paymentRecord.campaignId,
          campaignName: paymentRecord.campaignName,
          milestoneTitle: paymentRecord.milestoneTitle,
          invoiceNumber: paymentRecord.invoiceNumber || undefined,
        });

        await MilestonePayment.findOneAndUpdate(
          { orderId: sessionId },
          {
            invoiceNumber: r.invoiceNumber,
            invoiceFilePath: r.invoiceFilePath,
            invoiceEmailTo: r.recipientEmail,
            invoiceEmailSentAt: new Date(),
          },
          { new: true }
        );

        invoiceEmail.sent = true;
      }
    } catch (e) {
      console.error("Milestone invoice email failed:", e);
    }

    return res.json({
      success: true,
      message: "Milestone payment verified successfully",
      payment: paymentRecord,
      metadata: session.metadata || {},
      invoiceEmail,
    });
  } catch (error) {
    console.error("Error in verifyMilestonePayment:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


exports.getInvoicesByUserId = async (req, res) => {
  try {
    const { userId, role } = req.body || {};

    if (!userId || !role) {
      return res.status(400).json({
        success: false,
        message: "userId and role are required",
      });
    }

    if (!["Brand", "Influencer"].includes(String(role))) {
      return res.status(400).json({
        success: false,
        message: 'role must be "Brand" or "Influencer"',
      });
    }

    // 1) Plan invoices (Payment)
    const planInvoices = await Payment.find({
      userId: String(userId),
      role: String(role),
      status: "paid",
      invoiceNumber: { $exists: true, $ne: "" },
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .select(
        "orderId paymentId amount currency receipt userId role planName status createdAt paidAt invoiceNumber invoiceFilePath invoiceEmailTo invoiceEmailSentAt"
      )
      .lean();

    // 2) Milestone invoices (payer is Brand only)
    let milestoneInvoices = [];
    if (String(role) === "Brand") {
      milestoneInvoices = await MilestonePayment.find({
        brandId: String(userId),
        status: "paid",
        invoiceNumber: { $exists: true, $ne: "" },
      })
        .sort({ paidAt: -1, createdAt: -1 })
        .select(
          "orderId paymentId amount currency receipt brandId influencerId campaignId campaignName milestoneTitle status createdAt paidAt invoiceNumber invoiceFilePath invoiceEmailTo invoiceEmailSentAt"
        )
        .lean();
    }

    return res.json({
      success: true,
      userId,
      role,
      invoices: {
        plans: planInvoices,
        milestones: milestoneInvoices,
      },
      counts: {
        plans: planInvoices.length,
        milestones: milestoneInvoices.length,
        total: planInvoices.length + milestoneInvoices.length,
      },
    });
  } catch (err) {
    console.error("getInvoicesByUserId error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};


/**
 * ✅ Preview invoice PDF by invoiceNumber (INLINE only)
 * route: POST /payment/invoices/preview
 * body: { invoiceNumber }
 */
exports.previewInvoiceByInvoiceNumber = async (req, res) => {
  try {
    const { invoiceNumber } = req.body || {};

    if (!invoiceNumber) {
      return res.status(400).json({
        success: false,
        message: "invoiceNumber is required",
      });
    }

    // 1) find record in Payment first
    let record = await Payment.findOne({ invoiceNumber: String(invoiceNumber) }).lean();
    let kind = "plan";

    // 2) else in MilestonePayment
    if (!record) {
      record = await MilestonePayment.findOne({ invoiceNumber: String(invoiceNumber) }).lean();
      kind = "milestone";
    }

    if (!record) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    // 3) resolve "Bill to"
    const issuedAtStr = new Date(record.paidAt || record.createdAt || Date.now()).toDateString();

    const fromName = process.env.INVOICE_FROM_NAME || "CollabGlam";
    const fromEmail = process.env.INVOICE_FROM_EMAIL || "billing@collabglam.io";
    const fromSite = process.env.INVOICE_FROM_WEBSITE || "https://collabglam.com";
    const fromBlock = `${fromName}\n${fromEmail}\n${fromSite}`;

    let toName = "Customer";
    let toEmail = record.invoiceEmailTo || "";

    if (kind === "plan") {
      if (record.role === "Brand") {
        const b = await Brand.findOne({ brandId: record.userId }).lean();
        if (b) {
          toName = b.name || b.brandName || "Brand";
          toEmail = b.email || toEmail;
        }
      } else {
        const i = await Influencer.findOne({ influencerId: record.userId }).lean();
        if (i) {
          toName = i.name || i.influencerName || "Influencer";
          toEmail = i.email || toEmail;
        }
      }
    } else {
      const b = await Brand.findOne({ brandId: record.brandId }).lean();
      if (b) {
        toName = b.name || b.brandName || "Brand";
        toEmail = b.email || toEmail;
      }
    }

    const toBlock = `${toName}\n${toEmail || ""}`;

    // 4) invoice items
    const items =
      kind === "milestone"
        ? [
            {
              description: `Milestone Payment - ${record.milestoneTitle || "Milestone"}\nCampaign: ${
                record.campaignName || ""
              } (${record.campaignId || ""})`,
              qty: 1,
              unitPriceCents: Number(record.amount),
              amountCents: Number(record.amount),
            },
          ]
        : [
            {
              description: `CollabGlam - ${record.role} Subscription\nPlan: ${record.planName || "—"}`,
              qty: 1,
              unitPriceCents: Number(record.amount),
              amountCents: Number(record.amount),
            },
          ];

    const subtotalCents = Number(record.amount);
    const totalCents = Number(record.amount);

    const footerNote =
      kind === "milestone"
        ? "Milestone invoice (generated by invoiceNumber)."
        : "Subscription invoice (generated by invoiceNumber).";

    // 5) generate pdf buffer
    const pdf = await generateInvoicePdfBuffer({
      invoiceNumber: record.invoiceNumber,
      issuedAt: issuedAtStr,
      fromBlock,
      toBlock,
      currency: record.currency || "USD",
      items,
      subtotalCents,
      totalCents,
      footerNote,
    });

    // ✅ INLINE ONLY
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pdf.filename}"`);

    return res.status(200).send(pdf.buffer);
  } catch (err) {
    console.error("previewInvoiceByInvoiceNumber error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
