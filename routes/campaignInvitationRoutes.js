// routes/campaignInvitationRoutes.js
const express = require("express");
const router = express.Router();

const campaignInvitationController = require("../controllers/campaignInvitationController");

router.post("/send", campaignInvitationController.storeInvitation);
router.get("/list",campaignInvitationController.getInvitationsList)

module.exports = router;