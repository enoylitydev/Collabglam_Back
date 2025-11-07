// jobs/unseenMessageNotifier.js
require('dotenv').config();
const nodemailer = require('nodemailer');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const ChatRoom = require('../models/chat');

// Email configuration
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLatestMessageTeaser(message) {
  if (!message) {
    return null;
  }

  if (typeof message.text === 'string') {
    const trimmed = message.text.trim();
    if (trimmed) {
      return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
    }
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attachment = message.attachments[0];
    if (attachment?.originalName) {
      return `Attachment: ${attachment.originalName}`;
    }
    if (attachment?.mimeType) {
      return `Attachment: ${attachment.mimeType}`;
    }
    return 'Attachment: New file';
  }

  return null;
}

// Helper function to get user details
async function getUserDetails(userId, userType) {
  const projection = 'email name isUnsubscribed';

  if (userType === 'brand') {
    return await Brand.findOne({
      brandId: userId,
      isUnsubscribed: { $ne: true },
    }).select(projection);
  }

  if (userType === 'influencer') {
    return await Influencer.findOne({
      influencerId: userId,
      isUnsubscribed: { $ne: true },
    }).select(projection);
  }

  return null;
}

// Helper function to send email
async function sendUnseenMessageNotification(email, userName, unseenCount, roomId, teaserText) {
  try {
    const sanitizedTeaser = teaserText ? escapeHtml(teaserText) : null;
    const teaserSection = sanitizedTeaser
      ? `
          <div style="margin: 20px 0; padding: 12px 16px; background-color: #f7f7f7; border-left: 4px solid #FF6B6B;">
            <p style="margin: 0; color: #333; font-weight: bold;">Latest message preview</p>
            <p style="margin: 8px 0 0; color: #555;">${sanitizedTeaser}</p>
          </div>
        `
      : '';

    const mailOptions = {
      from: `"Collabglam Notifications" <${SMTP_USER}>`,
      to: email,
      subject: 'You have unread messages on Collabglam',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Hello ${userName},</h2>
          <p>You have ${unseenCount} unread message${unseenCount > 1 ? 's' : ''} in your chat room.</p>
          ${teaserSection}
          <p>Please log in to your Collabglam account to view your messages.</p>
          <div style="margin: 20px 0;">
            <a href="${process.env.FRONTEND_URL}/messages?room=${roomId}" 
               style="background-color: #FF6B6B; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              View Messages
            </a>
          </div>
          <p style="color: #666; font-size: 12px;">
            This is an automated message. Please do not reply to this email.
          </p>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            If you no longer wish to receive these emails, you can <a href="${process.env.FRONTEND_URL}/unsubscribe?email=${email}" style="color: #FF6B6B;">unsubscribe here</a>.
          </p>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    // console.log(`✅ Email sent to ${email}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, error.message);
    return false;
  }
}


// Main notification function
async function checkAndNotifyUnseenMessages() {
  try {
    const rooms = await ChatRoom.find();
    const ONE_HOUR = 60 * 60 * 1000;

    for (const room of rooms) {
      for (const participant of room.participants) {
        const unseenMessages = room.messages.filter(msg =>
          msg.senderId !== participant.userId &&
          Array.isArray(msg.seenBy) &&
          !msg.seenBy.includes(participant.userId)
        );

        const unseenCount = unseenMessages.length;

        if (unseenCount > 0) {
          const latestUnseenMessage = unseenMessages[unseenMessages.length - 1];
          const messageTeaser = buildLatestMessageTeaser(latestUnseenMessage);
          // Check if we recently sent a notification
          const lastNotification = room.lastNotificationSent?.get(participant.userId);
          const now = new Date();

          // if (lastNotification && (now - new Date(lastNotification)) < ONE_HOUR) {
          //   console.log(`⏭️  Skipping notification for ${participant.userId} (sent recently)`);
          //   continue;
          // }

          const user = await getUserDetails(participant.userId, participant.role);
          if (user && user.email) {
            const sent = await sendUnseenMessageNotification(
              user.email,
              user.name || 'User',
              unseenCount,
              room.roomId,
              messageTeaser
            );

            if (sent) {
              // Update last notification timestamp
              if (!room.lastNotificationSent) {
                room.lastNotificationSent = new Map();
              }
              room.lastNotificationSent.set(participant.userId, now);
              await room.save();
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in checkAndNotifyUnseenMessages:', error);
  }
}


// Job scheduler
let notificationInterval;

module.exports = {
  start: () => {
    // Run immediately on start
    checkAndNotifyUnseenMessages();

    // Then schedule to run every 6 hours
    const SIX_HOURS = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
    notificationInterval = setInterval(checkAndNotifyUnseenMessages, SIX_HOURS);
    console.log('Unseen message notifier started - Running every 6 hours');
  },

  stop: () => {
    if (notificationInterval) {
      clearInterval(notificationInterval);
      console.log('Unseen message notifier stopped');
    }
  }
};
