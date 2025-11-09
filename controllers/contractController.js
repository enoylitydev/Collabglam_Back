// controllers/contractsController.js
// CollabGlam — Contracts Controller (rewritten, cleaned + resend support + notifications)
// - Adds "resend" support via:
//     a) POST /contract/initiate with { isResend: true, resendOf: "<contractId>" }
//     b) POST /contract/resend with { contractId, brandUpdates? }
// - Adds in-website notifications for initiate, edits, confirms/accepts, sign, fully-locked, and reject
// - IMPORTANT CHANGE: Brand edits are allowed **only before any confirmations** (brand or influencer).

const PDFDocument = require('pdfkit');
const moment = require('moment-timezone');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const Contract = require('../models/contract');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const MASTER_TEMPLATE = require('../template/ContractTemplate');
const { createAndEmit } = require('../utils/notifier'); // ← notifications

const TIMEZONES_FILE = path.join(__dirname, '..', 'data', 'timezones.json');
const CURRENCIES_FILE = path.join(__dirname, '..', 'data', 'currencies.json');

// ----------------------------- Helpers -----------------------------
function respondOK(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}
function respondError(res, message = 'Internal server error', status = 500, err = null) {
  if (err) console.error(message, err); else console.error(message);
  return res.status(status).json({ success: false, message });
}

const tzOr = (c, fallback = 'America/Los_Angeles') =>
  c?.admin?.timezone || c?.requestedEffectiveDateTimezone || c?.effectiveDateTimezone || fallback;

function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTimezones() {
  try { return JSON.parse(fs.readFileSync(TIMEZONES_FILE, 'utf8')); }
  catch (e) { console.warn('Failed to load timezones.json', e); return []; }
}
function loadCurrencies() {
  try { return JSON.parse(fs.readFileSync(CURRENCIES_FILE, 'utf8')); }
  catch (e) { console.warn('Failed to load currencies.json', e); return {}; }
}

function findTimezoneByValueOrUTC(key) {
  if (!key) return null;
  const list = loadTimezones();
  const q = String(key).toLowerCase();
  return (
    list.find((t) =>
      (t.value && t.value.toLowerCase() === q) ||
      (t.abbr && t.abbr.toLowerCase() === q) ||
      (t.utc && t.utc.some((u) => u.toLowerCase() === q)) ||
      (t.text && t.text.toLowerCase().includes(q))
    ) || null
  );
}

function legalTextToHTML(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = []; let buffer = [];
  let consumedTitle = false; let inSchedules = false; let afterBOpen = false;

  const flushP = () => {
    if (!buffer.length) return;
    const html = esc(buffer.join('\n')).replace(/\n/g, '<br>');
    out.push(`<p>${html}</p>`);
    buffer = [];
  };
  const openAfterB = () => { if (!afterBOpen) { out.push('<div class="afterB">'); afterBOpen = true; } };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flushP(); continue; }

    if (!consumedTitle && /Agreement/i.test(line) && line.length > 30) {
      flushP(); out.push(`<h1>${esc(line)}</h1>`); consumedTitle = true; continue;
    }

    const sch = line.match(/^Schedule\s+([A-Z])\s+–\s+(.+)$/);
    if (sch) {
      flushP();
      const letter = sch[1];
      inSchedules = true;
      if (letter >= 'C') openAfterB();
      out.push(`<h3>Schedule ${esc(letter)} – ${esc(sch[2])}</h3>`);
      continue;
    }

    if (/^Signatures$/i.test(line)) {
      flushP(); out.push('<h2>Signatures</h2>'); out.push('<div id="__SIG_PANEL__"></div>'); continue;
    }

    const sec = line.match(/^(\d+)\.\s+(.+)$/);
    if (sec && !inSchedules) { flushP(); out.push(`<h2><span class="secno">${esc(sec[1])}.</span> ${esc(sec[2])}</h2>`); continue; }
    if (sec && inSchedules) { flushP(); out.push(`<p className="numli"><span class="marker">${esc(sec[1])}.</span> ${esc(sec[2])}</p>`); continue; }

    const letm = line.match(/^([a-z])\.\s+(.+)$/i);
    if (letm) { flushP(); out.push(`<p class="subli"><span class="marker">${esc(letm[1])}.</span> ${esc(letm[2])}</p>`); continue; }

    const bul = line.match(/^[-•]\s+(.+)$/);
    if (bul) { flushP(); out.push(`<p class="bull"><span class="marker">•</span> ${esc(bul[1])}</p>`); continue; }

    buffer.push(rawLine);
  }

  flushP();
  if (!consumedTitle) out.unshift('<h1>Master Brand–Influencer Agreement</h1>');
  if (afterBOpen) out.push('</div>');
  return out.join('\n');
}

function formatDateTZ(date, tz, fmt = 'MMMM D, YYYY') { return moment(date).tz(tz).format(fmt); }

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);
  const roles = [
    { key: 'brand', label: `Brand: ${esc(contract.other?.brandProfile?.legalName || contract.brandName || '—')}` },
    { key: 'influencer', label: `Influencer: ${esc(contract.other?.influencerProfile?.legalName || contract.influencerName || '—')}` },
    { key: 'collabglam', label: 'CollabGlam: CollabGlam, Inc.' }
  ];
  const blocks = roles.map(({ key, label }) => {
    const s = contract.signatures?.[key] || {};
    const when = s.at ? formatDateTZ(s.at, tz, 'YYYY-MM-DD HH:mm z') : '';
    const img = s.sigImageDataUrl ? `<img class="sigimg" alt="Signature image" src="${esc(s.sigImageDataUrl)}">` : '';
    const meta = s.signed
      ? `<div class="sigmeta">SIGNED by ${esc(s.name || '')}${s.email ? ` &lt;${esc(s.email)}&gt;` : ''}${when ? ` on ${esc(when)}` : ''}</div>`
      : `<div class="sigmeta muted">Pending signature</div>`;
    return `
      <div class="signature-block">
        <div class="sigrole">${label}</div>
        ${img}
        ${meta}
      </div>`;
  }).join('');
  return `<div class="signatures">${blocks}</div>`;
}

function businessDaysSubtract(date, days) {
  let d = new Date(date || Date.now()); let remaining = days;
  while (remaining > 0) { d.setDate(d.getDate() - 1); const day = d.getDay(); if (day !== 0 && day !== 6) remaining--; }
  return d;
}
function clampDraftDue(goLiveStart, now = new Date()) {
  const ideal = businessDaysSubtract(goLiveStart || now, 7);
  const floor = businessDaysSubtract(now, -2); // +2 business days
  return ideal < floor ? floor : ideal;
}

