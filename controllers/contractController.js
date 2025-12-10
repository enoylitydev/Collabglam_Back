"use strict";

// ============================ Imports ============================
const PDFDocument = require('pdfkit');
const moment = require('moment-timezone');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// External models & template
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const MASTER_TEMPLATE = require('../template/ContractTemplate');
const Contract = require('../models/contract');
const { createAndEmit } = require('../utils/notifier'); // ← notifications

// Files
const TIMEZONES_FILE = path.join(__dirname, "..", "data", "timezones.json");
const CURRENCIES_FILE = path.join(__dirname, "..", "data", "currencies.json");

// ============================ Helpers ============================
function compactJoin(parts, sep = ", ") {
  return parts
    .filter(Boolean)
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(sep);
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInfluencerAddressLines(inf = {}) {
  const line1 = inf.addressLine1 || "";
  const line2 = inf.addressLine2 || "";
  const cityStateZip = compactJoin([
    compactJoin([inf.city, inf.state], ", "),
    inf.postalCode,
  ], " ");
  const country = inf.country || "";
  // Single-line, commas between major parts
  return compactJoin([line1, line2, cityStateZip, country], ", ");
}

function formatDateTZ(date, tz, fmt = "MMMM D, YYYY") {
  if (!date) return "";

  const d = date instanceof Date ? date : new Date(date);

  // If this is a "date-only" value (00:00:00.000Z), treat it as a pure calendar date
  const isDateOnlyUTC =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;

  if (isDateOnlyUTC) {
    return moment.utc(d).format(fmt);
  }

  // For true instants (timestamps, signatures, etc.), respect the contract timezone
  return tz ? moment(d).tz(tz).format(fmt) : moment(d).format(fmt);
}


function buildInfluencerAcceptanceTableHTML(inf = {}) {
  const cells = {
    legalName: esc(inf.legalName || ""),
    email: esc(inf.email || ""),
    phone: esc(inf.phone || ""),
    taxId: esc(inf.taxId || ""),
    addressLine1: esc(inf.addressLine1 || ""),
    addressLine2: esc(inf.addressLine2 || ""),
    city: esc(inf.city || ""),
    state: esc(inf.state || ""),
    postalCode: esc(inf.postalCode || ""),
    country: esc(inf.country || ""),
    notes: esc(inf.notes || ""),
  };
  return `
<table border="0" cellpadding="6" cellspacing="0" style="width:100%; border-collapse:collapse;">
  <tr><td style="width:35%; vertical-align:top;"><strong>Legal Name</strong></td><td style="vertical-align:top;">${cells.legalName}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Tax ID (optional)</strong></td><td style="vertical-align:top;">${cells.taxId}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Address Line 1</strong></td><td style="vertical-align:top;">${cells.addressLine1}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Address Line 2</strong></td><td style="vertical-align:top;">${cells.addressLine2}</td></tr>
  <tr><td style="vertical-align:top;"><strong>City</strong></td><td style="vertical-align:top;">${cells.city}</td></tr>
  <tr><td style="vertical-align:top;"><strong>State</strong></td><td style="vertical-align:top;">${cells.state}</td></tr>
  <tr><td style="vertical-align:top;"><strong>ZIP / Postal Code</strong></td><td style="vertical-align:top;">${cells.postalCode}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Country</strong></td><td style="vertical-align:top;">${cells.country}</td></tr>
  <tr><td style="vertical-align:top;"><strong>Notes (optional)</strong></td><td style="vertical-align:top;">${cells.notes}</td></tr>
</table>`.trim();
}

function respondOK(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}
function respondError(res, message = "Internal server error", status = 500, err = null) {
  if (err) console.error(message, err);
  else console.error(message);
  return res.status(status).json({ success: false, message });
}

const tzOr = (c, fallback = "America/Los_Angeles") =>
  c?.requestedEffectiveDateTimezone ||
  c?.effectiveDateTimezone ||
  c?.admin?.timezone ||
  fallback;

function loadTimezones() {
  try {
    return JSON.parse(fs.readFileSync(TIMEZONES_FILE, "utf8"));
  } catch (e) {
    console.warn("Failed to load timezones.json", e);
    return [];
  }
}
function loadCurrencies() {
  try {
    return JSON.parse(fs.readFileSync(CURRENCIES_FILE, "utf8"));
  } catch (e) {
    console.warn("Failed to load currencies.json", e);
    return {};
  }
}

function findTimezoneByValueOrUTC(key) {
  if (!key) return null;
  const list = loadTimezones();
  const q = String(key).toLowerCase();
  return (
    list.find(
      (t) =>
        (t.value && t.value.toLowerCase() === q) ||
        (t.abbr && t.abbr.toLowerCase() === q) ||
        (t.utc && t.utc.some((u) => (u || "").toLowerCase() === q)) ||
        (t.text && t.text.toLowerCase().includes(q))
    ) || null
  );
}

function legalTextToHTML(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let buffer = [];
  let consumedTitle = false;
  let inSchedules = false;
  let afterBOpen = false;

  const flushP = () => {
    if (!buffer.length) return;
    const html = esc(buffer.join("\n")).replace(/\n/g, "<br>");
    out.push(`<p>${html}</p>`);
    buffer = [];
  };
  const openAfterB = () => {
    if (!afterBOpen) {
      out.push('<div class="afterB">');
      afterBOpen = true;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushP();
      continue;
    }

    if (!consumedTitle && /Agreement/i.test(line) && line.length > 30) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      consumedTitle = true;
      continue;
    }

    const sch = line.match(/^Schedule\s+([A-Z])\s+–\s+(.+)$/);
    if (sch) {
      flushP();
      if (afterBOpen) {
        out.push("</div>");
        afterBOpen = false;
      }

      const letter = sch[1];
      inSchedules = true;

      if (letter >= "C") {
        out.push('<div class="afterB">');
        afterBOpen = true;
      }

      out.push(`<h3>Schedule ${esc(letter)} – ${esc(sch[2])}</h3>`);
      continue;
    }

    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push("<h2>Signatures</h2>");
      out.push('<div id="__SIG_PANEL__"></div>');
      continue;
    }

    const sec = line.match(/^(\d+)\.\s+(.+)$/);
    if (sec && !inSchedules) {
      flushP();
      out.push(`<h2><span class="secno">${esc(sec[1])}.</span> ${esc(sec[2])}</h2>`);
      continue;
    }
    if (sec && inSchedules) {
      flushP();
      out.push(`<p class="numli"><span class="marker">${esc(sec[1])}.</span> ${esc(sec[2])}</p>`);
      continue;
    }

    const letm = line.match(/^([a-z])\.\s+(.+)$/i);
    if (letm) {
      flushP();
      out.push(
        `<p class="subli"><span class="marker">${esc(letm[1])}.</span> ${esc(
          letm[2]
        )}</p>`
      );
      continue;
    }

    const bul = line.match(/^[-•]\s+(.+)$/);
    if (bul) {
      flushP();
      out.push(`<p class="bull"><span class="marker">•</span> ${esc(bul[1])}</p>`);
      continue;
    }

    buffer.push(rawLine);
  }

  flushP();
  if (!consumedTitle) out.unshift("<h1>Master Brand–Influencer Agreement</h1>");
  if (afterBOpen) out.push("</div>");
  return out.join("\n");
}

function getBrandSelectedEffectiveDate(contract) {
  return contract?.requestedEffectiveDate
    || contract?.brand?.requestedEffectiveDate
    || null;
}

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);
  const roles = [
    {
      key: "brand",
      label: `Brand: ${esc(
        contract.other?.brandProfile?.legalName || contract.brandName || "—"
      )}`,
    },
    {
      key: "influencer",
      label: `Influencer: ${esc(
        contract.other?.influencerProfile?.legalName || contract.influencerName || "—"
      )}`,
    },
    { key: "collabglam", label: "CollabGlam: CollabGlam, Inc." },
  ];
  const blocks = roles
    .map(({ key, label }) => {
      const s = contract.signatures?.[key] || {};
      const when = s.at ? formatDateTZ(s.at, tz, "YYYY-MM-DD HH:mm z") : "";
      const img = s.sigImageDataUrl
        ? `<img class="sigimg" alt="Signature image" src="${esc(
          s.sigImageDataUrl
        )}">`
        : "";
      const meta = s.signed
        ? `<div class="sigmeta">SIGNED by ${esc(s.name || "")}${s.email ? ` &lt;${esc(s.email)}&gt;` : ""
        }${when ? ` on ${esc(when)}` : ""}</div>`
        : `<div class="sigmeta muted">Pending signature</div>`;
      return `
      <div class="signature-block">
        <div class="sigrole">${label}</div>
        ${img}
        ${meta}
      </div>`;
    })
    .join("");
  return `<div class="signatures">${blocks}</div>`;
}

