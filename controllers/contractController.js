// ========================= controllers/contractsController.js (updated) =========================
const PDFDocument = require('pdfkit');
const moment = require('moment-timezone');
const puppeteer = require('puppeteer');

const Contract = require('../models/contract');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const { STATUS } = require('../models/contract');
const MASTER_TEMPLATE = require('../template/ContractTemplate');

// ----------------------------- Utilities -----------------------------
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

function legalTextToHTML(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = []; let buffer = [];
  let consumedTitle = false;
  let inSchedules = false;
  let afterBOpen = false;

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

    // Title
    if (!consumedTitle && /Agreement/i.test(line) && line.length > 30) {
      flushP(); out.push(`<h1>${esc(line)}</h1>`); consumedTitle = true; continue;
    }

    // Schedule heading
    const sch = line.match(/^Schedule\s+([A-Z])\s+–\s+(.+)$/);
    if (sch) {
      flushP();
      const letter = sch[1];
      inSchedules = true;
      if (letter >= 'C') openAfterB();
      out.push(`<h3>Schedule ${esc(letter)} – ${esc(sch[2])}</h3>`);
      continue;
    }

    // Signatures placeholder
    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push('<h2>Signatures</h2>');
      out.push('<div id="__SIG_PANEL__"></div>');
      continue;
    }

    // Main numbered sections as headings before schedules
    const sec = line.match(/^(\d+)\.\s+(.+)$/);
    if (sec && !inSchedules) { flushP(); out.push(`<h2><span class="secno">${esc(sec[1])}.</span> ${esc(sec[2])}</h2>`); continue; }

    // Inside schedules: numbered items become hanging-indent paragraphs
    if (sec && inSchedules) { flushP(); out.push(`<p class="numli"><span class="marker">${esc(sec[1])}.</span> ${esc(sec[2])}</p>`); continue; }

    // Lettered items a., b., c.
    const letm = line.match(/^([a-z])\.\s+(.+)$/i);
    if (letm) { flushP(); out.push(`<p class="subli"><span class="marker">${esc(letm[1])}.</span> ${esc(letm[2])}</p>`); continue; }

    // Bullets
    const bul = line.match(/^[-•]\s+(.+)$/);
    if (bul) { flushP(); out.push(`<p class="bull"><span class="marker">•</span> ${esc(bul[1])}</p>`); continue; }

    buffer.push(rawLine);
  }

  flushP();
  if (!consumedTitle) out.unshift('<h1>Master Brand–Influencer Agreement</h1>');
  if (afterBOpen) out.push('</div>');
  return out.join('\n');
}

function formatDateTZ(date, tz, fmt = 'MMMM D, YYYY') {
  return moment(date).tz(tz).format(fmt);
}

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

// ---------- NEW: Table helpers & token builders ----------
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

// ---- Token Hydration ----
function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const brandProfile = contract.other?.brandProfile || {};
  const inflProfile = contract.other?.influencerProfile || {};
  const b = contract.brand || {};
  const admin = contract.admin || {};
  const channels = (b.platforms || []).join(', ');

  // Display date preference: requestedEffectiveDate (brand intent) if present, else effectiveDate (SoR), else now
  const displayDate = contract.requestedEffectiveDate || contract.effectiveDate || new Date();

  const tokens = {
    'Agreement.EffectiveDate': formatDateTZ(displayDate, tz),
    'Agreement.EffectiveDateLong': formatDateTZ(displayDate, tz, 'Do MMMM YYYY'),

    // Brand (saved in other.brandProfile for tokens)
    'Brand.LegalName': brandProfile.legalName || contract.brandName || '',
    'Brand.Address': brandProfile.address || contract.brandAddress || '',
    'Brand.ContactName': brandProfile.contactName || '',

    // Influencer
    'Influencer.LegalName': inflProfile.legalName || contract.influencerName || '',
    'Influencer.Address': inflProfile.address || contract.influencerAddress || '',
    'Influencer.ContactName': inflProfile.contactName || '',

    // Admin
    'CollabGlam.Address': '548 Market St, San Francisco, CA 94104, USA',
    'CollabGlam.SignatoryName': admin.collabglamSignatoryName || '',
    'Time.StandardTimezone': admin.timezone || tz,
    'Time.StandardJurisdiction': admin.jurisdiction || 'USA',
    'Arbitration.Seat': admin.arbitrationSeat || 'San Francisco, CA',
    'Payments.FXSource': admin.fxSource || 'ECB',

    // Campaign / Commercials
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

    // NEW: SOW deliverables table
    'SOW.DeliverablesTableHTML': renderDeliverablesTable(b.deliverablesExpanded || [], tz)
  };

  // NEW: usage bundle tokens
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
    // Replace raw marker
    out = out.replaceAll(key, html);
    // Replace if wrapped in a <p>...</p> from the converter
    const wrapped = new RegExp(`<p>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/p>`, 'g');
    out = out.replace(wrapped, html);
  }

  return out;
}