function fmtBool(v) { return v ? 'Yes' : 'No'; }
function fmtList(arr) { return (arr || []).filter(Boolean).join(', '); }

function renderDeliverablesTable(delivs = [], tz) {
  if (!delivs.length) return '<p class="muted">No deliverables defined.</p>';
  const rows = delivs.map((d, i) => {
    const pwStart = d?.postingWindow?.start ? formatDateTZ(d.postingWindow.start, tz) : '';
    const pwEnd = d?.postingWindow?.end ? formatDateTZ(d.postingWindow.end, tz) : '';
    const draftDue = d?.draftDueDate ? formatDateTZ(d.draftDueDate, tz) : '';
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(d.type || '')}</td>
        <td>${d.quantity ?? ''}</td>
        <td>${esc(d.format || '')}${d.durationSec ? ` (${d.durationSec}s)` : ''}</td>
        <td>${pwStart}${pwStart && pwEnd ? ' – ' : ''}${pwEnd}</td>
        <td>${fmtBool(d.draftRequired)}${draftDue ? `<br><span class="muted">Due: ${draftDue}</span>` : ''}</td>
        <td>${d.minLiveHours ?? ''}</td>
        <td>${fmtList(d.tags)}</td>
        <td>@${fmtList(d.handles)}</td>
        <td>${esc(d.captions || '')}${d.links?.length ? `<br>${fmtList(d.links)}` : ''}</td>
        <td>${esc(d.disclosures || '')}</td>
        <td>${fmtBool(d.whitelisting)} / ${fmtBool(d.sparkAds)}</td>
      </tr>`;
  }).join('');
  return `
    <table>
      <thead>
        <tr>
          <th>#</th><th>Type</th><th>Qty</th><th>Format/Duration</th>
          <th>Posting Window</th><th>Draft Req.</th><th>Min Live (hrs)</th>
          <th>Tags</th><th>Handles</th><th>Captions/Links</th><th>Disclosures</th>
          <th>Whitelist / Spark</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderUsageBundleTokens(ub = {}, currency = 'USD') {
  const geos = fmtList(ub.geographies);
  const spendCap = (ub.spendCap || ub.spendCap === 0)
    ? `${Number(ub.spendCap).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`
    : '—';
  const summary = `
    <p>
      <strong>Type:</strong> ${esc(ub.type || 'Organic')} |
      <strong>Duration:</strong> ${ub.durationMonths ?? '—'} months |
      <strong>Geographies:</strong> ${geos || '—'} |
      <strong>Derivative Edits:</strong> ${fmtBool(ub.derivativeEditsAllowed)} |
      <strong>Spend Cap:</strong> ${spendCap}
      ${ub.audienceRestrictions ? `<br><strong>Audience Restrictions:</strong> ${esc(ub.audienceRestrictions)}` : ''}
    </p>`.trim();

  const table = `
    <table>
      <thead>
        <tr><th>Type</th><th>Duration (months)</th><th>Geographies</th><th>Derivative Edits</th><th>Spend Cap</th><th>Audience Restrictions</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(ub.type || 'Organic')}</td>
          <td>${ub.durationMonths ?? '—'}</td>
          <td>${geos || '—'}</td>
          <td>${fmtBool(ub.derivativeEditsAllowed)}</td>
          <td>${spendCap}</td>
          <td>${esc(ub.audienceRestrictions || '—')}</td>
        </tr>
      </tbody>
    </table>`.trim();

  return {
    'Usage.Type': ub.type || 'Organic',
    'Usage.DurationMonths': ub.durationMonths ?? '',
    'Usage.Geographies': geos,
    'Usage.DerivativeEditsAllowed': fmtBool(ub.derivativeEditsAllowed),
    'Usage.SpendCap': spendCap,
    'Usage.AudienceRestrictions': ub.audienceRestrictions || '',
    'Usage.BundleSummary': summary,
    'Usage.BundleTableHTML': table
  };
}

function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const brandProfile = contract.other?.brandProfile || {};
  const inflProfile = contract.other?.influencerProfile || {};
  const b = contract.brand || {};
  const admin = contract.admin || {};
  const channels = (b.platforms || []).join(', ');

  const displayDate = contract.requestedEffectiveDate || contract.effectiveDate || new Date();

  const tokens = {
    'Agreement.EffectiveDate': formatDateTZ(displayDate, tz),
    'Agreement.EffectiveDateLong': formatDateTZ(displayDate, tz, 'Do MMMM YYYY'),

    'Brand.LegalName': brandProfile.legalName || contract.brandName || '',
    'Brand.Address': brandProfile.address || contract.brandAddress || '',
    'Brand.ContactName': brandProfile.contactName || '',

    'Influencer.LegalName': inflProfile.legalName || contract.influencerName || '',
    'Influencer.Address': inflProfile.address || contract.influencerAddress || '',
    'Influencer.ContactName': inflProfile.contactName || '',

    'CollabGlam.Address': '548 Market St, San Francisco, CA 94104, USA',
    'CollabGlam.SignatoryName': admin.collabglamSignatoryName || '',
    'Time.StandardTimezone': admin.timezone || tz,
    'Time.StandardJurisdiction': admin.jurisdiction || 'USA',
    'Arbitration.Seat': admin.arbitrationSeat || 'San Francisco, CA',
    'Payments.FXSource': admin.fxSource || 'ECB',

    'Campaign.Title': b.campaignTitle || '',
    'Campaign.Territory': 'Worldwide',
    'Campaign.Channels': channels,
    'Approval.BrandResponseWindow': admin.defaultBrandReviewWindowBDays ?? 2,
    'Approval.RoundsIncluded': b.revisionsIncluded ?? 1,
    'Approval.AdditionalRevisionFee': admin.extraRevisionFee ?? 0,
    'Comp.TotalFee': b.totalFee ?? 0,
    'Comp.Currency': b.currency || 'USD',
    'Comp.MilestoneSplit': b.milestoneSplit || '50/50',
    'Comp.NetTerms': 'Net 15',
    'Comp.PaymentMethod': 'Escrow via CollabGlam',
    'Exclusivity.WindowHoursAfterPost': 0,
    'ProductShipment.RequiredDate': b?.deliverablesExpanded?.[0]?.postingWindow?.start
      ? formatDateTZ(b.deliverablesExpanded[0].postingWindow.start, tz)
      : '',
    'ProductShipment.ReturnRequired': 'No',

    'SOW.DeliverablesTableHTML': renderDeliverablesTable(b.deliverablesExpanded || [], tz)
  };

  Object.assign(tokens, renderUsageBundleTokens(b.usageBundle || {}, tokens['Comp.Currency']));
  return tokens;
}

function renderTemplate(templateText, tokenMap) {
  return (templateText || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, '');
    const v = tokenMap[key];
    return (v === undefined || v === null) ? '' : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    { key: '[[SOW.DeliverablesTableHTML]]', html: tokens['SOW.DeliverablesTableHTML'] || '' },
    { key: '[[Usage.BundleSummary]]', html: tokens['Usage.BundleSummary'] || '' },
    { key: '[[Usage.BundleTableHTML]]', html: tokens['Usage.BundleTableHTML'] || '' },
  ];

  let out = legalHTML;
  for (const { key, html } of swaps) {
    if (!html) continue;
    out = out.replaceAll(key, html);
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wrapped = new RegExp(`<p>\\s*${escKey}\\s*<\\/p>`, 'g');
    out = out.replace(wrapped, html);
  }
  return out;
}

