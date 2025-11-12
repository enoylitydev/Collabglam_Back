// emails/invitationController.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * POST /invitation/invitation
 * body: { 
 *   email: string, 
 *   influencerName?: string, 
 *   brandName?: string, 
 *   inviteCode?: string,
 *   budgetAmount?: string,
 *   brandContactName?: string
 * }
 */
exports.sendInvitation = async (req, res) => {
  const { 
    email, 
    influencerName = 'creator', 
    brandName = 'CollabGlam', 
    inviteCode,
    budgetAmount = '[Budget Amount]',
    brandContactName = 'The Team'
  } = req.body;
  
  if (!email) return res.status(400).json({ message: 'Email required' });

  try {
    const signupUrl = `https://collabglam.com/signup${inviteCode ? `?code=${inviteCode}` : ''}`;

    await transporter.sendMail({
      from: `"${brandName}" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `A brand wants to collaborate with you on CollabGlam ✨`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto;">
          <p>Hi <strong>${influencerName}</strong>,</p>
          
          <p>I hope you're doing well. I'm reaching out on behalf of <strong>${brandName}</strong>, and we've been following your content closely. We believe your style and audience align perfectly with our upcoming campaign.</p>
          
          <p>We're excited to invite you to collaborate with us on a paid project with a campaign budget of <strong>₹${budgetAmount}</strong>.</p>
          
          <p>To keep things smooth, transparent, and secure for both of us, we handle all collaborations through <strong>CollabGlam</strong>, a trusted platform for brand–influencer partnerships.</p>
          
          <h3 style="color: #ff7236; margin-top: 24px;">✅ Why you should join this campaign</h3>
          <ul style="margin: 12px 0; padding-left: 20px;">
            <li>Paid collaboration with a clear Scope of Work</li>
            <li>Secure milestone payments</li>
            <li>Easy contract + approval workflow</li>
            <li>No negotiation confusion — everything tracked in one place</li>
          </ul>
          
          <p style="margin-top: 24px;">To move ahead, please create your account on CollabGlam using the link below:</p>
          
          <p style="margin: 24px 0;">
            <a href="${signupUrl}" style="background: linear-gradient(to right, #FFA135, #FF7236); color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
              👉 Create your account
            </a>
          </p>
          
          <p style="font-size: 13px; color: #666;">If the button doesn't work, copy and paste this link: <a href="${signupUrl}" style="color: #ff7236;">${signupUrl}</a></p>
          
          <p style="margin-top: 24px;">Once you register, you'll see the campaign invitation directly in your dashboard.</p>
          
          <p>We would love to work with you and believe this could be a great match. If you have any questions, feel free to reply — happy to help.</p>
          
          <p style="margin-top: 24px;">Looking forward to your response.</p>
          
          <p style="margin-top: 32px;">
            Warm regards,<br/>
            <strong>${brandContactName}</strong><br/>
            ${brandName}
          </p>
        </div>
      `,
      text: `
Hi ${influencerName},

I hope you're doing well. I'm reaching out on behalf of ${brandName}, and we've been following your content closely. We believe your style and audience align perfectly with our upcoming campaign.

We're excited to invite you to collaborate with us on a paid project with a campaign budget of ₹${budgetAmount}.

To keep things smooth, transparent, and secure for both of us, we handle all collaborations through CollabGlam, a trusted platform for brand–influencer partnerships.

✅ Why you should join this campaign
- Paid collaboration with a clear Scope of Work
- Secure milestone payments
- Easy contract + approval workflow
- No negotiation confusion — everything tracked in one place

To move ahead, please create your account on CollabGlam using the link below:

👉 Create your account: ${signupUrl}

Once you register, you'll see the campaign invitation directly in your dashboard.

We would love to work with you and believe this could be a great match.
If you have any questions, feel free to reply — happy to help.

Looking forward to your response.

Warm regards,
${brandContactName}
${brandName}
      `,
    });

    res.json({ message: 'Invitation sent successfully' });
  } catch (err) {
    console.error('Invitation email failed:', err);
    res.status(500).json({ message: 'Unable to send invitation' });
  }
};