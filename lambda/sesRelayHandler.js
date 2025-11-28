// lambda/sesRelayHandler.js
// This file is intended to be used as an AWS Lambda handler for SES inbound emails.

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { simpleParser } = require('mailparser');
const AWS = require('aws-sdk');
const mongoose = require('mongoose');

const { EmailThread, EmailMessage } = require('../models/email');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');

const REGION = process.env.AWS_REGION || 'us-east-1';

// ---------- Configure AWS SDK v2 (S3) with keys if present ----------
const awsBaseConfig = { region: REGION };
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  awsBaseConfig.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  awsBaseConfig.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
}
AWS.config.update(awsBaseConfig);

// ---------- SES client (SDK v3) ----------
const ses = new SESClient({
  region: REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const s3 = new AWS.S3();

// connect to Mongo once
let isDbConnected = false;
async function connectDb() {
  if (isDbConnected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isDbConnected = true;
}

/**
 * Local helper to send outbound mail from Lambda (similar to sendViaSES in API).
 */
async function sendViaSES({
  fromAlias,
  fromName,
  toRealEmail,
  subject,
  htmlBody,
  textBody,
  replyTo,
}) {
  const params = {
    Source: `${fromName} <${fromAlias}>`,
    Destination: { ToAddresses: [toRealEmail] },
    Message: {
      Subject: { Charset: 'UTF-8', Data: subject },
      Body: {},
    },
  };

  if (replyTo) {
    params.ReplyToAddresses = [replyTo];
  }

  if (htmlBody) {
    params.Message.Body.Html = { Charset: 'UTF-8', Data: htmlBody };
  }
  if (textBody) {
    params.Message.Body.Text = { Charset: 'UTF-8', Data: textBody };
  }

  const cmd = new SendEmailCommand(params);
  return ses.send(cmd);
}

/**
 * Lambda handler triggered by SES -> S3 rule.
 * Event includes S3 bucket/key with raw email.
 */
exports.handler = async (event) => {
  try {
    await connectDb();

    // 1) Get S3 bucket and object key from SES event
    const record = event.Records?.[0];
    if (!record) {
      console.log('No SNS/S3 record in event');
      return;
    }

    const message = JSON.parse(record.Sns.Message);
    const receipt = message?.receipt;
    const mail = message?.mail;

    if (!receipt || !mail) {
      console.log('Missing SES receipt/mail in event');
      return;
    }

    const bucket = process.env.SES_EMAIL_BUCKET || receipt.action?.bucketName;
    const objectKey = receipt.action?.objectKey;

    if (!bucket || !objectKey) {
      console.error('Missing S3 bucket or objectKey for SES email');
      return;
    }

    // 2) Read raw email from S3
    const rawEmailObj = await s3
      .getObject({ Bucket: bucket, Key: objectKey })
      .promise();
    const rawEmail = rawEmailObj.Body.toString('utf-8');

    // 3) Parse using mailparser
    const parsed = await simpleParser(rawEmail);

    const toAddresses = []
      .concat(parsed.to?.value || [])
      .concat(parsed.cc?.value || []);

    // Find collabglam recipient (relay)
    const relayAddrObj = toAddresses.find(
      (a) =>
        a.address &&
        a.address.toLowerCase().endsWith(`@${process.env.EMAIL_RELAY_DOMAIN}`)
    );

    if (!relayAddrObj) {
      console.log('No collabglam recipient address found; skipping.');
      return;
    }

    const relayEmail = relayAddrObj.address.toLowerCase();
    const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase();

    console.log('Relay email:', relayEmail, 'From:', fromEmail);

    // 4) Find thread by relay email
    const thread = await EmailThread.findOne({
      brandAliasEmail: relayEmail,
    })
      .populate('brand')
      .populate('influencer');

    if (!thread) {
      console.log('No EmailThread found for relay email:', relayEmail);
      return;
    }

    const brand = thread.brand;
    const influencer = thread.influencer;

    if (!brand || !influencer) {
      console.log('Thread missing brand or influencer refs');
      return;
    }

    // 5) Decide direction: Brand -> Influencer or Influencer -> Brand
    let direction;
    let toRealEmail;
    let fromAliasEmail;
    let fromName;
    let fromUser;
    let fromUserModel;

    if (fromEmail === (brand.email || '').toLowerCase()) {
      // Brand replied from their Gmail
      direction = 'brand_to_influencer';
      toRealEmail = influencer.email;
      fromAliasEmail =
        thread.brandDisplayAlias || thread.brandAliasEmail;
      fromName = `${brand.name} via ${
        process.env.PLATFORM_NAME || 'CollabGlam'
      }`;
      fromUser = brand._id;
      fromUserModel = 'Brand';
    } else {
      // Treat as influencer (any other address)
      direction = 'influencer_to_brand';
      toRealEmail = brand.email;
      fromAliasEmail = thread.influencerAliasEmail; // influencer@collabglam.com
      fromName = `${thread.influencerSnapshot.name} via ${
        process.env.PLATFORM_NAME || 'CollabGlam'
      }`;
      fromUser = influencer._id;
      fromUserModel = 'Influencer';
    }

    const subject = parsed.subject || '(no subject)';
    const textBody = parsed.text || '';
    const htmlBody =
      parsed.html || `<pre>${parsed.textAsHtml || ''}</pre>`;

    // 6) Save message in DB
    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction,
      fromUser,
      fromUserModel,
      fromAliasEmail,
      toRealEmail,
      subject,
      htmlBody,
      textBody,
      template: null,
    });

    console.log('Created EmailMessage', messageDoc._id.toString());

    // 7) Forward sanitized email to real recipient via SES, keeping same relay
    await sendViaSES({
      fromAlias: fromAliasEmail,
      fromName,
      toRealEmail,
      subject,
      htmlBody,
      textBody,
      replyTo: thread.brandAliasEmail, // keep same relay
    });

    console.log('Forwarded email to real recipient');
  } catch (err) {
    console.error('Error in SES relay handler:', err);
    throw err;
  }
};