function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);
  legalHTML = legalHTML.replace('<div id="__SIG_PANEL__"></div>', signaturePanelHTML(contract));
  legalHTML = injectTrustedHtmlPlaceholders(legalHTML, contract);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @page { size: A4; margin: 25.4mm; }

    body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 11pt; line-height: 1.3; }
    h1, h2, h3 { font-size: 11pt; font-weight: 700; margin: 12pt 0 6pt; color: #000; }
    h1 { text-align: center; text-transform: uppercase; letter-spacing: .3px; }
    p { margin: 0 0 6pt; text-align: justify; color: #000; }
    .secno { font-weight: 700; }
    .numli, .subli, .bull { text-align: justify; padding-left: 18pt; text-indent: -18pt; }
    .marker { display: inline-block; width: 18pt; }

    .signatures { margin: 12pt 0 6pt; display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; break-inside: avoid; page-break-inside: avoid; }
    .signature-block { break-inside: avoid; page-break-inside: avoid; border: 1px solid #000; padding: 8pt; }
    .sigrole { font-weight: 700; margin-bottom: 4pt; }
    .sigimg { display: block; max-height: 60pt; max-width: 100%; margin: 0 0 6pt; }
    .sigmeta { font-size: 10pt; color: #000; }
    .muted { color: #444; }

    table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 8pt 0; }
    th, td { border: 1px solid #000; padding: 5pt 6pt; vertical-align: top; }
    th { text-align: left; background: #fff; font-weight: 700; }
    tr:nth-child(even) td { background: #fafafa; }

    .afterB p { margin-bottom: 5pt; }
  </style>
</head>
<body>
  <main>${legalHTML}</main>
</body>
</html>`;
}

async function renderPDFWithPuppeteer({ html, res, filename = 'Contract.pdf', headerTitle, headerDate }) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const headerTemplate = `
    <style>
      .pdf-h { font-family: "Times New Roman", Times, serif; font-size: 9pt; width: 100%; padding: 4mm 10mm; text-align: center; }
      .pdf-h .title { font-weight: bold; }
      .pdf-h .date { margin-top: 1mm; }
    </style>
    <div class="pdf-h">
      <div class="title">${esc(headerTitle || '')}</div>
      <div class="date">Effective Date: ${esc(headerDate || '')}</div>
    </div>`;
  try {
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'] });
    const pdf = await page.pdf({
      preferCSSPageSize: true,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate: '<div></div>',
      margin: { top: '25.4mm', bottom: '15mm', left: '25.4mm', right: '25.4mm' },
      scale: 1
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${filename}`);
    res.end(pdf);
  } finally {
    await browser.close();
  }
}

async function emitEvent(contract, event, details = {}) {
  contract.audit = contract.audit || [];
  contract.audit.push({ type: event, role: 'system', details });
  await contract.save();
}

function flatten(obj, prefix = '') {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) Object.assign(out, flatten(v, p));
    else out[p] = v;
  });
  return out;
}
function computeEditedFields(prevObj, nextObj, whitelist) {
  const prev = flatten(prevObj || {}); const next = flatten(nextObj || {});
  const fields = new Set();
  for (const key of Object.keys({ ...prev, ...next })) {
    const topKey = key.split('.')[0];
    if (whitelist && !whitelist.includes(topKey)) continue;
    const a = prev[key]; const b = next[key];
    const aVal = a instanceof Date ? a.toISOString() : JSON.stringify(a);
    const bVal = b instanceof Date ? b.toISOString() : JSON.stringify(b);
    if (aVal !== bVal) fields.add(key);
  }
  return Array.from(fields).sort();
}
function markEdit(contract, by, fields) {
  if (!fields.length) return;
  contract.isEdit = true;
  contract.isEditBy = by;
  contract.editedFields = fields;
  contract.lastEdit = { isEdit: true, by, at: new Date(), fields };
  contract.audit = contract.audit || [];
  contract.audit.push({ type: 'EDITED', role: by, details: { fields } });
}
function requireNotLocked(contract) {
  if (contract.status === 'locked' || contract.lockedAt) { const e = new Error('Contract is locked and cannot be edited'); e.status = 400; throw e; }
}
function bothSigned(contract) {
  const s = contract?.signatures || {};
  return Boolean(s?.brand?.signed && s?.influencer?.signed && s?.collabglam?.signed);
}
function requireNoEditsAfterBothSigned(contract) {
  if (bothSigned(contract)) { const e = new Error('All parties have signed; no further edits are allowed'); e.status = 400; throw e; }
}
function requireInfluencerConfirmed(contract) {
  if (!contract.confirmations?.influencer?.confirmed) { const e = new Error('Influencer must confirm before this action'); e.status = 400; throw e; }
}
function requireBrandConfirmed(contract) {
  if (!contract.confirmations?.brand?.confirmed) { const e = new Error('Brand must confirm before this action'); e.status = 400; throw e; }
}
// 🔒 New guard: block edits once ANY party has confirmed (brand OR influencer)
function requireNoPartyConfirmations(contract) {
  if (contract.confirmations?.brand?.confirmed || contract.confirmations?.influencer?.confirmed) {
    const e = new Error('Edits are allowed only before any confirmations');
    e.status = 400;
    throw e;
  }
}

function resolveEffectiveDate(contract) {
  if (contract.effectiveDateOverride) return contract.effectiveDateOverride;
  const dates = [contract.signatures?.brand?.at, contract.signatures?.influencer?.at, contract.signatures?.collabglam?.at]
    .filter(Boolean).map(d => new Date(d).getTime());
  if (!dates.length) return undefined;
  return new Date(Math.max(...dates));
}

function maybeLockIfReady(contract) {
  if (bothSigned(contract)) {
    contract.effectiveDate = resolveEffectiveDate(contract) || new Date();
    contract.effectiveDateTimezone = tzOr(contract);

    const tokens = buildTokenMap(contract);
    const templateText = contract.admin?.legalTemplateText || MASTER_TEMPLATE;
    const rendered = renderTemplate(templateText, tokens);

    contract.templateVersion = contract.admin?.legalTemplateVersion || 1;
    contract.templateTokensSnapshot = tokens;
    contract.renderedTextSnapshot = rendered;

    contract.lockedAt = new Date();
    contract.status = 'locked';
    contract.audit = contract.audit || [];
    contract.audit.push({ type: 'LOCKED', role: 'system', details: { allSigned: true } });
  }
}

// ---------- Resend child builder ----------
async function buildResendChildContract(parent, { brandInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, userEmail }) {
  // Recompute deliverables (enforce handle & draft due like initiate)
  const deliverablesExpanded = Array.isArray(brandInput.deliverablesExpanded) && brandInput.deliverablesExpanded.length
    ? brandInput.deliverablesExpanded
    : (parent.brand?.deliverablesExpanded || []);

  // Re-enforce handle from current influencer doc
  const influencerDoc = await Influencer.findOne({ influencerId: parent.influencerId }, 'handle');
  const enforcedHandle = influencerDoc?.handle || '';

  const draftDue = clampDraftDue(brandInput.goLive?.start || parent.brand?.goLive?.start || new Date());
  deliverablesExpanded.forEach(d => {
    const copy = d || {};
    if (copy.draftRequired && !copy.draftDueDate) copy.draftDueDate = draftDue;
    copy.handles = enforcedHandle ? [enforcedHandle] : [];
  });

  const admin = {
    ...(parent.admin || {}),
    // if legal text was bumped previously, keep the latest snapshot
    legalTemplateText: parent.admin?.legalTemplateText || MASTER_TEMPLATE,
  };

  const other = {
    ...(parent.other || {}),
    influencerProfile: { ...(parent.other?.influencerProfile || {}), handle: enforcedHandle },
    autoCalcs: { ...(parent.other?.autoCalcs || {}), firstDraftDue: draftDue, tokensExpandedAt: new Date() }
  };

  const nextBrand = {
    ...(parent.brand || {}),
    ...brandInput,
    deliverablesExpanded,
  };

  const child = new Contract({
    brandId: parent.brandId,
    influencerId: parent.influencerId,
    campaignId: parent.campaignId,

    status: 'sent',
    confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },

    brand: nextBrand,
    influencer: {},

    other,
    admin,

    lastSentAt: new Date(),
    isAssigned: 1,
    isAccepted: 0,
    isRejected: 0,

    feeAmount: Number((brandInput.totalFee ?? nextBrand.totalFee) || 0),
    currency: (brandInput.currency || nextBrand.currency || 'USD'),

    brandName: parent.brandName,
    brandAddress: parent.brandAddress,
    influencerName: parent.influencerName,
    influencerAddress: parent.influencerAddress,
    influencerHandle: enforcedHandle,

    requestedEffectiveDate: requestedEffectiveDate ? new Date(requestedEffectiveDate) : (parent.requestedEffectiveDate || undefined),
    requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || parent.requestedEffectiveDateTimezone || admin.timezone,

    resendIteration: (parent.resendIteration || 0) + 1,
    resendOf: parent.contractId
  });

  // Audit on child
  child.audit = child.audit || [];
  child.audit.push({ type: 'RESENT_CHILD_CREATED', role: 'system', details: { from: parent.contractId, by: userEmail || 'system' } });

  return child;
}