function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);

  // Inject signatures panel
  legalHTML = legalHTML.replace('<div id="__SIG_PANEL__"></div>', signaturePanelHTML(contract));

  // Inject trusted HTML blocks (tables, usage summary)
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

    /* Clean black & white tables */
    table { width: 100%; border-collapse: collapse; font-size: 10pt; margin: 8pt 0; }
    th, td { border: 1px solid #000; padding: 5pt 6pt; vertical-align: top; }
    th { text-align: left; background: #fff; font-weight: 700; }
    tr:nth-child(even) td { background: #fafafa; }

    /* Keep schedules after B together a bit tighter */
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
  contract.audit.push({ type: event, role: 'system', details });
  await contract.save();
}

// ---- Edit helpers ----
const ALLOWED_BRAND_KEYS = [
  'campaignTitle', 'platforms', 'goLive', 'totalFee', 'currency', 'milestoneSplit', 'usageBundle',
  'revisionsIncluded', 'deliverablesPresetKey', 'deliverablesExpanded',
  'requestedEffectiveDate', 'requestedEffectiveDateTimezone'
];

const ALLOWED_INFLUENCER_KEYS = ['shippingAddress', 'dataAccess', 'taxFormType'];

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
  contract.audit.push({ type: 'EDITED', role: by, details: { fields } });
}
function requireNotLocked(contract) {
  if (contract.status === 'locked' || contract.lockedAt) {
    const e = new Error('Contract is locked and cannot be edited');
    e.status = 400; throw e;
  }
}
function bothSigned(contract) {
  const s = contract?.signatures;
  return Boolean(s?.brand?.signed && s?.influencer?.signed && s?.collabglam?.signed);
}
function requireNoEditsAfterBothSigned(contract) {
  if (bothSigned(contract)) {
    const e = new Error('All parties have signed; no further edits are allowed');
    e.status = 400; throw e;
  }
}
function requireInfluencerConfirmed(contract) {
  if (!contract.confirmations?.influencer?.confirmed) {
    const e = new Error('Influencer must confirm before this action');
    e.status = 400; throw e;
  }
}

// Effective date resolver: later of all signatures unless admin override
function resolveEffectiveDate(contract) {
  if (contract.effectiveDateOverride) return contract.effectiveDateOverride;
  const dates = [contract.signatures?.brand?.at, contract.signatures?.influencer?.at, contract.signatures?.collabglam?.at]
    .filter(Boolean)
    .map(d => new Date(d).getTime());
  if (!dates.length) return undefined;
  return new Date(Math.max(...dates));
}

/** Lock snapshot when ALL parties signed */
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
    contract.audit.push({ type: 'LOCKED', role: 'system', details: { allSigned: true } });
  }
}

// ----------------------------- Endpoints -----------------------------

