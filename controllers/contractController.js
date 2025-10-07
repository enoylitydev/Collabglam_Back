const PDFDocument = require('pdfkit');
const Contract = require('../models/contract');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const ApplyCampaign = require('../models/applyCampaign');
const Invitation = require('../models/invitation');
const Milestone = require('../models/milestone');

const toStr = v => (v == null ? '' : String(v));

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    {
      'milestoneHistory.influencerId': influencerId,
      'milestoneHistory.campaignId': { $in: campaignIds }
    },
    'milestoneHistory.campaignId milestoneHistory.influencerId'
  ).lean();

  const set = new Set();
  docs.forEach(d => {
    d.milestoneHistory.forEach(e => {
      if (toStr(e.influencerId) === toStr(influencerId) &&
        campaignIds.includes(toStr(e.campaignId))) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

/* ============================================================
   SEND or GENERATE CONTRACT
   POST /contract/send-or-generate
============================================================ */
exports.sendOrGenerateContract = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      effectiveDate,
      brandName,
      brandAddress,
      influencerName,
      influencerAddress,
      influencerHandle,
      feeAmount,
      paymentTerms,
      type // 0 = PDF, 1 = save
    } = req.body;

    if (![0, 1].includes(+type)) {
      return res.status(400).json({ message: 'Invalid type; must be 0 or 1' });
    }
    if (!brandId || !influencerId || !campaignId ||
      !effectiveDate || !brandName || !brandAddress ||
      !influencerName || !influencerAddress || !influencerHandle ||
      !feeAmount || !paymentTerms) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const [campaign, brand, influencer] = await Promise.all([
      Campaign.findOne({ campaignsId: campaignId }),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId })
    ]);
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });
    if (!influencer) return res.status(404).json({ message: 'Influencer not found' });

    const contractData = {
      brandId,
      influencerId,
      campaignId,
      effectiveDate,
      brandName,
      brandAddress,
      influencerName,
      influencerAddress,
      influencerHandle,
      deliverableDescription: paymentTerms,
      feeAmount,
      timeline: {
        startDate: campaign.timeline?.startDate,
        endDate: campaign.timeline?.endDate
      },
      type,
      isAssigned: 1,
      lastSentAt: new Date()
    };

    // TYPE 0 => PDF stream only
    if (+type === 0) {
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=Contract.pdf');
      doc.pipe(res);

      const logoSize = 50;
      if (brand.logoUrl) {
        try { doc.image(brand.logoUrl, doc.page.margins.left, doc.page.margins.top, { width: logoSize }); }
        catch (err) { console.warn('Brand logo failed:', err.message); }
      }
      if (influencer.logoUrl) {
        try {
          const x = doc.page.width - doc.page.margins.right - logoSize;
          doc.image(influencer.logoUrl, x, doc.page.margins.top, { width: logoSize });
        } catch (err) { console.warn('Influencer logo failed:', err.message); }
      }
      doc.moveDown(4);

      doc.fontSize(20).text('Influencer Marketing Contract', { align: 'center' }).moveDown();
      doc.fontSize(14).text('Contract Details', { underline: true });
      doc.fontSize(12)
        .text(`Effective Date: ${effectiveDate}`)
        .text(`Start Date: ${new Date(contractData.timeline.startDate).toDateString()}`)
        .text(`End Date:   ${new Date(contractData.timeline.endDate).toDateString()}`)
        .moveDown();

      doc.fontSize(14).text('Parties Involved', { underline: true });
      doc.fontSize(12)
        .text(`Brand:      ${brandName}`)
        .text(`Address:    ${brandAddress}`)
        .moveDown()
        .text(`Influencer: ${influencerName}`)
        .text(`Address:    ${influencerAddress}`)
        .text(`Handle:     ${influencerHandle}`)
        .moveDown();

      doc.fontSize(14).text('Deliverables', { underline: true });
      doc.fontSize(12).text(paymentTerms).moveDown();

      doc.fontSize(14).text('Compensation', { underline: true });
      doc.fontSize(12).text(`Fee: $${feeAmount}`).moveDown();

      doc.fontSize(14).text('Signatures', { underline: true }).moveDown(2);
      doc.text('_________________________\nBrand Representative').moveDown(2);
      doc.text('_________________________\nInfluencer');

      doc.end();
      return;
    }

    // Save to DB
    const newContract = new Contract(contractData);
    await newContract.save();

    // Mark approved in ApplyCampaign
    let appRec = await ApplyCampaign.findOne({ campaignId });
    if (!appRec) {
      appRec = new ApplyCampaign({
        campaignId,
        applicants: [],
        approved: [{ influencerId, name: influencerName }]
      });
    } else {
      appRec.approved = [{ influencerId, name: influencerName }];
    }
    await appRec.save();

    // Update invitation
    await Invitation.findOneAndUpdate(
      { campaignId, influencerId },
      { isContracted: 1 },
      { new: true }
    );

    return res.status(201).json({
      message: 'Contract created and saved successfully',
      contract: newContract
    });

  } catch (err) {
    console.error('Error in sendOrGenerateContract:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ============================================================
   GET contracts for Brand+Influencer
============================================================ */
exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId } = req.body;
    if (!brandId || !influencerId) {
      return res.status(400).json({ message: 'brandId and influencerId are required' });
    }
    const contracts = await Contract.find({ brandId, influencerId });
    if (!contracts.length) {
      return res.status(404).json({ message: 'No contracts found for that Brand & Influencer' });
    }
    res.status(200).json({ contracts });
  } catch (err) {
    console.error('Error fetching contracts:', err);
    res.status(500).json({ error: err.message });
  }
};

