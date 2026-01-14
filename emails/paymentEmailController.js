// emails/paymentEmailController.js
require("dotenv").config();
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const Brand = require("../models/brand");
const Influencer = require("../models/influencer");

// ✅ transporter (exactly as you asked)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ------------ config defaults ------------
const INVOICE_FROM_NAME = process.env.INVOICE_FROM_NAME || "CollabGlam";
const INVOICE_FROM_EMAIL = process.env.INVOICE_FROM_EMAIL || "billing@collabglam.io";
const INVOICE_FROM_WEBSITE = process.env.INVOICE_FROM_WEBSITE || "https://collabglam.com";

// ✅ logo path (you asked: assets/logo.png)
const INVOICE_LOGO_PATH =
  process.env.INVOICE_LOGO_PATH || path.join(process.cwd(), "assets", "logo.png");

// store invoice pdfs locally
const INVOICE_DIR = process.env.INVOICE_DIR || path.join(process.cwd(), "invoices");

// ------------ helpers ------------
function formatMoneyFromCents(amountCents, currency = "USD") {
  const upper = String(currency).toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: upper }).format(
      (Number(amountCents || 0) / 100) || 0
    );
  } catch {
    return `${(Number(amountCents || 0) / 100).toFixed(2)} ${upper}`;
  }
}

function safeText(v) {
  return String(v ?? "").trim();
}

async function getUserByRoleAndId(role, userId) {
  const r = String(role);
  if (r === "Brand") return Brand.findOne({ brandId: userId });
  if (r === "Influencer") return Influencer.findOne({ influencerId: userId });
  return null;
}

function pickDisplayName(user, role, userId) {
  return (
    user?.name ||
    user?.fullName ||
    user?.brandName ||
    user?.companyName ||
    user?.influencerName ||
    user?.username ||
    `${role} (${userId})`
  );
}