// ----------------------------- Endpoints -----------------------------

// INITIATE — Brand starts the contract (or preview). Also supports resend via { isResend, resendOf }.
exports.initiate = async (req, res) => {
  try {
    const {
      brandId, influencerId, campaignId,
      brand: brandInput = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
      isResend = false,
      resendOf
    } = req.body;

    if (!brandId || !influencerId || !campaignId) {
      return respondError(res, 'brandId, influencerId, campaignId are required', 400);
    }

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findOne({ campaignsId: campaignId }),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId })
    ]);
    if (!campaign) return respondError(res, 'Campaign not found', 404);
    if (!brandDoc) return respondError(res, 'Brand not found', 404);
    if (!influencerDoc) return respondError(res, 'Influencer not found', 404);

    const other = {
      brandProfile: {
        legalName: brandDoc.legalName || brandDoc.name || '',
        address: brandDoc.address || '',
        contactName: brandDoc.contactName || brandDoc.ownerName || '',
        email: brandDoc.email || '',
        country: brandDoc.country || ''
      },
      influencerProfile: {
        legalName: influencerDoc.legalName || influencerDoc.name || '',
        address: influencerDoc.address || '',
        contactName: influencerDoc.contactName || influencerDoc.name || '',
        email: influencerDoc.email || '',
        country: influencerDoc.country || '',
        handle: influencerDoc.handle || ''
      },
      autoCalcs: {}
    };

    const deliverablesExpanded = Array.isArray(brandInput.deliverablesExpanded) && brandInput.deliverablesExpanded.length
      ? brandInput.deliverablesExpanded
      : [{
          type: 'Video', quantity: 1, format: 'MP4', durationSec: 60,
          postingWindow: { start: brandInput.goLive?.start, end: brandInput.goLive?.end },
          draftRequired: (brandInput.revisionsIncluded ?? 1) > 0, minLiveHours: 720,
          tags: [], handles: [], captions: '', links: [], disclosures: '#ad'
        }];
    const draftDue = clampDraftDue(brandInput.goLive?.start || new Date());
    const enforcedHandle = influencerDoc.handle || '';
    deliverablesExpanded.forEach(d => {
      if (d.draftRequired && !d.draftDueDate) d.draftDueDate = draftDue;
      d.handles = enforcedHandle ? [enforcedHandle] : [];
    });
    other.autoCalcs.firstDraftDue = draftDue;
    other.autoCalcs.tokensExpandedAt = new Date();

    const admin = {
      timezone: campaign?.timezone || 'America/Los_Angeles',
      jurisdiction: 'USA',
      arbitrationSeat: 'San Francisco, CA',
      fxSource: 'ECB',
      defaultBrandReviewWindowBDays: 2,
      extraRevisionFee: 0,
      escrowAMLFlags: '',
      legalTemplateVersion: 1,
      legalTemplateText: MASTER_TEMPLATE,
      legalTemplateHistory: [{ version: 1, text: MASTER_TEMPLATE, updatedAt: new Date(), updatedBy: req.user?.email || 'system' }]
    };

    const base = {
      brandId, influencerId, campaignId,
      brand: { ...brandInput, deliverablesExpanded },
      influencer: {},
      other, admin,
      confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },
      requestedEffectiveDate: requestedEffectiveDate ? new Date(requestedEffectiveDate) : undefined,
      requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || admin.timezone,
      brandName: other.brandProfile.legalName,
      brandAddress: other.brandProfile.address,
      influencerName: other.influencerProfile.legalName,
      influencerAddress: other.influencerProfile.address,
      influencerHandle: other.influencerProfile.handle
    };

    // Preview (non-resend)
    if (preview && !isResend) {
      const tmp = new Contract({ ...base, status: 'draft' });
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin.legalTemplateText, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
      const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');
      return await renderPDFWithPuppeteer({ html, res, filename: `Contract-Preview-${campaignId}.pdf`, headerTitle, headerDate });
    }

    // RESEND path inside initiate
    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, 'resendOf contract not found', 404);

      if (String(parent.brandId) !== String(brandId) ||
          String(parent.influencerId) !== String(influencerId) ||
          String(parent.campaignId) !== String(campaignId)) {
        return respondError(res, 'resendOf must belong to the same brand, influencer, and campaign', 400);
      }
      if (parent.status === 'locked') return respondError(res, 'Cannot resend a locked contract', 400);

      const child = await buildResendChildContract(parent, {
        brandInput,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email
      });
      await child.save();

      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.audit = parent.audit || [];
      parent.audit.push({ type: 'RESENT', role: 'system', details: { to: child.contractId, by: req.user?.email || 'system' } });
      await parent.save();

      await Campaign.updateOne(
        { campaignsId: campaignId },
        { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
      );

      // 🔔 notify influencer (resend)
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(influencerId),
        type: 'contract.initiated',
        title: `Contract resent by ${brandDoc.name}`,
        message: `Updated contract for "${campaign.productOrServiceName}".`,
        entityType: 'contract',
        entityId: String(child.contractId),
        actionPath: `/influencer/my-campaign`,
        meta: { campaignId, brandId, influencerId, resendOf: parent.contractId }
      });

      // 🔔 self receipt for brand (resend)
      await createAndEmit({
        recipientType: 'brand',
        brandId: String(brandId),
        type: 'contract.initiated.self',
        title: 'Contract resent',
        message: `You resent the contract to ${influencerDoc?.name || 'Influencer'} for “${campaign?.productOrServiceName || 'Campaign'}”.`,
        entityType: 'contract',
        entityId: String(child.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
        meta: { campaignId, influencerId, resendOf: parent.contractId }
      });

      return respondOK(res, { message: 'Resent contract created', contract: child }, 201);
    }

    // Normal first-time send
    const contract = new Contract({
      ...base, status: 'sent', lastSentAt: new Date(), isAssigned: 1,
      isAccepted: 0,
      feeAmount: Number(brandInput.totalFee || 0),
      currency: brandInput.currency || 'USD'
    });
    await contract.save();
    await emitEvent(contract, 'INITIATED', { campaignId, status: contract.status });

    await Campaign.updateOne(
      { campaignsId: campaignId },
      { $set: { isContracted: 1, contractId: contract.contractId, isAccepted: 0 } }
    );

    // 🔔 notify influencer (initiate)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(influencerId),
      type: 'contract.initiated',
      title: `Contract initiated by ${brandDoc.name}`,
      message: `Contract created for "${campaign.productOrServiceName}".`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId, brandId, influencerId }
    });

    // 🔔 self receipt for brand (initiate)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(brandId),
      type: 'contract.initiated.self',
      title: 'Contract sent',
      message: `You sent a contract to ${influencerDoc.name || 'Influencer'} for “${campaign.productOrServiceName}”.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { campaignId, influencerId }
    });

    return respondOK(res, { message: 'Contract initialized successfully', contract }, 201);
  } catch (err) {
    return respondError(res, 'initiate error', 500, err);
  }
};

// VIEWED
exports.viewed = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (['draft', 'sent'].includes(contract.status)) contract.status = 'viewed';
    await contract.save();
    await emitEvent(contract, 'VIEWED');
    return respondOK(res, { message: 'Marked viewed', contract });
  } catch (err) {
    return respondError(res, 'viewed error', 500, err);
  }
};

// INFLUENCER CONFIRM (does NOT change status)
exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, preview = false } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (['finalize', 'signing', 'locked'].includes(contract.status)) return respondError(res, 'Contract is finalized; no further edits allowed', 400);

    const safeInfluencer = { dataAccess: {}, ...influencerData, dataAccess: influencerData?.dataAccess || {} };

    if (preview) {
      const tmp = new Contract(contract.toObject());
      tmp.influencer = { ...(tmp.influencer || {}), ...safeInfluencer };
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
      const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');
      return await renderPDFWithPuppeteer({ html, res, filename: `Contract-Influencer-Preview-${contractId}.pdf`, headerTitle, headerDate });
    }

    const editedFields = computeEditedFields({ influencer: contract.influencer }, { influencer: safeInfluencer }, ['influencer']);
    contract.influencer = { ...(contract.influencer || {}), ...safeInfluencer };
    contract.confirmations = contract.confirmations || {};
    contract.confirmations.influencer = { confirmed: true, byUserId: req.user?.id, at: new Date() };
    markEdit(contract, 'influencer', editedFields);

    contract.isAccepted = 1;
    await contract.save();
    await emitEvent(contract, 'INFLUENCER_CONFIRMED', { editedFields });
    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } }
    );

    // 🔔 notify brand (influencer accepted/confirmed)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(contract.brandId),
      type: 'contract.confirm.influencer',
      title: `Influencer accepted`,
      message: `${contract.influencerName || 'Influencer'} accepted the contract.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/contracts/${contract.contractId}`
    });

    // 🔔 self receipt for influencer (accepted)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(contract.influencerId),
      type: 'contract.confirm.influencer.self',
      title: 'You accepted the contract',
      message: `You accepted “${contract.brand?.campaignTitle || contract.brandName || 'Contract'}”.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId: contract.campaignId, brandId: contract.brandId }
    });

    return respondOK(res, { message: 'Influencer confirmation saved', contract });
  } catch (err) {
    return respondError(res, 'influencerConfirm error', 500, err);
  }
};