// --- Business-day utilities ---
function businessDaysShift(date, delta) {
  let d = new Date(date || Date.now());
  let remaining = Math.abs(Number(delta) || 0);
  const dir = delta >= 0 ? -1 : 1; // >=0 move backwards; <0 move forwards
  while (remaining > 0) {
    d.setDate(d.getDate() + dir);
    const day = d.getDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return d;
}
function clampDraftDue(goLiveStart, now = new Date()) {
  const ideal = businessDaysShift(goLiveStart || now, 7); // 7 business days before go-live
  const floor = businessDaysShift(now, -2); // at least +2 business days from now
  return ideal < floor ? floor : ideal;
}

const fmtBool = (v) => (v ? "Yes" : "No");
const fmtList = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).join(", ") : "");

// --- Deliverables normalization ---
function normalizeDeliverable(d = {}, opts = {}) {
  const nd = { ...d };

  // Prefer canonical *Enabled fields, but accept legacy aliases too
  nd.whitelistingEnabled = d.whitelistingEnabled ?? d.whitelisting ?? false;
  nd.sparkAdsEnabled = d.sparkAdsEnabled ?? d.sparkAds ?? false;

  // Enforce handle list with server truth
  if (opts.enforcedHandle) {
    nd.handles = [opts.enforcedHandle];
  } else if (!Array.isArray(nd.handles)) {
    nd.handles = [];
  }

  // Derived fallbacks
  if (nd.draftRequired && !nd.draftDueDate) nd.draftDueDate = opts.draftDue || null;
  if (nd.revisionRoundsIncluded === undefined)
    nd.revisionRoundsIncluded = opts.defaultRevRounds ?? 1;
  if (nd.additionalRevisionFee === undefined)
    nd.additionalRevisionFee = opts.extraRevisionFee ?? 0;

  // ✅ SANITIZE liveRetentionMonths FOR NUMBER SCHEMA
  if (
    nd.liveRetentionMonths === "-" ||
    nd.liveRetentionMonths === "" ||
    nd.liveRetentionMonths === null ||
    nd.liveRetentionMonths === undefined
  ) {
    // treat "-" and empty as "no retention set"
    nd.liveRetentionMonths = undefined;
  } else if (typeof nd.liveRetentionMonths === "string") {
    const parsed = Number(nd.liveRetentionMonths);
    nd.liveRetentionMonths = Number.isFinite(parsed) ? parsed : undefined;
  }

  return nd;
}

function normalizeDeliverablesArray(arr = [], opts = {}) {
  return (Array.isArray(arr) ? arr : []).map((d) => normalizeDeliverable(d, opts));
}

function renderDeliverablesTable(delivs = [], tz) {
  if (!delivs.length) return '<p class="muted">No deliverables defined.</p>';

  const ensureAt = (s) => {
    const t = (s || "").trim();
    return t ? (t.startsWith("@") ? t : `@${t}`) : "";
  };

  const fmtHandles = (arr) => {
    const list = Array.isArray(arr) ? arr.map(ensureAt).filter(Boolean) : [];
    return list.length ? fmtList(list) : "";
  };

  const fmtRetention = (d) => {
    if (d.liveRetentionMonths !== undefined && d.liveRetentionMonths !== null) {
      const m = Number(d.liveRetentionMonths);
      return Number.isFinite(m) ? `${m} month${m === 1 ? "" : "s"}` : "";
    }
    if (d.minLiveHours !== undefined && d.minLiveHours !== null) {
      const h = Number(d.minLiveHours);
      return Number.isFinite(h) ? `${h} hour${h === 1 ? "" : "s"}` : "";
    }
    return "";
  };

  const fmtRevisionsIncluded = (d) => {
    const v = d.revisionRoundsIncluded ?? d.revisionsIncluded;
    return v === 0 || v > 0 ? String(v) : "";
  };

  const fmtExtraRevisionFee = (d) => {
    const v = d.additionalRevisionFee;
    return v === 0 || v ? String(v) : "";
  };

  const row = (label, val, { keepWhenEmpty = false } = {}) =>
    keepWhenEmpty || (val !== "" && val !== null && val !== undefined)
      ? `<tr><td><strong>${label}</strong></td><td>${val}</td></tr>`
      : "";

  const colgroup = `
    <colgroup>
      <col style="width:30%;">  <!-- Field -->
      <col style="width:70%;">  <!-- Value -->
    </colgroup>
  `.trim();

  const groups = delivs
    .map((d, i) => {
      const idx = i + 1;

      const type = esc(d.type || "");
      const qty = d.quantity === 0 || d.quantity ? String(d.quantity) : "";
      const format = esc(d.format || "");
      const durSec = d.durationSec === 0 || d.durationSec ? String(d.durationSec) : "";

      const pwStart = d?.postingWindow?.start
        ? formatDateTZ(d.postingWindow.start, tz)
        : "";
      const pwEnd = d?.postingWindow?.end
        ? formatDateTZ(d.postingWindow.end, tz)
        : "";
      const posting = `${pwStart}${pwStart && pwEnd ? " – " : ""}${pwEnd}`;

      const draftDue = d?.draftDueDate ? formatDateTZ(d.draftDueDate, tz) : "";
      const draftCell = `${fmtBool(d.draftRequired)}${draftDue ? `<br><span class="muted">Due: ${draftDue}</span>` : ""
        }`;

      const revisionsInc = fmtRevisionsIncluded(d);
      const extraRevFee = fmtExtraRevisionFee(d);
      const retention = fmtRetention(d);

      const tags = esc(fmtList(d?.tags));
      const handles = esc(fmtHandles(d?.handles));
      const captions = esc(d.captions || "");
      const links = Array.isArray(d?.links) && d.links.length ? fmtList(d.links) : "";
      const disclosures = esc(d.disclosures || "");

      const whitelist = d.whitelistingEnabled ?? d.whitelisting ?? false;
      const sparkAds = d.sparkAdsEnabled ?? d.sparkAds ?? false;
      const wlSpark = `${fmtBool(whitelist)} / ${fmtBool(sparkAds)}`;

      const header = `
      <tr class="deliv-head">
        <th colspan="2">Deliverable ${idx}</th>
      </tr>
    `;

      const rowsHtml = [
        row("Type", type, { keepWhenEmpty: true }),
        row("Quantity", qty, { keepWhenEmpty: true }),
        row("Format", format, { keepWhenEmpty: true }),
        row("Duration (sec)", durSec),
        row("Posting Window", posting, { keepWhenEmpty: true }),
        row("Draft Required / Due", draftCell, { keepWhenEmpty: true }),
        row("Revisions Included", revisionsInc),
        row("Extra Revision Fee", extraRevFee),
        row("Live Retention", retention),
        row("Tags", tags),
        row("Handles", handles),
        row("Captions", captions),
        row("Links", links),
        row("Disclosures", disclosures),
        row("Whitelist / Spark", wlSpark, { keepWhenEmpty: true }),
      ].join("");

      return `
      <tbody class="block-avoid">
        ${header}
        ${rowsHtml}
      </tbody>
    `;
    })
    .join("");

  return `
    <table class="table--condensed deliverables-table">
      ${colgroup}
      <thead>
        <tr><th>Field</th><th>Value</th></tr>
      </thead>
      ${groups}
    </table>
  `.trim();
}

function renderUsageBundleTokens(ub = {}, currency = "USD") {
  const geos = fmtList(ub.geographies);
  const spendCap =
    ub.spendCap || ub.spendCap === 0
      ? `${Number(ub.spendCap).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`
      : "—";
  const summary = `
    <p>
      <strong>Type:</strong> ${esc(ub.type || "Organic")} |
      <strong>Duration:</strong> ${ub.durationMonths ?? "—"} months |
      <strong>Geographies:</strong> ${geos || "—"} |
      <strong>Derivative Edits:</strong> ${fmtBool(ub.derivativeEditsAllowed)} |
      <strong>Spend Cap:</strong> ${spendCap}
      ${ub.audienceRestrictions
      ? `<br><strong>Audience Restrictions:</strong> ${esc(ub.audienceRestrictions)}`
      : ""
    }
    </p>`.trim();

  const table = `
    <table>
      <thead>
        <tr><th>Type</th><th>Duration (months)</th><th>Geographies</th><th>Derivative Edits</th><th>Spend Cap</th><th>Audience Restrictions</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(ub.type || "Organic")}</td>
          <td>${ub.durationMonths ?? "—"}</td>
          <td>${geos || "—"}</td>
          <td>${fmtBool(ub.derivativeEditsAllowed)}</td>
          <td>${spendCap}</td>
          <td>${esc(ub.audienceRestrictions || "—")}</td>
        </tr>
      </tbody>
    </table>`.trim();

  return {
    "Usage.LicenseType": ub.type || "Organic",
    "Usage.Type": ub.type || "Organic",
    "Usage.DurationMonths": ub.durationMonths ?? "",
    "Usage.Geographies": geos,
    "Usage.DerivativeEditsAllowed": fmtBool(ub.derivativeEditsAllowed),
    "Usage.SpendCap": spendCap,
    "Usage.AudienceRestrictions": ub.audienceRestrictions || "",
    "Usage.BundleSummary": summary,
    "Usage.BundleTableHTML": table,
  };
}