// INITIATE — Brand starts the contract
exports.initiate = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId, brand: brandInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false } = req.body;
    if (!brandId || !influencerId || !campaignId) return res.status(400).json({ message: 'brandId, influencerId, campaignId are required' });

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findOne({ campaignsId: campaignId }),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId })
    ]);
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    if (!brandDoc) return res.status(404).json({ message: 'Brand not found' });
    if (!influencerDoc) return res.status(404).json({ message: 'Influencer not found' });

    // OTHER (profiles + autocalcs)
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

    // Deliverables expansion + enforced handle + draft due
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

    // ADMIN defaults
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

    // Preview-only (no DB write)
    if (preview) {
      const tmp = new Contract({ ...base, status: 'draft' });
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin.legalTemplateText, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
      const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');
      return await renderPDFWithPuppeteer({ html, res, filename: `Contract-Preview-${campaignId}.pdf`, headerTitle, headerDate });
    }

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
      {
        $set: {
          isContracted: 1,
          contractId: contract.contractId,
          isAccepted: 0
        }
      }
    );
    return res.status(201).json({ message: 'Contract initialized successfully', contract });
  } catch (err) {
    console.error('initiate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// VIEWED
exports.viewed = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });
    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (['draft', 'sent'].includes(contract.status)) contract.status = 'viewed';
    await contract.save();
    await emitEvent(contract, 'VIEWED');
    res.json({ message: 'Marked viewed', contract });
  } catch (err) {
    console.error('viewed error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// INFLUENCER CONFIRM (does NOT change status)
exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, preview = false } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (['finalize', 'signing', 'locked'].includes(contract.status)) return res.status(400).json({ message: 'Contract is finalized; no further edits allowed' });

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
    await emitEvent(contract, 'PURPLE_CONFIRMED', { editedFields }); // legacy event name retained
    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } }
    );

    return res.json({ message: 'Influencer confirmation saved', contract });
  } catch (err) {
    console.error('influencerConfirm error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// BRAND CONFIRM
exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });
    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.status === 'locked') return res.status(400).json({ message: 'Contract is locked' });
    contract.confirmations = contract.confirmations || {};
    contract.confirmations.brand = { confirmed: true, byUserId: req.user?.id, at: new Date() };
    if (contract.status === 'sent') contract.status = 'viewed';
    await contract.save();
    await emitEvent(contract, 'BRAND_CONFIRMED');
    res.json({ message: 'Brand confirmation saved', contract });
  } catch (err) {
    console.error('brandConfirm error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ADMIN UPDATE (Admin + optional legal text bump)
exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (!req.user?.isAdmin) return res.status(403).json({ message: 'Forbidden: admin only' });
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
    return res.json({ message: 'Admin settings updated', contract });
  } catch (err) {
    console.error('adminUpdate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// FINALIZE (freeze for signatures)
exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });
    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (['finalize', 'signing', 'locked'].includes(contract.status)) return res.json({ message: 'Already finalized or beyond', contract });
    contract.status = 'finalize';
    await contract.save();
    await emitEvent(contract, 'FINALIZED');
    res.json({ message: 'Contract finalized for signatures', contract });
  } catch (err) {
    console.error('finalize error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// PREVIEW (always returns PDF stream)
exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });
    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const tz = tzOr(contract);
    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));

    const html = renderContractHTML({ contract, templateText: text });
    const tokens = buildTokenMap(contract);
    const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
    const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');

    return await renderPDFWithPuppeteer({
      html, res, filename: `Contract-${contractId}.pdf`, headerTitle, headerDate
    });
  } catch (err) {
    console.error('preview error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// VIEW/PRINT PDF (snapshot when locked; else live)
exports.viewContractPdf = async (req, res) => {
  let contract;
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });
    contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const tz = tzOr(contract);
    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(contract.admin?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));
    const html = renderContractHTML({ contract, templateText: text });

    const tokens = buildTokenMap(contract);
    const headerTitle = 'COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)';
    const headerDate = tokens['Agreement.EffectiveDateLong'] || formatDateTZ(new Date(), tz, 'Do MMMM YYYY');

    return await renderPDFWithPuppeteer({
      html, res, filename: `Contract-${contractId}.pdf`, headerTitle, headerDate
    });
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
      console.error('fallback PDFKit also failed:', e2);
      res.status(500).json({ error: 'Failed to render PDF' });
    }
  }
};

