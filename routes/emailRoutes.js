const express = require('express');
const router = express.Router();
const { sendInvitation } = require('../emails/signupInvitationController');
const { sendWelcomeEmail } = require('../emails/wellcomeEmailController');

router.post('/send-welcome', sendWelcomeEmail);
router.post('/invitation', sendInvitation);
module.exports = router;