// ============================ Token Plumbing ============================
function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const brandProfile = contract.other?.brandProfile || {};
  const inflProfile = contract.other?.influencerProfile || {};
  const infData = contract.influencer || {};

  // Normalize influencer acceptance fields
  const influencerFields = {
    legalName: infData.legalName || inflProfile.legalName || contract.influencerName || "",
    contactName: inflProfile.contactName || contract.influencerName || "",
    email: infData.email || inflProfile.email || "",
    phone: infData.phone || "",
    taxId: infData.taxId || "",
    addressLine1: infData.addressLine1 || "",
    addressLine2: infData.addressLine2 || "",
    city: infData.city || "",
    state: infData.state || "",
    postalCode: infData.postalCode || infData.zip || "",
    country: infData.country || inflProfile.country || "",
    notes: infData.notes || "",
    legacyAddress: inflProfile.address || contract.influencerAddress || "",
  };

  const addressFormatted =
    formatInfluencerAddressLines(influencerFields) || influencerFields.legacyAddress || "";

  const acceptanceTableHTML = buildInfluencerAcceptanceTableHTML(influencerFields);

  const b = contract.brand || {};
  const admin = contract.admin || {};
  const channels = (b.platforms || []).join(", ");
  const displayDate = getBrandSelectedEffectiveDate(contract) || contract.effectiveDate || null;

  const tokens = {
    // Agreement dates
    "Agreement.EffectiveDate": formatDateTZ(displayDate, tz),

    "Agreement.EffectiveDateLong": displayDate ? formatDateTZ(displayDate, tz, "Do MMMM YYYY") : "",

    // Brand
    "Brand.LegalName": brandProfile.legalName || contract.brandName || "",
    "Brand.Address": brandProfile.address || contract.brandAddress || "",
    "Brand.ContactName": brandProfile.contactName || "",

    // Influencer (populated)
    "Influencer.LegalName": influencerFields.legalName,
    "Influencer.ContactName": influencerFields.contactName,
    "Influencer.Email": influencerFields.email,
    "Influencer.Phone": influencerFields.phone,
    "Influencer.TaxId": influencerFields.taxId,
    "Influencer.AddressLine1": influencerFields.addressLine1,
    "Influencer.AddressLine2": influencerFields.addressLine2,
    "Influencer.City": influencerFields.city,
    "Influencer.State": influencerFields.state,
    "Influencer.PostalCode": influencerFields.postalCode,
    "Influencer.Country": influencerFields.country,
    "Influencer.Notes": influencerFields.notes,
    "Influencer.AddressFormatted": addressFormatted,
    // Keep legacy token working
    "Influencer.Address": addressFormatted,

    // Injected HTML block
    "Influencer.AcceptanceDetailsTableHTML": acceptanceTableHTML,

    // CollabGlam & admin
    "CollabGlam.Address": "548 Market St, San Francisco, CA 94104, USA",
    "CollabGlam.SignatoryName": admin.collabglamSignatoryName || "",
    "Time.StandardTimezone": admin.timezone || tz,
    "Time.StandardJurisdiction": admin.jurisdiction || "USA",
    "Arbitration.Seat": admin.arbitrationSeat || "San Francisco, CA",
    "Payments.FXSource": admin.fxSource || "ECB",

    // Campaign
    "Campaign.Title": b.campaignTitle || "",
    "Campaign.Territory": "Worldwide",
    "Campaign.Channels": channels,
    "Campaign.Platforms": channels,

    "Campaign.Timeline.GoLiveWindowStart": b?.goLive?.start
      ? formatDateTZ(b.goLive.start, tz)
      : "",
    "Campaign.Timeline.GoLiveWindowEnd": b?.goLive?.end
      ? formatDateTZ(b.goLive.end, tz)
      : "",

    "Approval.BrandResponseWindow": admin.defaultBrandReviewWindowBDays ?? 2,
    "Approval.RoundsIncluded": b.revisionsIncluded ?? 1,
    "Approval.AdditionalRevisionFee": admin.extraRevisionFee ?? 0,
    "Comp.TotalFee": b.totalFee ?? 0,
    "Comp.Currency": b.currency || "USD",
    "Comp.MilestoneSplit": b.milestoneSplit || "50/50",
    "Comp.NetTerms": "Net 15",
    "Comp.PaymentMethod": "Escrow via CollabGlam",
    "Exclusivity.WindowHoursAfterPost": 0,
    "ProductShipment.RequiredDate": b?.deliverablesExpanded?.[0]?.postingWindow?.start
      ? formatDateTZ(b.deliverablesExpanded[0].postingWindow.start, tz)
      : "",
    "ProductShipment.ReturnRequired": "No",

    "SOW.DeliverablesTableHTML": renderDeliverablesTable(
      b.deliverablesExpanded || [],
      tz
    ),
  };

  Object.assign(
    tokens,
    renderUsageBundleTokens(b.usageBundle || {}, tokens["Comp.Currency"]) || {}
  );

  // Per-deliverable tokens
  const delivs = Array.isArray(b.deliverablesExpanded)
    ? b.deliverablesExpanded
    : [];
  const setDeliv = (key, val) => {
    tokens[key] = val === undefined || val === null ? "" : String(val);
  };
  delivs.forEach((d, i) => {
    const idx0 = i;
    const idx1 = i + 1;
    const wl = d.whitelistingEnabled ?? d.whitelisting ?? false;
    const sp = d.sparkAdsEnabled ?? d.sparkAds ?? false;

    const baseKeys = [
      ["Type", d?.type],
      ["Quantity", d?.quantity],
      ["DurationSec", d?.durationSec],
      [
        "PostingWindowStart",
        d?.postingWindow?.start ? formatDateTZ(d.postingWindow.start, tz) : "",
      ],
      [
        "PostingWindowEnd",
        d?.postingWindow?.end ? formatDateTZ(d.postingWindow.end, tz) : "",
      ],
      ["DraftRequired", fmtBool(d?.draftRequired)],
      ["DraftDueDate", d?.draftDueDate ? formatDateTZ(d.draftDueDate, tz) : ""],
      ["RevisionRoundsIncluded", d?.revisionRoundsIncluded ?? ""],
      ["AdditionalRevisionFee", d?.additionalRevisionFee ?? ""],
      ["LiveRetentionMonths", d?.liveRetentionMonths ?? ""],
      [
        "TagsHandles",
        [fmtList(d?.tags), "@" + fmtList(d?.handles)].filter(Boolean).join(" / "),
      ],
      ["WhitelistEnabled", fmtBool(wl)],
      ["SparkAdsEnabled", fmtBool(sp)],
    ];
    baseKeys.forEach(([leaf, val]) => {
      setDeliv(`Deliverables[${idx0}].${leaf}`, val);
      setDeliv(`Deliverables.${idx0}.${leaf}`, val);
      setDeliv(`Deliverables[${idx1}].${leaf}`, val);
      setDeliv(`Deliverables.${idx1}.${leaf}`, val);
    });
  });
  tokens["Deliverables.Count"] = String(delivs.length);

  return tokens;
}

function renderTemplate(templateText, tokenMap) {
  return (templateText || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawKey) => {
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, "");
    const v = tokenMap[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    { key: "[[SOW.DeliverablesTableHTML]]", html: tokens["SOW.DeliverablesTableHTML"] || "" },
    { key: "[[Usage.BundleSummary]]", html: tokens["Usage.BundleSummary"] || "" },
    { key: "[[Usage.BundleTableHTML]]", html: tokens["Usage.BundleTableHTML"] || "" },
    {
      key: "[[Influencer.AcceptanceDetailsTableHTML]]",
      html: tokens["Influencer.AcceptanceDetailsTableHTML"] || "",
    },
  ];

  let out = legalHTML;
  for (const { key, html } of swaps) {
    if (!html) continue;
    out = out.replaceAll(key, html);
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = new RegExp(`<p>\\s*${escKey}\\s*<\\/p>`, "g");
    out = out.replace(wrapped, html);
  }
  return out;
}

