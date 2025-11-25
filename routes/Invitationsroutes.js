// routes/invitationRoutes.js
const express = require('express');
const router = express.Router();
const {
  createInvitation,
  updateInvitationStatus,
  listInvitations,
  getInvitationList,
} = require('../controllers/NewInvitationsController');

router.post('/create', createInvitation);
router.post('/update', updateInvitationStatus);
router.post('/list', listInvitations);
router.post('/getList', getInvitationList);


module.exports = router;