// BRAND CONFIRM
exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (contract.status === 'locked') return respondError(res, 'Contract is locked', 400);
    contract.confirmations = contract.confirmations || {};
    contract.confirmations.brand = { confirmed: true, byUserId: req.user?.id, at: new Date() };
    if (contract.status === 'sent') contract.status = 'viewed';
    await contract.save();
    await emitEvent(contract, 'BRAND_CONFIRMED');

    // 🔔 notify influencer (brand confirmed)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(contract.influencerId),
      type: 'contract.confirm.brand',
      title: `Brand confirmed`,
      message: `${contract.brandName || 'Brand'} confirmed the contract.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`
    });

    // 🔔 self receipt for brand (confirmed)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(contract.brandId),
      type: 'contract.confirm.brand.self',
      title: 'You confirmed the contract',
      message: `You confirmed the contract for “${contract.brand?.campaignTitle || 'Campaign'}”.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      meta: { campaignId: contract.campaignId, influencerId: contract.influencerId }
    });

    return respondOK(res, { message: 'Brand confirmation saved', contract });
  } catch (err) {
    return respondError(res, 'brandConfirm error', 500, err);
  }
};

// ADMIN UPDATE (Admin + optional legal text bump)
exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (!req.user?.isAdmin) return respondError(res, 'Forbidden: admin only', 403);
    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);

    const before = { admin: contract.admin?.toObject?.() || contract.admin };
    contract.admin = { ...contract.admin, ...adminUpdates };

    if (typeof newLegalText === 'string' && newLegalText.trim()) {
      const newVersion = (contract.admin.legalTemplateVersion || 1) + 1;
      contract.admin.legalTemplateVersion = newVersion;
      contract.admin.legalTemplateText = newLegalText;
      contract.admin.legalTemplateHistory = contract.admin.legalTemplateHistory || [];
      contract.admin.legalTemplateHistory.push({
        version: newVersion, text: newLegalText, updatedAt: new Date(), updatedBy: req.user?.email || 'admin'
      });
    }

    const after = { admin: contract.admin };
    const editedFields = computeEditedFields(before, after, ['admin']);
    markEdit(contract, 'admin', editedFields);

    await contract.save();
    await emitEvent(contract, 'ADMIN_UPDATED', { adminUpdates: Object.keys(adminUpdates), newVersion: contract.admin.legalTemplateVersion });
    return respondOK(res, { message: 'Admin settings updated', contract });
  } catch (err) {
    return respondError(res, 'adminUpdate error', 500, err);
  }
};

// FINALIZE (freeze for signatures)
exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (['finalize', 'signing', 'locked'].includes(contract.status)) return respondOK(res, { message: 'Already finalized or beyond', contract });
    contract.status = 'finalize';
    await contract.save();
    await emitEvent(contract, 'FINALIZED');
    return respondOK(res, { message: 'Contract finalized for signatures', contract });
  } catch (err) {
    return respondError(res, 'finalize error', 500, err);
  }
};

// PREVIEW (always returns PDF stream)
exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    if (!contractId) return respondError(res, 'contractId is required', 400);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);

    const tz = tzOr(contract);
    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));

    const html = renderContractHTML({ contract, templateText: text });
    const tokens = buildTokenMap(contract);
    const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');

    return await renderPDFWithPuppeteer({ html, res, filename: `Contract-${contractId}.pdf`, headerTitle: 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)', headerDate });
  } catch (err) {
    return respondError(res, 'preview error', 500, err);
  }
};

// VIEW/PRINT PDF
exports.viewContractPdf = async (req, res) => {
  let contract;
  try {
    const { contractId } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);
    contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);

    const tz = tzOr(contract);
    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));
    const html = renderContractHTML({ contract, templateText: text });

    const tokens = buildTokenMap(contract);
    const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');

    return await renderPDFWithPuppeteer({ html, res, filename: `Contract-${contractId}.pdf`, headerTitle: 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)', headerDate });
  } catch (err) {
    console.error('viewContractPdf error:', err);
    try {
      const templateText = renderTemplate((contract?.admin?.legalTemplateText) || MASTER_TEMPLATE, buildTokenMap(contract || {}));
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename=Contract-${(contract?.contractId || 'Unknown')}.pdf`);
      doc.pipe(res);
      doc.fontSize(18).text('Master Brand–Influencer Agreement', { align: 'center' }).moveDown();
      const paragraphs = String(templateText || '').split(/\n\s*\n/);
      paragraphs.forEach((p, i) => { doc.text(p, { align: 'justify' }); if (i < paragraphs.length - 1) doc.moveDown(); });
      doc.end();
    } catch (e2) {
      return respondError(res, 'fallback PDF also failed', 500, e2);
    }
  }
};