function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);
  legalHTML = legalHTML.replace(
    '<div id="__SIG_PANEL__"></div>',
    signaturePanelHTML(contract)
  );
  legalHTML = injectTrustedHtmlPlaceholders(legalHTML, contract);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    /* --- Page & base typography --- */
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 10.5pt; line-height: 1.35; }
    main { max-width: 100%; }
    img, table { max-width: 100%; }

    /* --- Headings & paragraphs (print-friendly) --- */
    h1, h2, h3 { font-weight: 700; color: #000; margin: 10pt 0 6pt; }
    h1 { font-size: 13pt; text-align: center; text-transform: uppercase; letter-spacing: .2px; }
    h2 { font-size: 11pt; }
    h3 { font-size: 10.5pt; }

    /* Only h1 strictly avoids breaking; allow h2/h3 to flow to reduce large gaps */
    h1 { page-break-after: avoid; break-after: avoid-page; }
    h2, h3 { page-break-after: auto; break-after: auto; }

    p { margin: 0 0 5pt; text-align: justify; color: #000; orphans: 3; widows: 3; }

    /* --- List-like paragraphs produced by legalTextToHTML --- */
    .numli, .subli, .bull { text-align: justify; padding-left: 18pt; text-indent: -18pt; margin-bottom: 4pt; }
    .marker { display: inline-block; width: 18pt; }
    .secno { font-weight: 700; }
    .muted { color: #444; }

    /* --- Signature blocks --- */
    .signatures { margin: 10pt 0 6pt; display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
    .signature-block { border: 1px solid #000; padding: 8pt; break-inside: avoid; page-break-inside: avoid; }
    .sigrole { font-weight: 700; margin-bottom: 4pt; }
    .sigimg { display: block; max-height: 60pt; max-width: 100%; margin: 0 0 6pt; }
    .sigmeta { font-size: 9.5pt; color: #000; }

    /* --- Tables: fixed layout + wrapping + repeated headers on each page --- */
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9.5pt; margin: 6pt 0; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th, td {
      border: 1px solid #000;
      padding: 3pt 4pt;
      vertical-align: top;
      word-break: break-word;
      overflow-wrap: anywhere;
      hyphens: auto;
    }
    th { text-align: left; background: #fff; font-weight: 700; }
    tr:nth-child(even) td { background: #fafafa; }

    /* --- Condensed tables (e.g., Deliverables) --- */
    .table--condensed th, .table--condensed td { padding: 3pt 3.5pt; font-size: 9pt; line-height: 1.3; }
    .deliverables-table th, .deliverables-table td { white-space: normal; }

    /* --- Keep post-Section B schedules tidy (style only) --- */
    .afterB p { margin-bottom: 5pt; }

    /* --- Avoid ugly breaks around only the blocks that must not split --- */
    .block-avoid, .signature-block { break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <main>${legalHTML}</main>
</body>
</html>`;
}

let sharedBrowserPromise = null;

async function launchBrowserOnce() {
  const baseOptions = {
    headless: true,
    dumpio: true, // log Chrome stdout/stderr -> super helpful to debug
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      // These two can help in very constrained Docker environments:
      // "--single-process",
      // "--no-zygote",
    ],
    timeout: 60000, // ⬅️ increase from default 30s
  };

  const execPath = process.env.CHROME_EXECUTABLE_PATH;

  if (execPath && fs.existsSync(execPath)) {
    console.log("[PDF] Using CHROME_EXECUTABLE_PATH:", execPath);
    try {
      return await puppeteer.launch({ ...baseOptions, executablePath: execPath });
    } catch (err) {
      console.error("[PDF] Launch with CHROME_EXECUTABLE_PATH failed, falling back to default Chromium", err);
    }
  } else if (execPath) {
    console.warn("[PDF] CHROME_EXECUTABLE_PATH does not exist:", execPath);
  } else {
    console.log("[PDF] No CHROME_EXECUTABLE_PATH set, using Puppeteer's default Chromium.");
  }

  // Fallback: Puppeteer’s own Chromium
  return await puppeteer.launch(baseOptions);
}

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const b = await sharedBrowserPromise;
      if (b && b.isConnected && b.isConnected()) return b;
    } catch (_) {
      // broken promise -> reset
    }
    sharedBrowserPromise = null;
  }

  sharedBrowserPromise = (async () => {
    const browser = await launchBrowserOnce();
    browser.on("disconnected", () => {
      console.warn("[PDF] Browser disconnected, resetting shared instance");
      sharedBrowserPromise = null;
    });
    return browser;
  })();

  return sharedBrowserPromise;
}

// Close shared browser cleanly on process exit
process.on("exit", async () => {
  try {
    if (sharedBrowserPromise) {
      const b = await sharedBrowserPromise;
      if (b && b.close) await b.close();
    }
  } catch (_) {}
});

async function renderPDFWithPuppeteer({
  html,
  res,
  filename = "Contract.pdf",
  headerTitle,
  headerDate,
}) {
  let page;

  const headerTemplate = `
    <style>
      .pdf-h {
        font-family: "Times New Roman", Times, serif;
        font-size: 9pt;
        width: 100%;
        padding: 4mm 10mm;
        text-align: center;
      }
      .pdf-h .title { font-weight: bold; }
      .pdf-h .date { margin-top: 1mm; }
    </style>
    <div class="pdf-h">
      <div class="title">${esc(headerTitle || "")}</div>
      <div class="date">Effective Date: ${esc(headerDate || "")}</div>
    </div>`;

  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();

    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0" });

    const needsLandscape = /data-require-landscape="1"/i.test(html);

    const pdf = await page.pdf({
      preferCSSPageSize: true,
      format: "A4",
      landscape: needsLandscape,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate: "<div></div>",
      margin: { top: "18mm", bottom: "14mm", left: "16mm", right: "16mm" },
      scale: 1,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    return res.end(pdf);
  } catch (e) {
    console.error("Puppeteer PDF failed", e);

    // ---------- Hard fallback: use PDFKit so the user still gets something ----------
    try {
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=${filename}`);

      doc.pipe(res);

      doc
        .fontSize(18)
        .text(headerTitle || "Master Brand–Influencer Agreement", {
          align: "center",
        })
        .moveDown();

      // crude HTML strip just for fallback readability
      const plain = String(html || "")
        .replace(/<\/(p|div|h1|h2|h3|br)>/gi, "\n\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\n{3,}/g, "\n\n");

      const paragraphs = plain.split(/\n\s*\n/);
      paragraphs.forEach((p, idx) => {
        doc.text(p.trim(), { align: "justify" });
        if (idx < paragraphs.length - 1) doc.moveDown();
      });

      doc.end();
      return;
    } catch (fallbackErr) {
      console.error("PDFKit fallback also failed", fallbackErr);
      return respondError(res, "PDF generation failed", 500, fallbackErr);
    }
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {}
    }
  }
}

async function emitEvent(contract, event, details = {}) {
  contract.audit = contract.audit || [];
  contract.audit.push({ type: event, role: "system", details });
  await contract.save();
}

function flatten(obj, prefix = "") {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date))
      Object.assign(out, flatten(v, p));
    else out[p] = v;
  });
  return out;
}
function computeEditedFields(prevObj, nextObj, whitelist) {
  const prev = flatten(prevObj || {});
  const next = flatten(nextObj || {});
  const fields = new Set();
  for (const key of Object.keys({ ...prev, ...next })) {
    const topKey = key.split(".")[0];
    if (whitelist && !whitelist.includes(topKey)) continue;
    const a = prev[key];
    const b = next[key];
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
  contract.audit.push({ type: "EDITED", role: by, details: { fields } });
}
function requireNotLocked(contract) {
  if (contract.status === "locked" || contract.lockedAt) {
    const e = new Error("Contract is locked and cannot be edited");
    e.status = 400;
    throw e;
  }
}
function bothSigned(contract) {
  const s = contract?.signatures || {};
  return Boolean(s?.brand?.signed && s?.influencer?.signed && s?.collabglam?.signed);
}
function requireNoEditsAfterBothSigned(contract) {
  if (bothSigned(contract)) {
    const e = new Error("All parties have signed; no further edits are allowed");
    e.status = 400;
    throw e;
  }
}
function requireInfluencerConfirmed(contract) {
  if (!contract.confirmations?.influencer?.confirmed) {
    const e = new Error("Influencer must accept the contract first");
    e.status = 400;
    throw e;
  }
}
function requireBrandConfirmed(contract) {
  if (!contract.confirmations?.brand?.confirmed) {
    const e = new Error("Brand must accept the contract first");
    e.status = 400;
    throw e;
  }
}
// NEW: both must be confirmed before any signing
function requireBothConfirmed(contract) {
  if (!contract.confirmations?.influencer?.confirmed) {
    const e = new Error("Influencer must accept before signing is allowed");
    e.status = 400;
    throw e;
  }
  if (!contract.confirmations?.brand?.confirmed) {
    const e = new Error("Brand must accept before signing is allowed");
    e.status = 400;
    throw e;
  }
}

// (kept for backward compatibility but unused in new flow)
function requireNoPartyConfirmations(_contract) {
  const e = new Error("Edits are allowed only after the influencer accepts");
  e.status = 400;
  throw e;
}

function resolveEffectiveDate(contract) {
  if (contract.effectiveDateOverride) return contract.effectiveDateOverride;
  const dates = [
    contract.signatures?.brand?.at,
    contract.signatures?.influencer?.at,
    contract.signatures?.collabglam?.at,
  ]
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  if (!dates.length) return undefined;
  return new Date(Math.max(...dates));
}

function maybeLockIfReady(contract) {
  if (bothSigned(contract)) {
    contract.effectiveDate =
      contract.effectiveDateOverride
      || getBrandSelectedEffectiveDate(contract)
      || resolveEffectiveDate(contract)
      || new Date();
    contract.effectiveDateTimezone = tzOr(contract);

    const tokens = buildTokenMap(contract);
    const templateText = contract.admin?.legalTemplateText || MASTER_TEMPLATE;
    const rendered = renderTemplate(templateText, tokens);

    contract.templateVersion = contract.admin?.legalTemplateVersion || 1;
    contract.templateTokensSnapshot = tokens;
    contract.renderedTextSnapshot = rendered;

    contract.lockedAt = new Date();
    contract.status = "locked";
    contract.audit = contract.audit || [];
    contract.audit.push({ type: "LOCKED", role: "system", details: { allSigned: true } });
  }
}

function assertRequired(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === "");
  if (missing.length) {
    const e = new Error(`Missing required field(s): ${missing.join(", ")}`);
    e.status = 400;
    throw e;
  }
}

async function buildResendChildContract(
  parent,
  {
    brandInput = {},
    requestedEffectiveDate,
    requestedEffectiveDateTimezone,
    userEmail,
    asPlain = false,
  }
) {
  // Normalize deliverables
  let deliverablesExpanded =
    Array.isArray(brandInput.deliverablesExpanded) && brandInput.deliverablesExpanded.length
      ? brandInput.deliverablesExpanded
      : parent.brand?.deliverablesExpanded || [];

  // Enforce handle from current influencer doc
  const influencerDoc = await Influencer.findOne(
    { influencerId: parent.influencerId },
    "handle"
  ).lean();
  const enforcedHandle = influencerDoc?.handle || "";

  const draftDue = clampDraftDue(
    brandInput.goLive?.start || parent.brand?.goLive?.start || new Date()
  );

  deliverablesExpanded = normalizeDeliverablesArray(deliverablesExpanded, {
    enforcedHandle,
    draftDue,
    defaultRevRounds: parent.brand?.revisionsIncluded ?? 1,
    extraRevisionFee: parent.admin?.extraRevisionFee ?? 0,
  });

  const admin = {
    ...(parent.admin || {}),
    legalTemplateText: parent.admin?.legalTemplateText || MASTER_TEMPLATE,
  };

  const other = {
    ...(parent.other || {}),
    influencerProfile: {
      ...(parent.other?.influencerProfile || {}),
      handle: enforcedHandle,
    },
    autoCalcs: {
      ...(parent.other?.autoCalcs || {}),
      firstDraftDue: draftDue,
      tokensExpandedAt: new Date(),
    },
  };

  const nextBrand = {
    ...(parent.brand || {}),
    ...brandInput,
    deliverablesExpanded,
  };

  const baseChild = {
    brandId: parent.brandId,
    influencerId: parent.influencerId,
    campaignId: parent.campaignId,

    status: "sent",
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
    currency: brandInput.currency || nextBrand.currency || "USD",

    brandName: parent.brandName,
    brandAddress: parent.brandAddress,
    influencerName: parent.influencerName,
    influencerAddress: parent.influencerAddress,
    influencerHandle: enforcedHandle,

    requestedEffectiveDate: requestedEffectiveDate
      ? new Date(requestedEffectiveDate)
      : parent.requestedEffectiveDate || undefined,
    requestedEffectiveDateTimezone:
      requestedEffectiveDateTimezone || parent.requestedEffectiveDateTimezone || admin.timezone,

    resendIteration: (parent.resendIteration || 0) + 1,
    resendOf: parent.contractId,
  };

  if (asPlain) {
    return baseChild;
  }

  const child = new Contract(baseChild);
  child.audit = child.audit || [];
  child.audit.push({
    type: "RESENT_CHILD_CREATED",
    role: "system",
    details: { from: parent.contractId, by: userEmail || "system" },
  });
  return child;
}

// ============================ Controllers ============================

exports.initiate = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      brand: brandInput = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
      isResend = false,
      resendOf,
    } = req.body;

    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findOne({ campaignsId: campaignId }),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId }),
    ]);
    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const other = {
      brandProfile: {
        legalName: brandDoc.legalName || brandDoc.name || "",
        address: brandDoc.address || "",
        contactName: brandDoc.contactName || brandDoc.ownerName || "",
        email: brandDoc.email || "",
        country: brandDoc.country || "",
      },
      influencerProfile: {
        legalName: influencerDoc.legalName || influencerDoc.name || "",
        address: influencerDoc.address || "",
        contactName: influencerDoc.contactName || influencerDoc.name || "",
        email: influencerDoc.email || "",
        country: influencerDoc.country || "",
        handle: influencerDoc.handle || "",
      },
      autoCalcs: {},
    };

    const admin = {
      timezone: campaign?.timezone || "America/Los_Angeles",
      jurisdiction: "USA",
      arbitrationSeat: "San Francisco, CA",
      fxSource: "ECB",
      defaultBrandReviewWindowBDays: 2,
      extraRevisionFee: 0,
      escrowAMLFlags: "",
      legalTemplateVersion: 1,
      legalTemplateText: MASTER_TEMPLATE,
      legalTemplateHistory: [
        {
          version: 1,
          text: MASTER_TEMPLATE,
          updatedAt: new Date(),
          updatedBy: req.user?.email || "system",
        },
      ],
    };

    // Default deliverables aligned to spec
    let deliverablesExpanded =
      Array.isArray(brandInput.deliverablesExpanded) && brandInput.deliverablesExpanded.length
        ? brandInput.deliverablesExpanded
        : [
          {
            type: "Video",
            quantity: 1,
            format: "MP4",
            durationSec: 60,
            postingWindow: {
              start: brandInput.goLive?.start,
              end: brandInput.goLive?.end,
            },
            draftRequired: (brandInput.revisionsIncluded ?? 1) > 0,
            minLiveHours: 720,
            revisionRoundsIncluded: brandInput.revisionsIncluded ?? 1,
            additionalRevisionFee: admin.extraRevisionFee ?? 0,
            tags: [],
            handles: [],
            captions: "",
            links: [],
            disclosures: "#ad",
            whitelistingEnabled: false,
            sparkAdsEnabled: false,
          },
        ];

    const draftDue = clampDraftDue(brandInput.goLive?.start || new Date());
    const enforcedHandle = influencerDoc.handle || "";

    deliverablesExpanded = normalizeDeliverablesArray(deliverablesExpanded, {
      enforcedHandle,
      draftDue,
      defaultRevRounds: brandInput.revisionsIncluded ?? 1,
      extraRevisionFee: admin.extraRevisionFee ?? 0,
    });

    other.autoCalcs.firstDraftDue = draftDue;
    other.autoCalcs.tokensExpandedAt = new Date();

    const base = {
      brandId,
      influencerId,
      campaignId,
      brand: { ...brandInput, deliverablesExpanded },
      influencer: {},
      other,
      admin,
      confirmations: { brand: { confirmed: false }, influencer: { confirmed: false } },
      requestedEffectiveDate: requestedEffectiveDate || undefined,
      requestedEffectiveDateTimezone:
        requestedEffectiveDateTimezone || admin.timezone,
      brandName: other.brandProfile.legalName,
      brandAddress: other.brandProfile.address,
      influencerName: other.influencerProfile.legalName,
      influencerAddress: other.influencerProfile.address,
      influencerHandle: other.influencerProfile.handle,
    };

    // Preview (non-resend)
    if (preview && !isResend) {
      const tmp = { ...base, status: "draft" };
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin.legalTemplateText, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle =
        "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate = tokens["Agreement.EffectiveDateLong"] || "Pending";

      return await renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Preview-${campaignId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    // RESEND path inside initiate
    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, "resendOf contract not found", 404);

      if (
        String(parent.brandId) !== String(brandId) ||
        String(parent.influencerId) !== String(influencerId) ||
        String(parent.campaignId) !== String(campaignId)
      ) {
        return respondError(
          res,
          "resendOf must belong to the same brand, influencer, and campaign",
          400
        );
      }
      if (parent.status === "locked")
        return respondError(res, "Cannot resend a locked contract", 400);

      const child = await buildResendChildContract(parent, {
        brandInput,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
      });
      await child.save();

      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.audit = parent.audit || [];
      parent.audit.push({
        type: "RESENT",
        role: "system",
        details: { to: child.contractId, by: req.user?.email || "system" },
      });
      await parent.save();

      await Campaign.updateOne(
        { campaignId },
        { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
      );

      // 🔔 notify influencer (resend)
      await createAndEmit({
        recipientType: "influencer",
        influencerId: String(influencerId),
        type: "contract.initiated",
        title: `Contract resent by ${brandDoc.name}`,
        message: `Updated contract for "${campaign.productOrServiceName}".`,
        entityType: "contract",
        entityId: String(child.contractId),
        actionPath: `/influencer/my-campaign`,
        meta: { campaignId, brandId, influencerId, resendOf: parent.contractId },
      });

      // 🔔 self receipt for brand (resend)
      await createAndEmit({
        recipientType: "brand",
        brandId: String(brandId),
        type: "contract.initiated.self",
        title: "Contract resent",
        message: `You resent the contract to ${influencerDoc?.name || "Influencer"
          } for “${campaign?.productOrServiceName || "Campaign"}”.`,
        entityType: "contract",
        entityId: String(child.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
        meta: { campaignId, influencerId, resendOf: parent.contractId },
      });

      return respondOK(res, { message: "Resent contract created", contract: child }, 201);
    }

    // Normal first-time send
    const contract = new Contract({
      ...base,
      status: "sent",
      lastSentAt: new Date(),
      isAssigned: 1,
      isAccepted: 0,
      feeAmount: Number(brandInput.totalFee || 0),
      currency: brandInput.currency || "USD",
    });
    await contract.save();
    await emitEvent(contract, "INITIATED", { campaignId, status: contract.status });

    await Campaign.updateOne(
      { campaignId },
      { $set: { isContracted: 1, contractId: contract.contractId, isAccepted: 0 } }
    );

    // 🔔 notify influencer (initiate)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(influencerId),
      type: "contract.initiated",
      title: `Contract initiated by ${brandDoc.name}`,
      message: `Contract created for "${campaign.productOrServiceName}".`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId, brandId, influencerId },
    });

    // 🔔 self receipt for brand (initiate)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(brandId),
      type: "contract.initiated.self",
      title: "Contract sent",
      message: `You sent a contract to ${influencerDoc.name || "Influencer"
        } for “${campaign.productOrServiceName}”.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { campaignId, influencerId },
    });

    return respondOK(res, { message: "Contract initialized successfully", contract }, 201);
  } catch (err) {
    return respondError(res, err.message || "initiate error", err.status || 500, err);
  }
};

exports.viewed = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (["draft", "sent"].includes(contract.status)) contract.status = "viewed";
    await contract.save();
    await emitEvent(contract, "VIEWED");
    return respondOK(res, { message: "Marked viewed", contract });
  } catch (err) {
    return respondError(res, "viewed error", 500, err);
  }
};

exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (["finalize", "signing", "locked"].includes(contract.status))
      return respondError(res, "Contract is finalized; no further edits allowed", 400);

    // Only the influencer can accept first; brand confirm is blocked until this happens
    const safeInfluencer = { dataAccess: {}, ...influencerData, dataAccess: influencerData?.dataAccess || {} };

    if (preview) {
      const tmp = contract.toObject?.() || contract;
      tmp.influencer = { ...(tmp.influencer || {}), ...safeInfluencer };
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle =
        "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate = tokens["Agreement.EffectiveDateLong"] || "Pending";

      return await renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Influencer-Preview-${contractId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    const editedFields = computeEditedFields(
      { influencer: contract.influencer },
      { influencer: safeInfluencer },
      ["influencer"]
    );
    contract.influencer = { ...(contract.influencer || {}), ...safeInfluencer };
    contract.confirmations = contract.confirmations || {};
    contract.confirmations.influencer = {
      confirmed: true,
      byUserId: req.user?.id,
      at: new Date(),
    };
    markEdit(contract, "influencer", editedFields);

    contract.isAccepted = 1;
    // status after influencer acceptance
    if (!["finalize", "signing", "locked"].includes(contract.status)) {
      contract.status = "negotiation"; // explicitly mark accepted
    }
    await contract.save();
    await emitEvent(contract, "INFLUENCER_CONFIRMED", { editedFields });
    await Campaign.updateOne(
      { campaignId: contract.campaignId },
      { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } }
    );

    // 🔔 notify brand (influencer accepted/confirmed)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.confirm.influencer",
      title: `Influencer accepted`,
      message: `${contract.influencerName || "Influencer"} accepted the contract.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}&infId=${contract.influencerId}`,
    });

    // 🔔 self receipt for influencer (accepted)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.confirm.influencer.self",
      title: "You accepted the contract",
      message: `You accepted “${contract.brand?.campaignTitle || contract.brandName || "Contract"
        }”.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { campaignId: contract.campaignId, brandId: contract.brandId },
    });

    return respondOK(res, { message: "Influencer confirmation saved", contract });
  } catch (err) {
    return respondError(res, err.message || "influencerConfirm error", err.status || 500, err);
  }
};

exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (contract.status === "locked") return respondError(res, "Contract is locked", 400);

    // Enforce: brand cannot accept unless influencer has accepted
    requireInfluencerConfirmed(contract);

    contract.confirmations = contract.confirmations || {};
    contract.confirmations.brand = {
      confirmed: true,
      byUserId: req.user?.id,
      at: new Date(),
    };

    // After brand acceptance the contract is ready for signing.
    contract.status = "finalize";
    await contract.save();
    await emitEvent(contract, "BRAND_CONFIRMED");

    // 🔔 notify influencer (brand confirmed)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.confirm.brand",
      title: `Brand confirmed`,
      message: `${contract.brandName || "Brand"} confirmed the contract. Both parties can sign now.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
    });

    // 🔔 self receipt for brand (confirmed)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.confirm.brand.self",
      title: "You confirmed the contract",
      message: `You confirmed the contract for “${contract.brand?.campaignTitle || "Campaign"
        }”. Both parties can proceed to sign.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      meta: { campaignId: contract.campaignId, influencerId: contract.influencerId },
    });

    return respondOK(res, { message: "Brand confirmation saved", contract });
  } catch (err) {
    return respondError(res, err.message || "brandConfirm error", err.status || 500, err);
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (!req.user?.isAdmin) return respondError(res, "Forbidden: admin only", 403);
    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);

    const before = { admin: contract.admin?.toObject?.() || contract.admin };
    contract.admin = { ...contract.admin, ...adminUpdates };

    if (typeof newLegalText === "string" && newLegalText.trim()) {
      const newVersion = (contract.admin.legalTemplateVersion || 1) + 1;
      contract.admin.legalTemplateVersion = newVersion;
      contract.admin.legalTemplateText = newLegalText;
      contract.admin.legalTemplateHistory = contract.admin.legalTemplateHistory || [];
      contract.admin.legalTemplateHistory.push({
        version: newVersion,
        text: newLegalText,
        updatedAt: new Date(),
        updatedBy: req.user?.email || "admin",
      });
    }

    const after = { admin: contract.admin };
    const editedFields = computeEditedFields(before, after, ["admin"]);
    markEdit(contract, "admin", editedFields);

    await contract.save();
    await emitEvent(contract, "ADMIN_UPDATED", {
      adminUpdates: Object.keys(adminUpdates),
      newVersion: contract.admin.legalTemplateVersion,
    });
    return respondOK(res, { message: "Admin settings updated", contract });
  } catch (err) {
    return respondError(res, err.message || "adminUpdate error", err.status || 500, err);
  }
};

exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    // Align finalize with the new gate: both must have accepted to move to finalize
    requireInfluencerConfirmed(contract);
    requireBrandConfirmed(contract);

    if (["finalize", "signing", "locked"].includes(contract.status))
      return respondOK(res, { message: "Already finalized or beyond", contract });

    contract.status = "finalize";
    await contract.save();
    await emitEvent(contract, "FINALIZED");
    return respondOK(res, { message: "Contract finalized for signatures", contract });
  } catch (err) {
    return respondError(res, err.message || "finalize error", err.status || 500, err);
  }
};

exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    assertRequired(req.query, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    let tokens;
    let templateText;
    let renderedText;

    if (contract.lockedAt && contract.renderedTextSnapshot) {
      // Use the exact snapshot that was frozen at locking time
      renderedText = contract.renderedTextSnapshot;
      tokens = contract.templateTokensSnapshot || buildTokenMap(contract);
      templateText = renderedText; // renderContractHTML expects already-rendered text here
    } else {
      // Live preview – use current template + tokens
      templateText = contract.admin?.legalTemplateText || MASTER_TEMPLATE;
      tokens = buildTokenMap(contract);
      renderedText = renderTemplate(templateText, tokens);
      templateText = renderedText;
    }

    const html = renderContractHTML({
      contract,
      templateText,
    });

    const headerTitle =
      "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
    const headerDate =
      tokens["Agreement.EffectiveDateLong"] ||
      tokens["Agreement.EffectiveDate"] ||
      "Pending";

    return await renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-Preview-${contractId}.pdf`,
      headerTitle,
      headerDate,
    });
  } catch (err) {
    return respondError(
      res,
      err.message || "preview error",
      err.status || 500,
      err
    );
  }
};

exports.viewContractPdf = async (req, res) => {
  let contract;
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);

    const tz = tzOr(contract);
    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(
        contract.admin?.legalTemplateText || MASTER_TEMPLATE,
        buildTokenMap(contract)
      );
    const html = renderContractHTML({ contract, templateText: text });

    const tokens = buildTokenMap(contract);
    const headerDate = tokens["Agreement.EffectiveDateLong"] || "Pending";

    return await renderPDFWithPuppeteer({
      html,
      res,
      filename: `Contract-${contractId}.pdf`,
      headerTitle:
        "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)",
      headerDate,
    });
  } catch (err) {
    console.error("viewContractPdf error:", err);
    try {
      const templateText = renderTemplate(
        contract?.admin?.legalTemplateText || MASTER_TEMPLATE,
        buildTokenMap(contract || {})
      );
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=Contract-${contract?.contractId || "Unknown"}.pdf`
      );
      doc.pipe(res);
      doc.fontSize(18).text("Master Brand–Influencer Agreement", { align: "center" }).moveDown();
      const paragraphs = String(templateText || "").split(/\n\s*\n/);
      paragraphs.forEach((p, i) => {
        doc.text(p, { align: "justify" });
        if (i < paragraphs.length - 1) doc.moveDown();
      });
      doc.end();
    } catch (e2) {
      return respondError(res, "fallback PDF also failed", 500, e2);
    }
  }
};