function makeInvoiceNumber(prefix = "CG") {
  const a = crypto.randomBytes(4).toString("hex").toUpperCase();
  const b = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-${a}-${b}`;
}

async function ensureInvoiceDir() {
  if (!fs.existsSync(INVOICE_DIR)) fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

async function pdfToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// ✅ line helper (DO NOT put column vars here)
function drawLine(doc, y, color = "#E6E6E6") {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  doc.save();
  doc.strokeColor(color).lineWidth(1);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  doc.restore();
}

// ✅ header with fixed logo size + never overflow
function drawHeader(doc, { invoiceNumber, issuedAt }) {
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const right = doc.page.margins.right;

  // Header background
  doc.save();
  doc.rect(0, 0, pageW, 120).fill("#F7F7FB");
  doc.restore();

  // Accent line
  doc.save();
  doc.rect(0, 118, pageW, 2).fill("#F4C542");
  doc.restore();

  // Title
  doc.font("Helvetica-Bold").fontSize(26).fillColor("#111");
  doc.text("Invoice", left, 45);

  // Meta block (kept away from logo)
  const metaWidth = 240;
  const logoBox = 64;
  const gap = 14;
  const metaX = pageW - right - logoBox - gap - metaWidth;

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(
    `Invoice number: ${invoiceNumber}\nDate of issue: ${issuedAt}`,
    metaX,
    52,
    { width: metaWidth, align: "right" }
  );

  // Logo container (top-right)
  const logoX = pageW - right - logoBox;
  const logoY = 34;

  doc.save();
  doc.roundedRect(logoX - 6, logoY - 6, logoBox + 12, logoBox + 12, 10)
    .fill("#FFFFFF")
    .strokeColor("#E6E6E6")
    .stroke();
  doc.restore();

  try {
    if (fs.existsSync(INVOICE_LOGO_PATH)) {
      // ✅ fit-based render keeps it clean
      doc.image(INVOICE_LOGO_PATH, logoX, logoY, {
        fit: [logoBox, logoBox],
        align: "center",
        valign: "center",
      });
    } else {
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#111");
      doc.text("CG", logoX, logoY + 20, { width: logoBox, align: "center" });
    }
  } catch {
    // ignore logo errors
  }

  // Move cursor below header
  doc.y = 140;
}

/**
 * ✅ Invoice PDF (attractive layout)
 * ✅ Logo fixed size + non-overflow
 * ✅ NO due date
 * ✅ NO amount due
 * ✅ Shows plan name (not planId)
 */
function invoicePdfDocument({
  invoiceNumber,
  issuedAt,
  fromBlock,
  toBlock,
  currency,
  items,
  subtotalCents,
  totalCents,
  footerNote,
}) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });

  // Header
  drawHeader(doc, { invoiceNumber, issuedAt });

  const left = doc.page.margins.left;
  const rightX = doc.page.width - doc.page.margins.right;

  // ✅ column layout with spacing between Unit price and Amount
  const descX = left + 10;
  const descW = 280;

  const qtyW = 45;
  const unitW = 95;
  const amountW = 95;

  const rightPad = 10;
  const colGap = 18; // 👈 THIS is the spacing between unit and amount

  const amountX = rightX - rightPad - amountW;
  const unitX = amountX - colGap - unitW;
  const qtyX = unitX - 18 - qtyW;

  // --- From / Bill To cards ---
  const cardY = doc.y;
  const cardH = 84;
  const cardW = 245;
  const gap = 15;

  // From card
  doc.save();
  doc.roundedRect(left, cardY, cardW, cardH, 10).fill("#FFFFFF").strokeColor("#E6E6E6").stroke();
  doc.restore();

  // Bill to card
  doc.save();
  doc.roundedRect(left + cardW + gap, cardY, cardW, cardH, 10)
    .fill("#FFFFFF")
    .strokeColor("#E6E6E6")
    .stroke();
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111");
  doc.text("From", left + 14, cardY + 12);
  doc.text("Bill to", left + cardW + gap + 14, cardY + 12);

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text(fromBlock, left + 14, cardY + 30, { width: cardW - 28 });
  doc.text(toBlock, left + cardW + gap + 14, cardY + 30, { width: cardW - 28 });

  doc.y = cardY + cardH + 18;

  // Currency note
  doc.font("Helvetica").fontSize(9).fillColor("#666");
  doc.text(`All prices are in ${String(currency).toUpperCase()}`, left, doc.y, {
    width: rightX - left,
    align: "center",
  });
  doc.moveDown(1);

  // --- Table header background ---
  const tableTopY = doc.y;
  doc.save();
  doc.roundedRect(left, tableTopY, rightX - left, 26, 8).fill("#F3F4F6");
  doc.restore();

  // ✅ table header text (ONLY header text here — NO "it" usage)
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111");
  doc.text("Description", descX, tableTopY + 7, { width: descW });
  doc.text("Qty", qtyX, tableTopY + 7, { width: qtyW, align: "right" });
  doc.text("Unit price", unitX, tableTopY + 7, { width: unitW, align: "right" });
  doc.text("Amount", amountX, tableTopY + 7, { width: amountW, align: "right" });

  doc.y = tableTopY + 36;
  drawLine(doc, doc.y);
  doc.moveDown(0.6);

  // --- Rows ---
  items.forEach((it) => {
    const rowStartY = doc.y;

    // description formatting (main bold + sub gray)
    const lines = String(it.description || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const main = lines[0] || "";
    const sub = lines.slice(1).join("\n");

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111");
    doc.text(main, descX, rowStartY, { width: descW });

    let descHeight = doc.heightOfString(main, { width: descW });

    if (sub) {
      doc.font("Helvetica").fontSize(9).fillColor("#666");
      doc.text(sub, descX, rowStartY + descHeight + 2, { width: descW });
      descHeight += doc.heightOfString(sub, { width: descW }) + 2;
    }

    // ✅ numeric columns
    doc.font("Helvetica").fontSize(10).fillColor("#111");
    doc.text(String(it.qty ?? 1), qtyX, rowStartY, { width: qtyW, align: "right" });

    doc.text(formatMoneyFromCents(it.unitPriceCents, currency), unitX, rowStartY, {
      width: unitW,
      align: "right",
    });

    doc.text(formatMoneyFromCents(it.amountCents, currency), amountX, rowStartY, {
      width: amountW,
      align: "right",
    });

    // row separator
    doc.y = rowStartY + Math.max(descHeight, 18) + 12;
    drawLine(doc, doc.y, "#EFEFEF");
    doc.moveDown(0.6);
  });

  // --- Totals box (right) ---
  const totalsY = doc.y + 6;
  const boxW = 220;
  const boxX = rightX - boxW;

  doc.save();
  doc.roundedRect(boxX, totalsY, boxW, 70, 10).fill("#FFFFFF").strokeColor("#E6E6E6").stroke();
  doc.restore();

  doc.font("Helvetica").fontSize(10).fillColor("#333");
  doc.text("Subtotal", boxX + 14, totalsY + 16);
  doc.text(formatMoneyFromCents(subtotalCents, currency), boxX, totalsY + 16, {
    width: boxW - 14,
    align: "right",
  });

  doc.font("Helvetica-Bold").fillColor("#111");
  doc.text("Total", boxX + 14, totalsY + 40);
  doc.text(formatMoneyFromCents(totalCents, currency), boxX, totalsY + 40, {
    width: boxW - 14,
    align: "right",
  });

  doc.y = totalsY + 92;

  // Footer note
  doc.font("Helvetica").fontSize(9).fillColor("#777");
  doc.text(footerNote || "", left, doc.y, { width: rightX - left, align: "right" });

  doc.fillColor("#000000");
  return doc;
}

async function generateInvoicePdfFile(data) {
  await ensureInvoiceDir();

  const invoiceNumber = data.invoiceNumber || makeInvoiceNumber("CG");
  const filename = `${invoiceNumber}.pdf`;
  const filePath = path.join(INVOICE_DIR, filename);

  const doc = invoicePdfDocument({ ...data, invoiceNumber });
  const buffer = await pdfToBuffer(doc);

  fs.writeFileSync(filePath, buffer);

  return { invoiceNumber, filename, filePath, buffer };
}

/**
 * ✅ HTML email template (no planId, shows planName)
 */
function buildSuccessEmailHtml({
  name,
  role,
  kind,
  planName,
  milestoneTitle,
  campaignName,
  campaignId,
  amountCents,
  currency,
  invoiceNumber,
  paidAt,
}) {
  const line1 =
    kind === "milestone"
      ? `Your milestone payment was successful.`
      : `Your subscription payment was successful.`;

  const details = [];

  if (kind === "plan") {
    details.push(`<li><b>Role:</b> ${safeText(role)}</li>`);
    details.push(`<li><b>Plan:</b> ${safeText(planName) || "—"}</li>`);
  } else {
    details.push(`<li><b>Campaign:</b> ${safeText(campaignName || "") || "—"}</li>`);
    details.push(`<li><b>Campaign ID:</b> ${safeText(campaignId || "") || "—"}</li>`);
    details.push(`<li><b>Milestone:</b> ${safeText(milestoneTitle || "") || "—"}</li>`);
  }

  details.push(`<li><b>Amount:</b> ${formatMoneyFromCents(amountCents, currency)}</li>`);
  details.push(`<li><b>Invoice:</b> ${safeText(invoiceNumber)}</li>`);
  details.push(`<li><b>Paid at:</b> ${new Date(paidAt).toLocaleString()}</li>`);

  return `
  <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">
    <h2 style="margin: 0 0 12px 0;">Payment Successful ✅</h2>
    <p>Hi ${safeText(name)},</p>
    <p style="margin-top: 0;">${line1} Your invoice PDF is attached to this email.</p>

    <div style="background:#f6f6f6; padding: 12px 14px; border-radius: 10px;">
      <h3 style="margin:0 0 8px 0; font-size: 14px;">Payment Details</h3>
      <ul style="margin:0; padding-left: 18px;">
        ${details.join("\n")}
      </ul>
    </div>

    <p style="margin-top: 14px;">
      Manage your account here:
      <a href="${INVOICE_FROM_WEBSITE}" target="_blank">${INVOICE_FROM_WEBSITE}</a>
    </p>

    <p style="margin-top: 18px;">Thanks,<br/><b>${INVOICE_FROM_NAME} Billing</b></p>
  </div>
  `;
}

/**
 * ✅ Send payment success email + attach invoice
 * kind: "plan" | "milestone"
 */
exports.sendPaymentSuccessEmailWithInvoice = async ({
  kind,
  role,
  userId,

  // milestone optional
  toEmail,
  toName,

  currency = "USD",
  amountCents,
  paidAt,

  // plan
  planName,

  // milestone
  campaignId,
  campaignName,
  milestoneTitle,

  invoiceNumber,
}) => {
  // 1) find recipient
  let recipientEmail = safeText(toEmail);
  let recipientName = safeText(toName);

  if (!recipientEmail) {
    const user = await getUserByRoleAndId(role, userId);
    if (!user?.email) throw new Error("Recipient user email not found");
    recipientEmail = user.email;
    recipientName = pickDisplayName(user, role, userId);
  }

  // 2) invoice meta
  const issueDate = new Date(paidAt || Date.now());
  const issuedAtStr = issueDate.toDateString();

  const fromBlock = `${INVOICE_FROM_NAME}\n${INVOICE_FROM_EMAIL}\n${INVOICE_FROM_WEBSITE}`;
  const toBlock = `${recipientName}\n${recipientEmail}`;

  // ✅ Invoice item description: includes Plan Name, NO planId
  const items = [
    kind === "milestone"
      ? {
          description: `Milestone Payment - ${safeText(milestoneTitle) || "Milestone"}\nCampaign: ${
            safeText(campaignName) || ""
          } (${safeText(campaignId)})`,
          qty: 1,
          unitPriceCents: Number(amountCents),
          amountCents: Number(amountCents),
        }
      : {
          description: `CollabGlam - ${safeText(role)} Subscription\nPlan: ${safeText(planName) || "—"}`,
          qty: 1,
          unitPriceCents: Number(amountCents),
          amountCents: Number(amountCents),
        },
  ];

  const subtotalCents = Number(amountCents);
  const totalCents = Number(amountCents);

  const footerNote =
    "This is a system-generated invoice for your records. If you have questions, reply to this email.";

  // 3) generate invoice pdf
  const pdfResult = await generateInvoicePdfFile({
    invoiceNumber,
    issuedAt: issuedAtStr,
    fromBlock,
    toBlock,
    currency,
    items,
    subtotalCents,
    totalCents,
    footerNote,
  });

  // 4) send email
  const subject =
    kind === "milestone"
      ? `CollabGlam Invoice ${pdfResult.invoiceNumber} (Milestone Payment)`
      : `CollabGlam Invoice ${pdfResult.invoiceNumber} (Subscription Payment)`;

  const html = buildSuccessEmailHtml({
    name: recipientName,
    role,
    kind,
    planName,
    milestoneTitle,
    campaignName,
    campaignId,
    amountCents,
    currency,
    invoiceNumber: pdfResult.invoiceNumber,
    paidAt: issueDate,
  });

  const mail = await transporter.sendMail({
    from: `${INVOICE_FROM_NAME} <${INVOICE_FROM_EMAIL}>`,
    to: recipientEmail,
    subject,
    html,
    attachments: [
      {
        filename: pdfResult.filename,
        content: pdfResult.buffer,
        contentType: "application/pdf",
      },
    ],
  });

  return {
    ok: true,
    messageId: mail.messageId,
    invoiceNumber: pdfResult.invoiceNumber,
    invoiceFilePath: pdfResult.filePath,
    invoiceFilename: pdfResult.filename,
    recipientEmail,
  };
};

// ✅ buffer-only generator (for preview APIs)
exports.generateInvoicePdfBuffer = async ({
  invoiceNumber,
  issuedAt,
  fromBlock,
  toBlock,
  currency,
  items,
  subtotalCents,
  totalCents,
  footerNote,
}) => {
  const finalInvoiceNumber = invoiceNumber || makeInvoiceNumber("CG");

  const doc = invoicePdfDocument({
    invoiceNumber: finalInvoiceNumber,
    issuedAt,
    fromBlock,
    toBlock,
    currency,
    items,
    subtotalCents,
    totalCents,
    footerNote,
  });

  const buffer = await pdfToBuffer(doc);

  return {
    invoiceNumber: finalInvoiceNumber,
    buffer,
    filename: `${finalInvoiceNumber}.pdf`,
  };
};