// SIGN (brand/influencer/admin). Locks when ALL signed.
exports.sign = async (req, res) => {
  try {
    const { contractId, role, name, email, effectiveDateOverride, signatureImageDataUrl, signatureImageBase64, signatureImageMime } = req.body;
    if (!contractId || !role) return respondError(res, 'contractId and role are required', 400);
    if (!['brand', 'influencer', 'collabglam'].includes(role)) return respondError(res, 'Invalid role', 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (contract.status === 'locked') return respondError(res, 'Contract is locked', 400);

    if (role === 'brand') requireBrandConfirmed(contract);
    if (role === 'influencer') requireInfluencerConfirmed(contract);

    let sigImageDataUrl = null;
    if (signatureImageDataUrl || signatureImageBase64) {
      let mime = 'image/png'; let base64 = '';
      if (signatureImageDataUrl) {
        const m = String(signatureImageDataUrl).match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i);
        if (!m) return respondError(res, 'Invalid signatureImageDataUrl. Must be data URL with base64.', 400);
        mime = m[1].toLowerCase(); base64 = m[3];
      } else {
        mime = (signatureImageMime || 'image/png').toLowerCase();
        if (!/^image\/(png|jpeg|jpg)$/.test(mime)) return respondError(res, 'Unsupported signatureImageMime. Use image/png or image/jpeg.', 400);
        base64 = String(signatureImageBase64 || '');
        if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return respondError(res, 'Invalid base64 payload for signature image.', 400);
      }
      const bytes = Buffer.from(base64, 'base64').length;
      if (bytes > 50 * 1024) return respondError(res, 'Signature image must be <= 50 KB.', 400);
      sigImageDataUrl = `data:${mime};base64,${base64}`;
    }

    contract.signatures = contract.signatures || {};
    const now = new Date();
    contract.signatures[role] = {
      ...(contract.signatures[role] || {}),
      signed: true, byUserId: req.user?.id, name, email, at: now,
      ...(sigImageDataUrl ? { sigImageDataUrl, sigImageBytes: Buffer.from(sigImageDataUrl.split(',')[1], 'base64').length } : {})
    };

    if (!['finalize', 'signing', 'locked'].includes(contract.status)) contract.status = 'signing';
    if (effectiveDateOverride && req.user?.isAdmin) contract.effectiveDateOverride = new Date(effectiveDateOverride);

    await emitEvent(contract, 'SIGNED', { role, name, email });
    maybeLockIfReady(contract);
    await contract.save();

    const locked = contract.status === 'locked';
    const campaignSync = { isContracted: 1, contractId: contract.contractId };
    if (contract.isAccepted === 1) campaignSync.isAccepted = 1;
    if (locked) campaignSync.contractLockedAt = contract.lockedAt || new Date();

    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: campaignSync }
    );

    // counterparty notification
    const opp = role === 'brand'
      ? { recipientType: 'influencer', influencerId: String(contract.influencerId), type: 'contract.signed.brand', path: `/influencer/my-campaign` }
      : role === 'influencer'
        ? { recipientType: 'brand', brandId: String(contract.brandId), type: 'contract.signed.influencer', path: `/brand/created-campaign/applied-inf?id=${contract.campaignId}` }
        : null;

    if (opp) {
      await createAndEmit({
        recipientType: opp.recipientType,
        brandId: opp.brandId,
        influencerId: opp.influencerId,
        type: opp.type,
        title: `${role === 'brand' ? 'Brand' : 'Influencer'} signed`,
        message: `${role === 'brand' ? (contract.brandName || 'Brand') : (contract.influencerName || 'Influencer')} added a signature.`,
        entityType: 'contract',
        entityId: String(contract.contractId),
        actionPath: opp.path
      });
    }

    // self receipt for acting party
    if (role === 'brand') {
      await createAndEmit({
        recipientType: 'brand',
        brandId: String(contract.brandId),
        type: 'contract.signed.brand.self',
        title: 'You signed the contract',
        message: 'Your signature has been recorded.',
        entityType: 'contract',
        entityId: String(contract.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`
      });
    } else if (role === 'influencer') {
      await createAndEmit({
        recipientType: 'influencer',
        influencerId: String(contract.influencerId),
        type: 'contract.signed.influencer.self',
        title: 'You signed the contract',
        message: 'Your signature has been recorded.',
        entityType: 'contract',
        entityId: String(contract.contractId),
        actionPath: `/influencer/my-campaign`
      });
    }

    // fully signed => notify both
    if (locked) {
      await Promise.all([
        createAndEmit({
          recipientType: 'brand',
          brandId: String(contract.brandId),
          type: 'contract.locked',
          title: 'Contract fully signed',
          message: 'All parties signed. Your contract is locked.',
          entityType: 'contract',
          entityId: String(contract.contractId),
          actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`
        }),
        createAndEmit({
          recipientType: 'influencer',
          influencerId: String(contract.influencerId),
          type: 'contract.locked',
          title: 'Contract fully signed',
          message: 'All parties signed. Your contract is locked.',
          entityType: 'contract',
          entityId: String(contract.contractId),
          actionPath: `/influencer/my-campaign`
        })
      ]);
    }

    return respondOK(res, { message: (locked ? 'Signed & locked' : 'Signature recorded'), contract });
  } catch (err) {
    if (err && err.status && err.message) return respondError(res, err.message, err.status, err);
    return respondError(res, 'sign error', 500, err);
  }
};