exports.sign = async (req, res) => {
  try {
    const {
      contractId,
      role,
      name,
      email,
      effectiveDateOverride,
      signatureImageDataUrl,
      signatureImageBase64,
      signatureImageMime,
    } = req.body;
    assertRequired(req.body, ["contractId", "role"]);
    if (!["brand", "influencer", "collabglam"].includes(role))
      return respondError(res, "Invalid role", 400);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (contract.status === "locked") return respondError(res, "Contract is locked", 400);

    // NEW GATES: both must be confirmed before *either* can sign
    requireBothConfirmed(contract);

    // Signature image checks
    let sigImageDataUrl = null;
    if (signatureImageDataUrl || signatureImageBase64) {
      let mime = "image/png";
      let base64 = "";
      if (signatureImageDataUrl) {
        const m = String(signatureImageDataUrl).match(
          /^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/i
        );
        if (!m)
          return respondError(
            res,
            "Invalid signatureImageDataUrl. Must be data URL with base64.",
            400
          );
        mime = m[1].toLowerCase();
        base64 = m[3];
      } else {
        mime = (signatureImageMime || "image/png").toLowerCase();
        if (!/^image\/(png|jpeg|jpg)$/.test(mime))
          return respondError(
            res,
            "Unsupported signatureImageMime. Use image/png or image/jpeg.",
            400
          );
        base64 = String(signatureImageBase64 || "");
        if (!/^[A-Za-z0-9+/=]+$/.test(base64))
          return respondError(res, "Invalid base64 payload for signature image.", 400);
      }
      const bytes = Buffer.from(base64, "base64").length;
      if (bytes > 50 * 1024) return respondError(res, "Signature image must be ≤ 50 KB.", 400);
      sigImageDataUrl = `data:${mime};base64,${base64}`;
    }

    contract.signatures = contract.signatures || {};
    const now = new Date();
    contract.signatures[role] = {
      ...(contract.signatures[role] || {}),
      signed: true,
      byUserId: req.user?.id,
      name,
      email,
      at: now,
      ...(sigImageDataUrl
        ? {
          sigImageDataUrl,
          sigImageBytes: Buffer.from(sigImageDataUrl.split(",")[1], "base64").length,
        }
        : {}),
    };

    if (!["finalize", "signing", "locked"].includes(contract.status))
      contract.status = "signing";
    if (effectiveDateOverride && req.user?.isAdmin)
      contract.effectiveDateOverride = new Date(effectiveDateOverride);

    await emitEvent(contract, "SIGNED", { role, name, email });
    maybeLockIfReady(contract);
    await contract.save();

    const locked = contract.status === "locked";
    const campaignSync = { isContracted: 1, contractId: contract.contractId };
    if (contract.isAccepted === 1) campaignSync.isAccepted = 1;
    if (locked) campaignSync.contractLockedAt = contract.lockedAt || new Date();

    await Campaign.updateOne({ campaignId: contract.campaignId }, { $set: campaignSync });

    // counterparty notification
    const opp =
      role === "brand"
        ? {
          recipientType: "influencer",
          influencerId: String(contract.influencerId),
          type: "contract.signed.brand",
          path: `/influencer/my-campaign`,
        }
        : role === "influencer"
          ? {
            recipientType: "brand",
            brandId: String(contract.brandId),
            type: "contract.signed.influencer",
            path: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
          }
          : null;

    if (opp) {
      await createAndEmit({
        recipientType: opp.recipientType,
        brandId: opp.brandId,
        influencerId: opp.influencerId,
        type: opp.type,
        title: `${role === "brand" ? "Brand" : "Influencer"} signed`,
        message: `${role === "brand" ? contract.brandName || "Brand" : contract.influencerName || "Influencer"
          } added a signature.`,
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: opp.path,
      });
    }

    // self receipts
    if (role === "brand") {
      await createAndEmit({
        recipientType: "brand",
        brandId: String(contract.brandId),
        type: "contract.signed.brand.self",
        title: "You signed the contract",
        message: "Your signature has been recorded.",
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      });
    } else if (role === "influencer") {
      await createAndEmit({
        recipientType: "influencer",
        influencerId: String(contract.influencerId),
        type: "contract.signed.influencer.self",
        title: "You signed the contract",
        message: "Your signature has been recorded.",
        entityType: "contract",
        entityId: String(contract.contractId),
        actionPath: `/influencer/my-campaign`,
      });
    }

    // fully signed => notify both
    if (locked) {
      await Promise.all([
        createAndEmit({
          recipientType: "brand",
          brandId: String(contract.brandId),
          type: "contract.locked",
          title: "Contract fully signed",
          message: "All parties signed. Your contract is locked.",
          entityType: "contract",
          entityId: String(contract.contractId),
          actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
        }),
        createAndEmit({
          recipientType: "influencer",
          influencerId: String(contract.influencerId),
          type: "contract.locked",
          title: "Contract fully signed",
          message: "All parties signed. Your contract is locked.",
          entityType: "contract",
          entityId: String(contract.contractId),
          actionPath: `/influencer/my-campaign`,
        }),
      ]);
    }

    return respondOK(res, { message: locked ? "Signed & locked" : "Signature recorded", contract });
  } catch (err) {
    if (err && err.status && err.message) return respondError(res, err.message, err.status, err);
    return respondError(res, "sign error", 500, err);
  }
};

const ALLOWED_BRAND_KEYS = [
  "campaignTitle",
  "platforms",
  "goLive",
  "totalFee",
  "currency",
  "milestoneSplit",
  "usageBundle",
  "revisionsIncluded",
  "deliverablesPresetKey",
  "deliverablesExpanded",
  "requestedEffectiveDate",
  "requestedEffectiveDateTimezone",
];

const ALLOWED_INFLUENCER_KEYS = [
  "shippingAddress",
  "dataAccess",
  "taxFormType",
  "legalName",
  "email",
  "phone",
  "taxId",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
  "notes",
];

