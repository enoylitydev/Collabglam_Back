require('dotenv').config();
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Payment = require('../models/payment');
const Brand = require('../models/brand');  // Assuming Brand model exists
const Influencer = require('../models/influencer');  // Assuming Influencer model exists
const subscriptionHelper = require('../utils/subscriptionHelper');
const MilestonePayment = require('../models/milestonePayment');

// initialize Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createOrder = async (req, res) => {
  try {
    const { amount, currency = 'USD', receipt, userId, role, planId } = req.body;

    // Basic validations
    if (!userId || !role || !planId) {
      return res.status(400).json({ success: false, message: 'Missing required fields: userId, role, planId' });
    }
    if (!['Brand', 'Influencer'].includes(String(role))) {
      return res.status(400).json({ success: false, message: 'role must be "Brand" or "Influencer"' });
    }

    // Fetch user
    let user;
    if (role === 'Brand') {
      user = await Brand.findOne({ brandId: userId });
    } else {
      user = await Influencer.findOne({ influencerId: userId });
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check if this is a FREE plan selection (role-scoped)
    const isInfluencerFree = role === 'Influencer' && planId === "a58683f0-8d6e-41b0-addd-a718c2622142";
    const isBrandFree      = role === 'Brand'      && planId === "ca41f2c1-7fbd-4e22-b27c-d537ecbaf02a";

    // If planId matches the FREE plan for the given role → apply free plan directly
    if (isInfluencerFree || isBrandFree) {
      const freePlan = await subscriptionHelper.getFreePlan(role);
      if (!freePlan) {
        return res.status(500).json({ success: false, message: 'Free plan is not configured' });
      }

      // Assign free subscription
      const features = (freePlan.features || []).map(f => ({
        key: f.key,
        limit: typeof f.value === 'number' ? f.value : 0,
        used: 0
      }));

      const subPayload = {
        planId: freePlan.planId || planId, // keep provided planId as fallback
        planName: freePlan.name || 'free',
        startedAt: new Date(),
        expiresAt: subscriptionHelper.computeExpiry(freePlan),
        features
      };

      user.subscription = subPayload;
      user.subscriptionExpired = false;
      await user.save();

      // No Payment record, no Razorpay order — this is FREE
      return res.status(200).json({
        success: true,
        free: true,
        message: 'Free plan activated',
        subscription: subPayload
      });
    }

    // Not a FREE plan → do the normal paid order flow
    if (!amount) {
      return res.status(400).json({ success: false, message: 'amount is required for paid plans' });
    }

    const options = {
      amount: Math.round(Number(amount) * 100), // Razorpay expects minor units
      currency,
      receipt: receipt || crypto.randomBytes(10).toString('hex'),
    };

    const order = await razorpay.orders.create(options);

    await Payment.create({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      userId,   // UUID
      planId,   // requested plan
      role,     // Brand | Influencer
      status: 'created',
      createdAt: new Date()
    });

    return res.status(201).json({ success: true, order });
  } catch (error) {
    console.error('Error in createOrder:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Verify payment signature, update status, and auto-assign plan based on userId (brandId or influencerId)
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // validate signature
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                       .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                       .digest('hex');

    if (hmac !== razorpay_signature) {
      await Payment.findOneAndUpdate({ orderId: razorpay_order_id }, { status: 'failed' });
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // confirm capture
    const razorPayment = await razorpay.payments.fetch(razorpay_payment_id);
    if (razorPayment.status !== 'captured') {
      await Payment.findOneAndUpdate({ orderId: razorpay_order_id }, { status: razorPayment.status });
      return res.status(400).json({ success: false, message: `Payment status: ${razorPayment.status}` });
    }

    // update record as paid
    const paymentRecord = await Payment.findOneAndUpdate(
      { orderId: razorpay_order_id },
      {
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        status:    'paid',
        paidAt:    new Date()
      },
      { new: true }
    );

    res.json({ success: true, message: 'Payment verified successfully' });
  } catch (error) {
    console.error('Error in verifyPayment:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.createMilestoneOrder = async (req, res) => {
  try {
    const {
      amount,
      currency = 'USD',
      receipt,
      brandId,
      influencerId,
      campaignId,
      milestoneTitle,
    } = req.body;

    if (!amount || !brandId || !influencerId || !campaignId) {
      return res.status(400).json({
        success: false,
        message:
          'amount, brandId, influencerId and campaignId are required for milestone payments',
      });
    }

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res
        .status(400)
        .json({ success: false, message: 'amount must be a positive number' });
    }

    // Make sure both brand & influencer exist
    const [brand, influencer] = await Promise.all([
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId }),
    ]);

    if (!brand) {
      return res.status(404).json({ success: false, message: 'Brand not found' });
    }
    if (!influencer) {
      return res
        .status(404)
        .json({ success: false, message: 'Influencer not found' });
    }

    const options = {
      amount: Math.round(amountNum * 100), // Razorpay expects amount in paise
      currency,
      receipt: receipt || crypto.randomBytes(10).toString('hex'),
    };

    const order = await razorpay.orders.create(options);

    await MilestonePayment.create({
      orderId: order.id,
      amount: order.amount, // stored in minor units, consistent with Razorpay
      currency: order.currency,
      receipt: order.receipt,
      brandId,
      influencerId,
      campaignId,
      milestoneTitle,
      status: 'created',
      createdAt: new Date(),
    });

    return res.status(201).json({ success: true, order });
  } catch (error) {
    console.error('Error in createMilestoneOrder:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Verify milestone payment signature and mark MilestonePayment as paid
 * POST /payment/milestone-verify
 * body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
exports.verifyMilestonePayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message:
          'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required',
      });
    }

    // validate signature
    const hmac = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (hmac !== razorpay_signature) {
      await MilestonePayment.findOneAndUpdate(
        { orderId: razorpay_order_id },
        { status: 'failed' }
      );
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // confirm capture from Razorpay
    const razorPayment = await razorpay.payments.fetch(razorpay_payment_id);
    if (razorPayment.status !== 'captured') {
      await MilestonePayment.findOneAndUpdate(
        { orderId: razorpay_order_id },
        { status: razorPayment.status }
      );
      return res.status(400).json({
        success: false,
        message: `Payment status: ${razorPayment.status}`,
      });
    }

    const paymentRecord = await MilestonePayment.findOneAndUpdate(
      { orderId: razorpay_order_id },
      {
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        status: 'paid',
        paidAt: new Date(),
      },
      { new: true }
    );

    if (!paymentRecord) {
      // Should not happen if createMilestoneOrder ran correctly
      return res.status(404).json({
        success: false,
        message: 'Milestone payment record not found for this orderId',
      });
    }

    return res.json({
      success: true,
      message: 'Milestone payment verified successfully',
      payment: paymentRecord,
    });
  } catch (error) {
    console.error('Error in verifyMilestonePayment:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};