const ALLOWED_BRAND_KEYS = [
  'campaignTitle', 'platforms', 'goLive', 'totalFee', 'currency', 'milestoneSplit', 'usageBundle',
  'revisionsIncluded', 'deliverablesPresetKey', 'deliverablesExpanded',
  'requestedEffectiveDate', 'requestedEffectiveDateTimezone'
];
const ALLOWED_INFLUENCER_KEYS = ['shippingAddress', 'dataAccess', 'taxFormType'];

// BRAND UPDATE (Brand fields) — **only BEFORE any confirmations**; blocked once all signed or any confirmed
exports.brandUpdateFields = async (req, res) => {
  try {
    const { contractId, brandId, brandUpdates = {} } = req.body;
    if (!contractId || !brandId) return respondError(res, 'contractId and brandId are required', 400);

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return respondError(res, 'Contract not found', 404);

    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);
    // 🚫 key rule: edits only before ANY confirmations (brand or influencer)
    requireNoPartyConfirmations(contract);

    const before = { brand: contract.brand?.toObject?.() || contract.brand };

    for (const k of Object.keys(brandUpdates)) {
      if (!ALLOWED_BRAND_KEYS.includes(k)) continue;
      if (k === 'goLive' && brandUpdates.goLive?.start) {
        const dd = clampDraftDue(brandUpdates.goLive.start);
        (contract.brand.deliverablesExpanded || []).forEach(d => { if (d.draftRequired) d.draftDueDate = dd; });
        contract.other = contract.other || {};
        contract.other.autoCalcs = contract.other.autoCalcs || {};
        contract.other.autoCalcs.firstDraftDue = dd;
      }
      if (k === 'requestedEffectiveDate') contract.requestedEffectiveDate = new Date(brandUpdates[k]);
      else if (k === 'requestedEffectiveDateTimezone') contract.requestedEffectiveDateTimezone = brandUpdates[k];
      else contract.brand[k] = brandUpdates[k];
    }

    // Keep influencer handle enforced in deliverables
    const inf = await Influencer.findOne({ influencerId: contract.influencerId }, 'handle').lean();
    const enforcedHandle = inf?.handle || '';
    if (Array.isArray(contract.brand?.deliverablesExpanded)) {
      contract.brand.deliverablesExpanded = contract.brand.deliverablesExpanded.map(d => ({ ...d, handles: enforcedHandle ? [enforcedHandle] : [] }));
    }
    contract.other = contract.other || {}; contract.other.influencerProfile = contract.other.influencerProfile || {}; contract.other.influencerProfile.handle = enforcedHandle;

    const after = { brand: contract.brand };
    const editedFields = computeEditedFields(before, after, ['brand']);
    markEdit(contract, 'brand', editedFields);

    if (!['finalize', 'signing', 'locked'].includes(contract.status)) contract.status = 'negotiation';
    contract.lastSentAt = new Date();

    await contract.save();
    await emitEvent(contract, 'BRAND_EDITED', { brandUpdates: Object.keys(brandUpdates), editedFields });

    // 🔔 notify influencer (brand edited)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(contract.influencerId),
      type: 'contract.edited.brand',
      title: `Contract updated by ${contract.brandName || 'Brand'}`,
      message: `Brand made changes to your contract.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`
    });

    // 🔔 self receipt for brand (brand edited)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(contract.brandId),
      type: 'contract.edited.brand.self',
      title: 'You updated the contract',
      message: 'Your changes were saved and shared with the influencer.',
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { editedFields }
    });

    return respondOK(res, { message: 'Brand fields updated', contract });
  } catch (err) {
    if (err && err.status && err.message) return respondError(res, err.message, err.status, err);
    return respondError(res, 'brandUpdateFields error', 500, err);
  }
};

