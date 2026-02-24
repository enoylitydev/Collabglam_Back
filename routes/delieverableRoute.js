// routes/delieverable.routes.js
const express = require("express");
const router = express.Router();

const {
  createDeliverableApproval,
  updateDeliverableApprovalStatus,
  listDeliverablesByCampaign,
  listInfluencerDeliverablesByCampaign
} = require("../controllers/delieverableController");

// 1) POST - create (always pending)
router.post("/create", createDeliverableApproval);

// 2) PATCH - approve/changes
router.patch("/:delieverableApprovalId/status", updateDeliverableApprovalStatus);

// 3) GET - list campaign-wise
router.get("/campaign/:campaignId", listDeliverablesByCampaign);
router.get("/influencer/:influencerId", listInfluencerDeliverablesByCampaign);

module.exports = router;