/* ============================================================
   VIEW Contract PDF
============================================================ */
exports.viewContractPdf = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const [campaign, brand, influencer] = await Promise.all([
      Campaign.findOne({ campaignsId: contract.campaignId }),
      Brand.findOne({ brandId: contract.brandId }),
      Influencer.findOne({ influencerId: contract.influencerId })
    ]);
    if (!campaign?.timeline || !brand || !influencer) {
      return res.status(404).json({ message: 'Related data missing' });
    }

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Contract-${contractId}.pdf`);
    doc.pipe(res);

    const logoSize = 50;
    if (brand.logoUrl) {
      try { doc.image(brand.logoUrl, doc.page.margins.left, doc.page.margins.top, { width: logoSize }); }
      catch (err) { console.warn('Brand logo failed to load:', err.message); }
    }
    if (influencer.logoUrl) {
      try {
        const x = doc.page.width - doc.page.margins.right - logoSize;
        doc.image(influencer.logoUrl, x, doc.page.margins.top, { width: logoSize });
      } catch (err) { console.warn('Influencer logo failed to load:', err.message); }
    }
    doc.moveDown(4);

    doc.fontSize(20).text('INFLUENCER COLLABORATION AGREEMENT', { align: 'center' }).moveDown();

    doc.fontSize(12)
      .text(`This Agreement is made on ${contract.effectiveDate} between:\n`)
      .text(`1. Brand:      ${contract.brandName}`)
      .text(`   Address:    ${contract.brandAddress}`)
      .moveDown()
      .text(`2. Influencer: ${contract.influencerName}`)
      .text(`   Address:    ${contract.influencerAddress}`)
      .text(`   Handle:     ${contract.influencerHandle}`)
      .moveDown()
      .text(`3. Scope of Work\n${contract.deliverableDescription}`)
      .moveDown()
      .text(`4. Compensation\nBrand agrees to pay Influencer $${contract.feeAmount}.`)
      .moveDown()
      .text(
        `5. Term\nFrom ${new Date(campaign.timeline.startDate).toDateString()} to ${new Date(campaign.timeline.endDate).toDateString()}.`
      )
      .moveDown()
      .text('6. Signatures\n')
      .moveDown()
      .text('_____________________________\nBrand Representative')
      .moveDown()
      .text('_____________________________\nInfluencer');

    doc.end();
  } catch (err) {
    console.error('Error generating contract PDF:', err);
    res.status(500).json({ error: err.message });
  }
};

/* ============================================================
   ACCEPT Contract
============================================================ */
exports.acceptContract = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) {
      return res.status(400).json({ message: 'contractId is required' });
    }

    // 1) Load the contract
    const contract = await Contract.findOne({ contractId });
    if (!contract) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    // 2) Apply acceptance
    contract.isAccepted = 1;
    contract.isRejected = 0;
    contract.rejectedReason = '';
    contract.rejectedAt = undefined;

    // 3) Save
    await contract.save();

    return res
      .status(200)
      .json({ message: 'Contract approved successfully', contract });
  } catch (err) {
    console.error('Error approving contract:', err);
    return res.status(500).json({ error: err.message });
  }
};

/* ============================================================
   REJECT Contract
============================================================ */
exports.rejectContract = async (req, res) => {
  try {
    const { contractId, influencerId, reason = '' } = req.body;
    if (!contractId || !influencerId) {
      return res.status(400).json({ message: 'contractId and influencerId are required' });
    }

    const contract = await Contract.findOne({ contractId, influencerId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    if (contract.isAccepted === 1) return res.status(400).json({ message: 'Contract already accepted' });
    if (contract.isRejected === 1) return res.status(400).json({ message: 'Contract already rejected' });

    // ensure no milestone yet
    const msSet = await milestoneSetForInfluencer(contract.influencerId, [toStr(contract.campaignId)]);
    if (msSet.has(toStr(contract.campaignId))) {
      return res.status(400).json({ message: 'Milestone already exists, cannot reject now' });
    }

    contract.isRejected = 1;
    contract.rejectedReason = reason;
    contract.rejectedAt = new Date();
    await contract.save();

    // Optional: mark in ApplyCampaign
    await ApplyCampaign.updateOne(
      { campaignId: contract.campaignId, 'applicants.influencerId': influencerId },
      { $set: { 'applicants.$.isRejected': 1 } }
    ).catch(() => { });

    return res.status(200).json({ message: 'Contract rejected successfully', contract });
  } catch (err) {
    console.error('rejectContract error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ============================================================
   RESEND Contract (Brand)
============================================================ */
exports.resendContract = async (req, res) => {
  try {
    const { contractId, brandId, updates = {} } = req.body;
    if (!contractId || !brandId) {
      return res.status(400).json({ message: 'contractId and brandId are required' });
    }

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.isAccepted === 1) {
      return res.status(400).json({ message: 'Contract already accepted, cannot resend' });
    }

    // Whitelist updates
    const ALLOWED = ['feeAmount', 'deliverableDescription', 'effectiveDate', 'timeline'];
    ALLOWED.forEach(k => {
      if (updates[k] !== undefined) contract[k] = updates[k];
    });

    // Reset reject flags
    contract.isRejected = 0;
    contract.rejectedReason = '';
    contract.rejectedAt = undefined;

    contract.isAssigned = 1;
    contract.lastSentAt = new Date();
    contract.resendCount = (contract.resendCount || 0) + 1;

    await contract.save();

    return res.status(200).json({ message: 'Contract resent successfully', contract });
  } catch (err) {
    console.error('resendContract error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ============================================================
   Brand list of rejected contracts
============================================================ */
exports.getRejectedContractsByBrand = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10 } = req.body;
    if (!brandId) return res.status(400).json({ message: 'brandId is required' });

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const filter = {
      brandId,
      isRejected: 1,
      isAccepted: { $ne: 1 } // don’t show if later accepted
    };

    const [total, contracts] = await Promise.all([
      Contract.countDocuments(filter),
      Contract.find(filter)
        .sort({ rejectedAt: -1 })
        .skip(skip)
        .limit(limNum)
        .lean()
    ]);

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      contracts
    });
  } catch (err) {
    console.error('getRejectedContractsByBrand error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/* ============================================================
   Influencer list of rejected contracts (+ campaign details)
============================================================ */
exports.getRejectedContractsByInfluencer = async (req, res) => {
  try {
    const { influencerId, page = 1, limit = 10, search = '' } = req.body;
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    // 1) Grab ALL contracts for this influencer (we'll filter after grouping)
    const baseMatch = { influencerId };
    if (search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term, 'i');
      baseMatch.$or = [
        { brandName: regex },
        { campaignId: regex },
        { deliverableDescription: regex },
        { feeAmount: regex }
      ];
    }

    // Sort newest first so $first in group is the latest
    const grouped = await Contract.aggregate([
      { $match: baseMatch },
      { $sort: { lastSentAt: -1, createdAt: -1 } },
      {
        $group: {
          _id: '$campaignId',
          doc: { $first: '$$ROOT' }
        }
      },
      // Only keep ones whose LATEST doc is rejected (and not accepted)
      { $match: { 'doc.isRejected': 1, 'doc.isAccepted': { $ne: 1 } } },
      // You can project here if you want to trim fields
    ]);

    if (!grouped.length) {
      return res.json({
        meta: { total: 0, page: pageNum, limit: limNum, totalPages: 0 },
        contracts: []
      });
    }

    // 2) Fetch related campaigns
    const campaignIds = grouped.map(g => g._id);
    const campaigns = await Campaign.find({ campaignsId: { $in: campaignIds } })
      .populate('interestId', 'name')
      .lean();

    const campaignMap = new Map(campaigns.map(c => [c.campaignsId, c]));

    // 3) Build output array
    const merged = grouped.map(g => ({
      ...g.doc,
      campaign: campaignMap.get(g._id) || null
    }));

    // 4) Pagination AFTER grouping/filtering
    const total = merged.length;
    const paged = merged.slice(skip, skip + limNum);

    return res.json({
      meta: {
        total,
        page: pageNum,
        limit: limNum,
        totalPages: Math.ceil(total / limNum)
      },
      contracts: paged
    });

  } catch (err) {
    console.error('getRejectedContractsByInfluencer error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};