// SIGN (brand/influencer/admin). Locks when ALL signed.
exports.sign = async (req, res) => {
  try {
    const { contractId, role, name, email, effectiveDateOverride, signatureImageDataUrl, signatureImageBase64, signatureImageMime } = req.body;
    if (!contractId || !role) return res.status(400).json({ message: 'contractId and role are required' });
    if (!['brand', 'influencer', 'collabglam'].includes(role)) return res.status(400).json({ message: 'Invalid role' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.status === 'locked') return res.status(400).json({ message: 'Contract is locked' });

    if (['brand', 'influencer'].includes(role)) { requireInfluencerConfirmed(contract); }

    // optional signature image (<= 50KB)
    let sigImageDataUrl = null;
    if (signatureImageDataUrl || signatureImageBase64) {
      let mime = 'image/png'; let base64 = '';
      if (signatureImageDataUrl) {
        const m = String(signatureImageDataUrl).match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i);
        if (!m) return res.status(400).json({ message: 'Invalid signatureImageDataUrl. Must be data URL with base64.' });
        mime = m[1].toLowerCase(); base64 = m[3];
      } else {
        mime = (signatureImageMime || 'image/png').toLowerCase();
        if (!/^image\/(png|jpeg|jpg)$/.test(mime)) return res.status(400).json({ message: 'Unsupported signatureImageMime. Use image/png or image/jpeg.' });
        base64 = String(signatureImageBase64 || '');
        if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return res.status(400).json({ message: 'Invalid base64 payload for signature image.' });
      }
      const bytes = Buffer.from(base64, 'base64').length;
      if (bytes > 50 * 1024) return res.status(400).json({ message: 'Signature image must be <= 50 KB.' });
      sigImageDataUrl = `data:${mime};base64,${base64}`;
    }

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

    const campaignSync = {
      isContracted: 1,
      contractId: contract.contractId
    };
    if (contract.isAccepted === 1) campaignSync.isAccepted = 1;
    if (locked) campaignSync.contractLockedAt = contract.lockedAt || new Date();

    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: campaignSync }
    );

    return res.json({ message: (locked ? 'Signed & locked' : 'Signature recorded'), contract });
  } catch (err) {
    console.error('sign error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// BRAND UPDATE (Brand fields) — only AFTER influencer confirm; blocked once all signed
exports.brandUpdateFields = async (req, res) => {
  try {
    const { contractId, brandId, brandUpdates = {} } = req.body;
    if (!contractId || !brandId) return res.status(400).json({ message: 'contractId and brandId are required' });

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);
    requireInfluencerConfirmed(contract);

    const before = { brand: contract.brand?.toObject?.() || contract.brand };

    for (const k of Object.keys(brandUpdates)) {
      if (!ALLOWED_BRAND_KEYS.includes(k)) continue;
      if (k === 'goLive' && brandUpdates.goLive?.start) {
        const dd = clampDraftDue(brandUpdates.goLive.start);
        (contract.brand.deliverablesExpanded || []).forEach(d => { if (d.draftRequired) d.draftDueDate = dd; });
        contract.other.autoCalcs.firstDraftDue = dd;
      }
      if (k === 'requestedEffectiveDate') contract.requestedEffectiveDate = new Date(brandUpdates[k]);
      else if (k === 'requestedEffectiveDateTimezone') contract.requestedEffectiveDateTimezone = brandUpdates[k];
      else contract.brand[k] = brandUpdates[k];
    }

    // Enforce influencer handle on deliverables
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
    return res.json({ message: 'Brand fields updated', contract });
  } catch (err) {
    console.error('brandUpdateFields error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// INFLUENCER UPDATE (Influencer fields) — only AFTER influencer confirm; blocked once all signed
exports.influencerUpdateFields = async (req, res) => {
  try {
    const { contractId, influencerUpdates = {} } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
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
    return res.json({ message: 'Influencer fields updated', contract });
  } catch (err) {
    console.error('influencerUpdateFields error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

// BASIC READ
exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId } = req.body;
    if (!brandId || !influencerId) return res.status(400).json({ message: 'brandId and influencerId are required' });
    const contracts = await Contract.find({ brandId, influencerId }).sort({ createdAt: -1 });
    if (!contracts.length) return res.status(404).json({ message: 'No contracts found for that Brand & Influencer' });
    res.status(200).json({ contracts });
  } catch (err) {
    console.error('Error fetching contracts:', err);
    res.status(500).json({ error: err.message });
  }
};


// ADD THIS new controller
exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.status === 'locked') return res.status(400).json({ message: 'Contract is locked' });

    // basic permission sanity (optional, keep if you have auth)
    if (influencerId && String(influencerId) !== String(contract.influencerId)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    contract.isRejected = 1;
    contract.status = 'rejected';
    contract.audit.push({ type: 'REJECTED', role: 'influencer', details: { reason } });
    await contract.save();

    // mirror to campaign so lists hide it from "contracted"
    await Campaign.updateOne(
      { campaignsId: contract.campaignId },
      { $set: { isContracted: 0, contractId: null, isAccepted: 0 } }
    );

    return res.json({ message: 'Contract rejected', contract });
  } catch (err) {
    console.error('reject error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