exports.brandUpdateFields = async (req, res) => {
  try {
    const {
      contractId,
      brandId,
      brandUpdates = {},
      type = 0, // 0 = update/save, 1 = preview
    } = req.body;

    const isPreview = Number(type) === 1;

    assertRequired(req.body, ["contractId", "brandId"]);

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return respondError(res, "Contract not found", 404);

    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);

    // NEW RULE: Only allow edits after influencer has accepted
    requireInfluencerConfirmed(contract);

    const before = { brand: contract.brand?.toObject?.() || contract.brand };

    // apply incoming brandUpdates (mutating the in-memory contract)
    for (const k of Object.keys(brandUpdates)) {
      if (!ALLOWED_BRAND_KEYS.includes(k)) continue;

      if (k === "goLive" && brandUpdates.goLive?.start) {
        const dd = clampDraftDue(brandUpdates.goLive.start);
        (contract.brand.deliverablesExpanded || []).forEach((d) => {
          if (d.draftRequired) d.draftDueDate = dd;
        });
        contract.other = contract.other || {};
        contract.other.autoCalcs = contract.other.autoCalcs || {};
        contract.other.autoCalcs.firstDraftDue = dd;
      }

      if (k === "requestedEffectiveDate") {
        contract.requestedEffectiveDate = new Date(brandUpdates[k]);
      } else if (k === "requestedEffectiveDateTimezone") {
        contract.requestedEffectiveDateTimezone = brandUpdates[k];
      } else {
        contract.brand[k] = brandUpdates[k];
      }
    }

    // Enforce influencer handle & backfill per-deliverable spec fields
    const inf = await Influencer.findOne(
      { influencerId: contract.influencerId },
      "handle"
    ).lean();
    const enforcedHandle = inf?.handle || "";

    if (Array.isArray(contract.brand?.deliverablesExpanded)) {
      contract.brand.deliverablesExpanded = normalizeDeliverablesArray(
        contract.brand.deliverablesExpanded,
        {
          enforcedHandle,
          draftDue: contract.other?.autoCalcs?.firstDraftDue,
          defaultRevRounds: contract.brand?.revisionsIncluded ?? 1,
          extraRevisionFee: contract.admin?.extraRevisionFee ?? 0,
        }
      );
    }

    contract.other = contract.other || {};
    contract.other.influencerProfile = contract.other.influencerProfile || {};
    contract.other.influencerProfile.handle = enforcedHandle;

    // IMPORTANT: convert after.brand to plain object too
    const after = { brand: contract.brand?.toObject?.() || contract.brand };
    const editedFields = computeEditedFields(before, after, ["brand"]);

    // PREVIEW MODE: do NOT save, do NOT emit events, just return the computed contract
    if (isPreview) {
      const contractPreview = contract.toObject ? contract.toObject() : { ...contract };
      contractPreview.brand = after.brand;

      return respondOK(res, {
        message: "Brand fields preview",
        contract: contractPreview,
        editedFields,
      });
    }

    // UPDATE MODE: persist changes and fire events
    markEdit(contract, "brand", editedFields);

    // During edit window (post influencer acceptance, pre-fully-signed)
    if (!["finalize", "signing", "locked"].includes(contract.status)) {
      contract.status = "negotiation";
    }
    contract.lastSentAt = new Date();

    await contract.save();
    await emitEvent(contract, "BRAND_EDITED", {
      brandUpdates: Object.keys(brandUpdates),
      editedFields,
    });

    // notify influencer (brand edited)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.edited.brand",
      title: `Contract updated by ${contract.brandName || "Brand"}`,
      message: `Brand made changes to your contract.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
    });

    // self receipt for brand (brand edited)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.edited.brand.self",
      title: "You updated the contract",
      message: "Your changes were saved and shared with the influencer.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
      meta: { editedFields },
    });

    return respondOK(res, { message: "Brand fields updated", contract });
  } catch (err) {
    if (err && err.status && err.message)
      return respondError(res, err.message, err.status, err);
    return respondError(res, "brandUpdateFields error", 500, err);
  }
};

exports.influencerUpdateFields = async (req, res) => {
  try {
    const { contractId, influencerUpdates = {} } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    requireNoEditsAfterBothSigned(contract);
    // NEW RULE stays: influencer can edit only after influencer has accepted
    requireInfluencerConfirmed(contract);

    const before = { influencer: contract.influencer?.toObject?.() || contract.influencer };
    for (const k of Object.keys(influencerUpdates)) {
      if (!ALLOWED_INFLUENCER_KEYS.includes(k)) continue;
      if (!contract.influencer) contract.influencer = {};
      contract.influencer[k] = influencerUpdates[k];
    }

    const after = { influencer: contract.influencer };
    const editedFields = computeEditedFields(before, after, ["influencer"]);
    markEdit(contract, "influencer", editedFields);

    if (!["finalize", "signing", "locked"].includes(contract.status))
      contract.status = "negotiation";

    await contract.save();
    await emitEvent(contract, "INFLUENCER_EDITED", { editedFields });

    // 🔔 notify brand (influencer edited)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.edited.influencer",
      title: `Contract updated by ${contract.influencerName || "Influencer"}`,
      message: `Influencer submitted updates to the contract.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
    });

    // 🔔 self receipt for influencer (influencer edited)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(contract.influencerId),
      type: "contract.edited.influencer.self",
      title: "You updated the contract",
      message: "Your updates were sent to the brand.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: { editedFields },
    });

    return respondOK(res, { message: "Influencer fields updated", contract });
  } catch (err) {
    return respondError(res, err.message || "influencerUpdateFields error", err.status || 500, err);
  }
};

exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    const contracts = await Contract.find({ brandId, influencerId, campaignId })
      .sort({ createdAt: -1 })
      .lean();

    return respondOK(res, { contracts: contracts || [] });
  } catch (err) {
    return respondError(res, "Error fetching contracts", 500, err);
  }
};

exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    assertRequired(req.body, ["contractId"]);

    const contract = await Contract.findOne({ contractId });
    if (!contract) return respondError(res, "Contract not found", 404);
    if (contract.status === "locked") return respondError(res, "Contract is locked", 400);

    if (influencerId && String(influencerId) !== String(contract.influencerId)) {
      return respondError(res, "Forbidden", 403);
    }

    contract.isRejected = 1;
    contract.status = "rejected";
    contract.audit = contract.audit || [];
    contract.audit.push({ type: "REJECTED", role: "influencer", details: { reason } });
    await contract.save();

    await Campaign.updateOne(
      { campaignId: contract.campaignId },
      { $set: { isContracted: 0, contractId: null, isAccepted: 0 } }
    );

    // 🔔 notify brand (rejected)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(contract.brandId),
      type: "contract.rejected",
      title: "Contract rejected by influencer",
      message: reason ? `Reason: ${reason}` : "Influencer rejected the contract.",
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${contract.campaignId}`,
    });

    return respondOK(res, { message: "Contract rejected", contract });
  } catch (err) {
    return respondError(res, err.message || "reject error", err.status || 500, err);
  }
};

exports.listTimezones = async (_req, res) => {
  try {
    return respondOK(res, { timezones: loadTimezones() });
  } catch (err) {
    return respondError(res, "listTimezones error", 500, err);
  }
};

exports.getTimezone = async (req, res) => {
  try {
    const { key } = req.query;
    assertRequired(req.query, ["key"]);
    const tz = findTimezoneByValueOrUTC(key);
    if (!tz) return respondError(res, "Timezone not found", 404);
    return respondOK(res, { timezone: tz });
  } catch (err) {
    return respondError(res, "getTimezone error", 500, err);
  }
};

exports.listCurrencies = async (_req, res) => {
  try {
    const data = loadCurrencies();
    const arr = Object.keys(data).map((code) => ({ code, ...data[code] }));
    return respondOK(res, { currencies: arr });
  } catch (err) {
    return respondError(res, "listCurrencies error", 500, err);
  }
};

exports.getCurrency = async (req, res) => {
  try {
    const { code } = req.query;
    assertRequired(req.query, ["code"]);
    const data = loadCurrencies();
    const cur = data[String(code).toUpperCase()];
    if (!cur) return respondError(res, "Currency not found", 404);
    return respondOK(res, { currency: { code: String(code).toUpperCase(), ...cur } });
  } catch (err) {
    return respondError(res, "getCurrency error", 500, err);
  }
};

exports.resend = async (req, res) => {
  try {
    const {
      contractId,
      brandUpdates = {},
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      preview = false,
    } = req.body;
    assertRequired(req.body, ["contractId"]);

    const parent = await Contract.findOne({ contractId });
    if (!parent) return respondError(res, "Contract not found", 404);
    if (parent.status === "locked")
      return respondError(res, "Cannot resend a locked contract", 400);

    if (preview) {
      const tmp = await buildResendChildContract(parent, {
        brandInput: brandUpdates,
        requestedEffectiveDate,
        requestedEffectiveDateTimezone,
        userEmail: req.user?.email,
        asPlain: true,
      });
      const tz = tzOr(tmp);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      const headerTitle =
        "COLLABGLAM MASTER BRAND–INFLUENCER AGREEMENT (TRI-PARTY)";
      const headerDate = tokens["Agreement.EffectiveDateLong"] || "Pending";

      return await renderPDFWithPuppeteer({
        html,
        res,
        filename: `Contract-Resend-Preview-${contractId}.pdf`,
        headerTitle,
        headerDate,
      });
    }

    const child = await buildResendChildContract(parent, {
      brandInput: brandUpdates,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      userEmail: req.user?.email,
    });

    await child.save();

    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.audit = parent.audit || [];
    parent.audit.push({
      type: "RESENT",
      role: "system",
      details: { to: child.contractId, by: req.user?.email || "system" },
    });
    await parent.save();

    await Campaign.updateOne(
      { campaignId: parent.campaignId },
      { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } }
    );

    // 🔔 notify influencer (resend)
    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(parent.influencerId),
      type: "contract.initiated",
      title: `Contract resent by ${parent.brandName || "Brand"}`,
      message: `Updated contract is available.`,
      entityType: "contract",
      entityId: String(child.contractId),
      actionPath: `/influencer/my-campaign`,
      meta: {
        campaignId: parent.campaignId,
        brandId: parent.brandId,
        influencerId: parent.influencerId,
        resendOf: parent.contractId,
      },
    });

    // 🔔 self receipt for brand (resend)
    await createAndEmit({
      recipientType: "brand",
      brandId: String(parent.brandId),
      type: "contract.initiated.self",
      title: "Contract resent",
      message: "You resent an updated contract to the influencer.",
      entityType: "contract",
      entityId: String(child.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${parent.campaignId}`,
      meta: {
        campaignId: parent.campaignId,
        influencerId: parent.influencerId,
        resendOf: parent.contractId,
      },
    });

    return respondOK(res, { message: "Resent contract created", contract: child }, 201);
  } catch (err) {
    return respondError(res, err.message || "resend error", err.status || 500, err);
  }
};
