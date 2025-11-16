// utils/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // true if using 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendMail({ to, subject, text, html }) {
  if (!to) throw new Error('Recipient email (to) is required');

  await transporter.sendMail({
    from: process.env.MAIL_FROM || '"CollabGlam" <no-reply@yourdomain.com>',
    to,
    subject,
    text,
    html
  });
}

module.exports = { sendMail };