// INFLUENCER UPDATE (Influencer fields)
exports.influencerUpdateFields = async (req, res) => {
  try {
    const { contractId, influencerUpdates = {} } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);
    requireInfluencerConfirmed(contract);

    const before = { influencer: contract.influencer?.toObject?.() || contract.influencer };
    for (const k of Object.keys(influencerUpdates)) {
      if (!ALLOWED_INFLUENCER_KEYS.includes(k)) continue;
      if (!contract.influencer) contract.influencer = {};
      contract.influencer[k] = influencerUpdates[k];
    }

    const after = { influencer: contract.influencer };
    const editedFields = computeEditedFields(before, after, ['influencer']);
    markEdit(contract, 'influencer', editedFields);

    if (!['finalize', 'signing', 'locked'].includes(contract.status)) contract.status = 'negotiation';

    await contract.save();
    await emitEvent(contract, 'INFLUENCER_EDITED', { editedFields });

    // 🔔 notify brand (influencer edited)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(contract.brandId),
      type: 'contract.edited.influencer',
      title: `Contract updated by ${contract.influencerName || 'Influencer'}`,
      message: `Influencer submitted updates to the contract.`,
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`
    });

    // 🔔 self receipt for influencer (influencer edited)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(contract.influencerId),
      type: 'contract.edited.influencer.self',
      title: 'You updated the contract',
      message: 'Your updates were sent to the brand.',
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { editedFields }
    });

    return respondOK(res, { message: 'Influencer fields updated', contract });
  } catch (err) {
    return respondError(res, 'influencerUpdateFields error', 500, err);
  }
};

// BASIC READ — return contracts array (200 even if empty)
exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId } = req.body;
    if (!brandId || !influencerId) return respondError(res, 'brandId and influencerId are required', 400);
    const contracts = await Contract.find({ brandId, influencerId }).sort({ createdAt: -1 });
    if (!contracts || !contracts.length) return respondOK(res, { contracts: [] });
    return respondOK(res, { contracts });
  } catch (err) {
    return respondError(res, 'Error fetching contracts', 500, err);
  }
};

// REJECT
exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, 'Contract not found', 404);
    if (contract.status === 'locked') return respondError(res, 'Contract is locked', 400);

    if (influencerId && String(influencerId) !== String(contract.influencerId)) {
      return respondError(res, 'Forbidden', 403);
    }

    contract.isRejected = 1;
    contract.status = 'rejected';
    contract.audit = contract.audit || [];
    contract.audit.push({ type: 'REJECTED', role: 'influencer', details: { reason } });
    await contract.save();

    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: { isContracted: 0, contractId: null, isAccepted: 0 } }
    );

    // 🔔 notify brand (rejected)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(contract.brandId),
      type: 'contract.rejected',
      title: 'Contract rejected by influencer',
      message: reason ? `Reason: ${reason}` : 'Influencer rejected the contract.',
      entityType: 'contract',
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`
    });

    return respondOK(res, { message: 'Contract rejected', contract });
  } catch (err) {
    return respondError(res, 'reject error', 500, err);
  }
};

// GET /contract/timezones
exports.listTimezones = async (req, res) => {
  try { return respondOK(res, { timezones: loadTimezones() }); }
  catch (err) { return respondError(res, 'listTimezones error', 500, err); }
};

// GET /contract/timezone?key=...
exports.getTimezone = async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return respondError(res, 'key query param is required', 400);
    const tz = findTimezoneByValueOrUTC(key);
    if (!tz) return respondError(res, 'Timezone not found', 404);
    return respondOK(res, { timezone: tz });
  } catch (err) {
    return respondError(res, 'getTimezone error', 500, err);
  }
};

// GET /contract/currencies
exports.listCurrencies = async (req, res) => {
  try {
    const data = loadCurrencies();
    const arr = Object.keys(data).map(code => ({ code, ...data[code] }));
    return respondOK(res, { currencies: arr });
  } catch (err) {
    return respondError(res, 'listCurrencies error', 500, err);
  }
};

// GET /contract/currency?code=USD
exports.getCurrency = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return respondError(res, 'code query param is required', 400);
    const data = loadCurrencies();
    const cur = data[String(code).toUpperCase()];
    if (!cur) return respondError(res, 'Currency not found', 404);
    return respondOK(res, { currency: { code: String(code).toUpperCase(), ...cur } });
  } catch (err) {
    return respondError(res, 'getCurrency error', 500, err);
  }
};

// -------- Dedicated RESEND endpoint (optional helper) --------
// POST /contract/resend
// Body: { contractId, brandUpdates?, requestedEffectiveDate?, requestedEffectiveDateTimezone?, preview? }
exports.resend = async (req, res) => {
  try {
    const { contractId, brandUpdates = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false } = req.body;
    if (!contractId) return respondError(res, 'contractId is required', 400);

    const parent = await Contract.findOne({ contractId });
    if (!parent) return respondError(res, 'Contract not found', 404);
    if (parent.status === 'locked') return respondError(res, 'Cannot resend a locked contract', 400);

    if (preview) {
      const tmp = await buildResendChildContract(parent, {
        brandInput: brandUpdates,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email
      });
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
      const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');
      return await renderPDFWithPuppeteer({ html, res, filename: `Contract-Resend-Preview-${contractId}.pdf`, headerTitle, headerDate });
    }

    const child = await buildResendChildContract(parent, {
      brandInput: brandUpdates,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      userEmail: req.user?.email
    });

    await child.save();

    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.audit = parent.audit || [];
    parent.audit.push({ type: 'RESENT', role: 'system', details: { to: child.contractId, by: req.user?.email || 'system' } });
    await parent.save();

    await Campaign.updateOne(
      { campaignsId: parent.campaignId },
      { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
    );

    // 🔔 notify influencer (resend)
    await createAndEmit({
      recipientType: 'influencer',
      influencerId: String(parent.influencerId),
      type: 'contract.initiated',
      title: `Contract resent by ${parent.brandName || 'Brand'}`,
      message: `Updated contract is available.`,
      entityType: 'contract',
      entityId: String(child.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId: parent.campaignId, brandId: parent.brandId, influencerId: parent.influencerId, resendOf: parent.contractId }
    });

    // 🔔 self receipt for brand (resend)
    await createAndEmit({
      recipientType: 'brand',
      brandId: String(parent.brandId),
      type: 'contract.initiated.self',
      title: 'Contract resent',
      message: 'You resent an updated contract to the influencer.',
      entityType: 'contract',
      entityId: String(child.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { campaignId: parent.campaignId, influencerId: parent.influencerId, resendOf: parent.contractId }
    });

    return respondOK(res, { message: 'Resent contract created', contract: child }, 201);
  } catch (err) {
    return respondError(res, 'resend error', 500, err);
  }
};
