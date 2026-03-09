const { Policy } = require('../models/policy');

/**
 * Create policy
 * POST /api/policy/create
 * Body: { policyKey, title, fileName, effectiveDate, content, isPublished? }
 */
exports.createPolicy = async (req, res) => {
  try {
    const {
      policyKey,
      title,
      fileName,
      effectiveDate,
      content,
      isPublished
    } = req.body;

    const existing = await Policy.findOne({ policyKey });
    if (existing) {
      return res.status(400).json({ error: 'Policy already exists for this policyKey' });
    }

    const policy = new Policy({
      policyKey,
      title,
      fileName,
      effectiveDate,
      content,
      isPublished
    });

    await policy.save();
    return res.status(201).json(policy);
  } catch (err) {
    console.error('createPolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update policy
 * POST /api/policy/update
 * Body: { policyKey, title?, fileName?, effectiveDate?, content?, isPublished? }
 */
exports.updatePolicy = async (req, res) => {
  try {
    const {
      policyKey,
      title,
      fileName,
      effectiveDate,
      content,
      isPublished
    } = req.body;

    const update = {
      updatedDate: new Date()
    };

    if (title !== undefined) update.title = title;
    if (fileName !== undefined) update.fileName = fileName;
    if (effectiveDate !== undefined) update.effectiveDate = effectiveDate;
    if (content !== undefined) update.content = content;
    if (isPublished !== undefined) update.isPublished = isPublished;

    const policy = await Policy.findOneAndUpdate(
      { policyKey },
      { $set: update },
      { new: true }
    );

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    return res.json(policy);
  } catch (err) {
    console.error('updatePolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Delete policy
 * POST /api/policy/delete
 * Body: { policyKey }
 */
exports.deletePolicy = async (req, res) => {
  try {
    const { policyKey } = req.body;

    const result = await Policy.findOneAndDelete({ policyKey });
    if (!result) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    return res.json({ message: 'Policy deleted successfully' });
  } catch (err) {
    console.error('deletePolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get single policy
 * POST /api/policy/get
 * Body: { policyKey }
 */
exports.getPolicy = async (req, res) => {
  try {
    const { policyKey } = req.body;

    const policy = await Policy.findOne({ policyKey });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    return res.json(policy);
  } catch (err) {
    console.error('getPolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all policies
 * GET /api/policy/all
 */
exports.getAllPolicies = async (req, res) => {
  try {
    const policies = await Policy.find({}).sort({ createdAt: 1 });
    return res.json(policies);
  } catch (err) {
    console.error('getAllPolicies error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};