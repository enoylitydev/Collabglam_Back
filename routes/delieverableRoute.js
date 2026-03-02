// routes/delieverable.routes.js
const express = require("express");
const router = express.Router();

const {
  createDeliverableApproval,
  updateDeliverableApprovalStatus,
  listDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign2,
  getAllDeliverables,
  listBrandShortlistedCampaigns,
  updateDeliverableRevision,
} = require("../controllers/delieverableController");

// 1) POST - create (always pending)
router.post("/create", createDeliverableApproval);

// 2) PATCH - approve/changes
router.patch("/:delieverableApprovalId/status", updateDeliverableApprovalStatus);

// 3) GET - list campaign-wise
router.get("/campaign/:campaignId", listDeliverablesByCampaign);
router.get("/influencer/:influencerId", listInfluencerDeliverablesByCampaign);
router.get("/influencer/campaign/:campaignId", listInfluencerDeliverablesByCampaign2);
router.get("/getall", getAllDeliverables);
router.get(
  "/brand/:brandId/campaigns/shortlisted",
  listBrandShortlistedCampaigns
);

router.post("/updateRevision", updateDeliverableRevision);

module.exports = router;