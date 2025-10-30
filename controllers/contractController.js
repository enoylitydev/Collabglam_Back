// controllers/contractController.js
const PDFDocument = require('pdfkit');
const moment = require('moment-timezone');
const Contract = require('../models/contract');
const Campaign = require('../models/campaign');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const ApplyCampaign = require('../models/applyCampaign');
const Invitation = require('../models/invitation');
const Milestone = require('../models/milestone');
const puppeteer = require('puppeteer');

// ---------- HTML RENDERING (Google Fonts + Layout) ----------
function esc(s = '') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/**
 * Convert rendered legal text (plain) into semantic HTML without escaping our tags.
 * - Detects Title line, numbered H2 sections, "Schedule X – ..." H3s, and "Signatures".
 * - Everything else becomes paragraphs with <br> for single line breaks.
 */
function legalTextToHTML(raw) {
  const lines = String(raw).split(/\r?\n/);

  const out = [];
  let buffer = [];

  const flushP = () => {
    if (!buffer.length) return;
    // Keep inner line breaks
    const html = esc(buffer.join('\n')).replace(/\n/g, '<br>');
    out.push(`<p>${html}</p>`);
    buffer = [];
  };

  let consumedTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Blank line: paragraph break
    if (!line) { flushP(); continue; }

    // Document title (first long sentence)
    if (!consumedTitle && /^This Master Brand[\s\S]+?Parties\.”?$/.test(line)) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      consumedTitle = true;
      continue;
    }

    // Numbered sections: 1. Something ...
    const sec = line.match(/^(\d+)\.\s+(.+)$/);
    if (sec) {
      flushP();
      out.push(`<h2><span class="secno">${esc(sec[1])}.</span> ${esc(sec[2])}</h2>`);
      continue;
    }

    // "Schedule X – ..." heading
    const sch = line.match(/^Schedule\s+([A-Z])\s+–\s+(.+)$/);
    if (sch) {
      flushP();
      out.push(`<h3>Schedule ${esc(sch[1])} – ${esc(sch[2])}</h3>`);
      continue;
    }

    // "Signatures" heading
    if (/^Signatures$/.test(line)) {
      flushP();
      out.push('<h2>Signatures</h2>');
      continue;
    }

    // Otherwise accumulate paragraph text
    buffer.push(rawLine);
  }

  flushP();
  return out.join('\n');
}

function renderContractHTML({ contract, templateText, renderedAt, isSnapshot }) {
  const tz = contract.effectiveDateTimezone || contract.green?.timezone || 'America/Los_Angeles';
  const brand = contract.grey?.brandProfile || {};
  const infl = contract.grey?.influencerProfile || {};
  const y = contract.yellow || {};
  const title = y.campaignTitle || 'Campaign';
  const eff = contract.effectiveDateOverride || contract.effectiveDate;

  const headInfo = {
    brand: brand.legalName || contract.brandName || '—',
    influencer: infl.legalName || contract.influencerName || '—',
    campaign: title,
    window: [
      y?.goLive?.start ? formatDateTZ(y.goLive.start, tz, 'MMM D, YYYY') : null,
      y?.goLive?.end ? formatDateTZ(y.goLive.end, tz, 'MMM D, YYYY') : null
    ].filter(Boolean).join(' → ')
  };

  const legends = [
    { label: 'Brand Fields', color: '#F5C542', key: 'YELLOW' },
    { label: 'Influencer Fields', color: '#9B59B6', key: 'PURPLE' },
    { label: 'System Auto', color: '#9EA7B3', key: 'GREY' },
    { label: 'Admin Locked', color: '#2ECC71', key: 'GREEN' }
  ];

  // Convert legal text -> semantic HTML (no escaped tags)
  const legalHTML = legalTextToHTML(templateText);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <!-- Google Fonts (no local assets) -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 28mm 18mm 20mm 22mm; }
    html, body { height: 100%; }
    body {
      font-family: "Merriweather", serif;
      color: #1b2430;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      overflow-wrap: break-word;
      word-break: normal;
      hyphens: auto;
      line-height: 1.55;
    }
    header {
      position: fixed; top: -18mm; left: 0; right: 0; height: 16mm;
      font-family: "Inter", sans-serif;
      font-size: 10px; letter-spacing: .2px; color: #536171;
      display:flex; align-items:center; justify-content:space-between;
      border-bottom: 1px solid #e7edf3; padding: 0 18mm;
    }
    footer {
      position: fixed; bottom: -14mm; left: 0; right: 0; height: 12mm;
      font-family: "Inter", sans-serif; font-size: 10px; color:#536171;
      display:flex; align-items:center; justify-content:space-between;
      border-top:1px solid #e7edf3; padding: 0 18mm;
    }
    .page { page-break-inside: avoid; }
    .cover { display:grid; grid-template-columns: 10mm 1fr; gap: 14mm; margin-bottom: 12mm; }
    .rail { display:flex; flex-direction:column; gap:6mm; margin-top: 4mm; }
    .chip { height: 16mm; width: 10mm; border-radius: 6mm; }
    .legend {
      display:grid; grid-template-columns: 4mm 1fr; gap:6px 8px;
      align-items:center; margin-top: 2mm;
      font-family:"Inter", sans-serif; font-size:11px; color:#3a4653;
    }
    .title-block h1 {
      font-family: "Inter", sans-serif; font-weight: 800;
      font-size: 22px; margin: 0 0 4mm 0; color: #111827; letter-spacing: .2px;
    }
    .meta {
      display:flex; flex-wrap:wrap; gap:10px 14px; margin-bottom: 6mm;
      font-family:"Inter", sans-serif; font-size: 12px; color:#374151;
    }
    .meta .k { font-weight: 600; color:#111827;}
    .box {
      border:1px solid #e5e7eb; background:#fafbfc; border-radius:10px;
      padding: 12px 14px; margin-bottom: 12mm;
      font-size: 12px; color:#374151;
    }
    h1 { margin-top:0; }
    h2 {
      font-family:"Inter", sans-serif; font-weight:700;
      font-size: 15px; color:#111827; margin: 14px 0 6px;
      border-left: 3px solid #1d4ed8; padding-left: 8px;
      page-break-after: avoid;
    }
    h3 {
      font-family:"Inter", sans-serif; font-weight:600;
      font-size: 13px; color:#0f172a; margin: 12px 0 4px;
      page-break-after: avoid;
    }
    .secno { color:#1d4ed8; }
    p { margin: 6px 0 8px; }
    .muted { color:#6b7280; }
    .signatures {
      margin-top: 8mm; display:grid; grid-template-columns: 1fr 1fr; gap: 10mm;
      break-inside: avoid;
    }
    .sig { border-top: 1px solid #cbd5e1; padding-top: 8px; font-size: 12px; }
    .audit {
      margin-top: 10mm; font-size: 11px; color:#475569;
      border-top: 1px dashed #d1d5db; padding-top: 8px; break-inside: avoid;
    }
    .pill {
      display:inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-family:"Inter", sans-serif; font-weight:600;
      background:#eef2ff; color:#3730a3;
    }
  </style>
</head>
<body>
  <header>
    <div><strong>${esc(headInfo.campaign)}</strong> • ${esc(headInfo.window || 'No window set')}</div>
    <div>${esc(headInfo.brand)} ↔ ${esc(headInfo.influencer)}</div>
  </header>

  <footer>
    <div>${isSnapshot ? 'Signed Snapshot' : 'Live Preview'} • Rendered ${esc(renderedAt)}</div>
    <div class="muted"></div>
  </footer>

  <main>
    <section class="cover page">
      <div class="rail">
        ${legends.map(l => `<div class="chip" style="background:${l.color}"></div>`).join('')}
      </div>
      <div class="title-block">
        <h1>Master Brand–Influencer Agreement</h1>
        <div class="meta">
          <div><span class="k">Brand:</span> ${esc(headInfo.brand)}</div>
          <div><span class="k">Influencer:</span> ${esc(headInfo.influencer)}</div>
          <div><span class="k">Campaign:</span> ${esc(headInfo.campaign)}</div>
        </div>
        <div class="box">
          <strong>At a glance</strong><br>
          <span class="pill">Yellow</span> brand fields •
          <span class="pill" style="background:#f5f3ff;color:#7c3aed">Purple</span> influencer confirms •
          <span class="pill" style="background:#f3f4f6;color:#334155">Grey</span> system pulls •
          <span class="pill" style="background:#ecfdf5;color:#065f46">Green</span> admin-locked
        </div>
        <div class="legend">
          ${legends.map(l => `
            <div style="width:6px;height:6px;border-radius:2px;background:${l.color}"></div>
            <div>${esc(l.label)} <span class="muted">(${l.key})</span></div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="page">
      ${legalHTML}
    </section>

    <section class="page">
      <h2>Signatures & Audit</h2>
      <div class="signatures">
        ${['brand', 'influencer', 'collabglam'].map(r => {
    const s = contract.signatures?.[r] || {};
    const status = s.signed ? 'SIGNED' : 'PENDING';
    const when = s.at ? formatDateTZ(s.at, tz, 'YYYY-MM-DD HH:mm z') : '';
    return `
          <div class="sig">
            <strong>${r.toUpperCase()}</strong><br>
            ${status}${s.signed ? ` by ${esc(s.name || '')} &lt;${esc(s.email || '')}&gt; on ${esc(when)}` : ''}
          </div>`;
  }).join('')}
      </div>

      <div class="audit">
        Effective Date (TZ ${esc(tz)}):
        ${esc(formatDateTZ(contract.effectiveDateOverride || contract.effectiveDate || new Date(), tz, 'MMMM D, YYYY HH:mm z'))}
        ${contract.effectiveDateOverride ? ' (admin override)' : ''}
      </div>
    </section>
  </main>
</body>
</html>
`;
}

async function renderPDFWithPuppeteer({ html, res, filename = 'Contract.pdf' }) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const headerTemplate = `
    <div style="width:100%; font-size:8px; color:#6b7280; padding:0 10mm; display:flex; justify-content:flex-end;">
      <span></span>
    </div>`;
  const footerTemplate = `
    <div style="width:100%; font-size:8px; color:#6b7280; padding:0 10mm; display:flex; justify-content:flex-end;">
      <span class="pageNumber"></span>/<span class="totalPages"></span>
    </div>`;

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: ['load','domcontentloaded','networkidle0'] });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: '28mm', bottom: '20mm', left: '18mm', right: '18mm' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${filename}`);
    res.end(pdf);
  } finally {
    await browser.close();
  }
}

const MASTER_TEMPLATE = `This Master Brand–Influencer Agreement (the “Agreement”) is made as of {{Agreement.EffectiveDate}} (the “Effective Date”) by and among: (i) {{Brand.LegalName}}, with its principal place of business at {{Brand.Address}} (“Brand”); (ii) {{Influencer.LegalName}}, with its principal place of business at {{Influencer.Address}} (“Influencer”); and (iii) CollabGlam or CollabGlam.com, with its principal place of business at {{CollabGlam.Address}} (“CollabGlam”). Each of Brand, Influencer, and CollabGlam is a “Party” and together the “Parties.”

1. Purpose; Scope; Territory; Relationship
   a. Purpose. CollabGlam provides a platform connecting brands and influencers for promotional content on social media including YouTube, Instagram, and TikTok (the “Channels”). This Agreement governs rights and obligations for each engagement documented in Schedule A (each, an “SOW”).
   b. Scope. This Agreement applies solely to the Channels. No other platforms are included unless added by written amendment executed by all Parties.
   c. Territory. Unless the SOW states otherwise, the territory is worldwide.
   d. Independent Contractor Status. Influencer is an independent contractor. No employment, partnership, joint venture, or agency is created.

2. Definitions; Language; Precedence; Time Standard
   a. Definitions. Capitalized terms have the meanings set out in Schedule E (Definitions).
   b. Language and Precedence. English governs. If any conflict exists, this Agreement prevails over any SOW, except where the SOW expressly overrides a non-locked topic. All Schedules are incorporated.
   c. Time Standard. Deadlines use {{Time.StandardTimezone}}. “Business Day” means a day other than a Saturday, Sunday, or public holiday in {{Time.StandardJurisdiction}}.

3. Formation of SOW; Versioning; Change Orders
   a. Formation. An SOW is formed when Brand completes required fields in the platform, Influencer accepts, Brand confirms acceptance, and the Parties execute via platform e-signature. If expressly enabled in the SOW, concurrent shipment of product and initial milestone payment constitutes acceptance.
   b. Versioning. The platform maintains immutable version history of offers, counteroffers, and acceptance.
   c. Change Orders. Any post-execution modification to Deliverables, schedules, or fees requires a written change order in the form set out in Schedule O.

4. Services; Deliverables; Acceptance; Makegoods
   a. Services and Deliverables. Influencer shall provide the services and deliver the content specified in Schedule A (the “Deliverables”).
   b. Approvals. If pre-publication review is required, Influencer shall submit drafts via the platform. Brand shall respond within the review window in Schedule A. If Brand does not respond within such window, Influencer may issue a notice of deemed acceptance and proceed after two Business Days unless Brand objects in writing within that period.
   c. Revisions. Included revision rounds are as stated in Schedule A. Additional rounds are billable at the fee in Schedule A.
   d. Acceptance Criteria. A Deliverable is acceptable if it materially conforms to the SOW and Schedule B compliance standards. Minor non-material deviations shall not justify rejection.
   e. Makegoods. If a Deliverable misses the posting window due to Influencer fault, or is removed for non-compliance with Schedule B, Influencer shall, at no additional charge, provide a makegood consisting of re-posting within a mutually agreed window or an equivalent Deliverable.

5. Performance Standards; Escalation
   a. Service Levels. Submission and feedback timelines in Schedule A are binding.
   b. Escalation. Each Party shall designate an escalation contact in Schedule A. Unresolved issues escalate per the timelines in Schedule A.

6. Intellectual Property; Licenses; Derivatives; Third-Party Materials
   a. Ownership. Influencer owns the original copyright in the Deliverables, excluding Brand Assets. Brand owns its trademarks and materials furnished to Influencer (“Brand Assets”).
   b. License to Brand. Upon receipt of applicable milestone payments, Influencer grants Brand the license selected in Schedule K (Usage Rights Matrix) for the duration and geographies selected therein.
   c. Derivative Edits. To the extent selected in Schedule K, Brand may create cut-downs, translations, captions, watermarks, thumbnails, and metadata edits.
   d. Raw Materials. If the SOW requires raw footage, project files, or working files, delivery shall occur per Schedule P. Ownership of raw materials remains with Influencer unless Schedule P expressly transfers ownership.
   e. Third-Party Materials. Influencer shall not include third-party materials requiring separate licenses without Brand’s prior written approval. Where approval is granted, proof of licenses shall be delivered per Schedule Q. Unless Schedule A shifts responsibility, Brand is responsible for commercial music licensing.
   f. Moral Rights. To the extent permitted by law, Influencer waives, or agrees not to assert, moral rights as necessary for the licensed uses.

7. Advertising and Platform Compliance
   a. Legal Compliance. Deliverables must comply with applicable advertising and consumer protection laws in targeted jurisdictions, including the United States Federal Trade Commission Endorsement Guides and materially equivalent regimes.
   b. Disclosures. Influencer shall make clear and conspicuous disclosures of any material connection as required by law.
   c. Truthful Claims. Influencer shall not make false, misleading, or unsubstantiated claims. Brand shall provide substantiation for objective claims it requires.
   d. Platform Policies. Influencer shall comply with YouTube, Instagram, and TikTok policies.
   e. Corrections. Upon notice of a compliance deficiency, Influencer shall promptly implement non-substantive corrections without counting against revision limits.
   f. Prohibited Conduct. Deliverables shall not include illegal content, hate speech, harassment, or similar brand-safety risks.

8. Global Standards; Sensitive Sectors; Accessibility; AI and Synthetic Media
   a. Jurisdictional Standards. The Parties shall adhere to materially applicable local regimes, including where relevant CMA/ASA (UK), EU UCPD, ACMA (AU), and comparable authorities.
   b. Age-Gated and Sensitive Sectors. Where age-gating or sector-specific rules apply, the Parties shall implement controls before publication. The minors-specific requirements in Schedule I apply when any minor participates or is targeted.
   c. Accessibility. Where reasonably practicable, video Deliverables shall include platform-native captions and reasonable accessibility accommodations.
   d. AI and Synthetic Media. Without express written consent, no Party shall train, fine-tune, or otherwise use any Deliverables or Brand Assets to develop or improve machine learning or artificial intelligence models. No synthetic impersonation of any person is permitted without that person’s written consent. If synthetic media is used, required legal labeling shall be applied.

9. Confidentiality
   a. Definition. “Confidential Information” means non-public information disclosed by a Party that is identified as confidential or that should reasonably be understood to be confidential.
   b. Obligations. The Receiving Party shall use Confidential Information solely to perform under this Agreement and protect it with at least reasonable care.
   c. Duration. Confidentiality obligations survive for three years after termination; trade secrets survive while they remain trade secrets.
   d. Exceptions. Exclusions apply for independently developed, rightfully received, public, or legally compelled disclosures.

10. Payments; Escrow; Invoicing; Taxes; Currency; AML/KYC; Clawback
   a. Fees and Milestones. Fees, currency, milestones, and net terms are set out in Schedule A.
   b. Escrow. Unless disabled in Schedule A, payments shall be deposited into CollabGlam escrow and released upon milestone completion as recorded in the platform.
   c. Invoicing. Where invoicing is used, Influencer shall issue invoices containing required tax identifiers and line items consistent with Schedule A.
   d. Currency Conversion. If payment occurs in a different currency, conversion shall be based on {{Payments.FXSource}} on the payment date unless Schedule A states another source. FX fees shall be allocated as stated in Schedule A.
   e. Taxes. Amounts are exclusive of VAT, GST, and similar taxes unless stated otherwise. Each Party is responsible for its own taxes. Required tax forms, including W-9, W-8BEN, or W-8BEN-E, shall be provided.
   f. AML/KYC and Sanctions Screening. CollabGlam may perform and the Parties shall cooperate with AML/KYC and sanctions screenings prior to each payout. Failure or refusal to pass screening permits payment suspension or termination for cause.
   g. Late Payment. Overdue sums accrue interest at 1.5 percent per month or the maximum permitted by law, whichever is lower.
   h. Chargebacks. Bad-faith chargebacks constitute a material breach. CollabGlam may suspend accounts, recover fees, and offset against funds held.
   i. Clawback and Offsets. In cases of proven fraud or material breach causing refund or chargeback, amounts may be offset against future payments for the same SOW, subject to law.

11. Metrics; Invalid Traffic; Verification; Remedies
   a. Metrics Evidence. Influencer shall provide live links and insights or screenshots within 48 hours of publication and a day-30 snapshot upon request.
   b. Invalid Traffic. “Invalid Traffic” has the meaning in Schedule L. If Invalid Traffic materially distorts results, remedies in Schedule L shall apply.
   c. Verification. Brand may request third-party verification once per SOW per Schedule L. Costs are borne by Brand unless variance thresholds are exceeded.

12. Data Protection; Security; Account Access; E-Sign
   a. Data Minimization. Personal data shall be limited to what is necessary for SOW performance.
   b. Compliance. Each Party shall comply with applicable data protection laws, including GDPR, UK GDPR, and CCPA/CPRA, as applicable.
   c. Security. Each Party shall implement reasonable technical and organizational measures and notify affected Parties without undue delay of a personal data breach.
   d. DPA. Where one Party processes personal data on behalf of another beyond independent controller roles, the Data Processing Addendum at Schedule D applies.
   e. Ad Accounts and Pixels. Access shall be least-privileged and shall be revoked upon SOW completion.
   f. E-Signature Enforceability. Electronic signatures are enforceable under ESIGN, UETA, and, where applicable, eIDAS, without prejudice to any mandatory local requirements.

13. Product Handling; Shipment; Returns
   a. Shipment Timing. Where product is required, Brand shall deliver by the date in Schedule A.
   b. Ownership. Unless Schedule A requires return, Influencer may retain product after final approval. If return is required, Brand shall provide prepaid labels and instructions.
   c. Care. Influencer shall exercise reasonable care while product is in Influencer’s possession, excluding manufacturer defects or carrier damage.

14. Takedown; Corrective Action; Morals and Reputation
   a. Takedown. If a Deliverable appears unlawful, infringes rights, or violates Channel policies, CollabGlam may require temporary unlisting or removal pending cure.
   b. Corrections. Influencer shall promptly implement required compliance corrections.
   c. Morals. A Party may suspend performance where association with another Party would reasonably cause material reputational harm due to criminal conduct, hate speech, or similar scandal substantiated by credible evidence.
   d. Crisis Protocol. Public-facing coordination shall follow Schedule M.

15. Exclusivity; Non-Circumvention
   a. Category Exclusivity. If selected in Schedule A, Influencer shall refrain from promoting listed competitors within the exclusivity window after go-live.
   b. Non-Circumvention. For twelve months after the last milestone under an SOW, Brand and Influencer shall not intentionally circumvent CollabGlam to contract for substantially similar services first initiated on the platform, unless CollabGlam consents in writing or Brand pays a buy-out fee of fifteen percent of the contracted value.

16. Insurance
   a. Insurance Requirements. If required by Schedule J, Influencer shall maintain insurance with limits and coverages stated therein and provide a certificate of insurance upon request. Where required, Brand shall be named as additional insured on a primary and non-contributory basis.

17. Representations and Warranties
   a. Mutual. Each Party represents and warrants authority to enter into this Agreement and compliance with law, including sanctions and export controls.
   b. Influencer. Influencer represents and warrants originality of Deliverables (excluding Brand Assets), compliance with Schedule B and Channel policies, and that statements reflect honest opinions and experiences.
   c. Brand. Brand represents and warrants that Brand Assets and required claims are lawful and non-infringing and that Brand will provide substantiation for objective claims.

18. Indemnification
   a. By Influencer. Influencer shall defend, indemnify, and hold harmless Brand and CollabGlam against claims arising from infringement by Deliverables (excluding Brand Assets), violations of Schedule B, or Influencer’s breach.
   b. By Brand. Brand shall defend, indemnify, and hold harmless Influencer and CollabGlam against claims arising from Brand Assets, unsubstantiated or unlawful product claims, product liability, or Brand’s breach.
   c. Procedure. The indemnified Party shall provide prompt notice, reasonable cooperation, and grant control of the defense to the indemnifying Party, subject to participation at the indemnified Party’s expense.

19. Limitations of Liability
   a. Exclusions. Except for willful misconduct or fraud, indemnification obligations, or breaches of Section 9, no Party is liable for indirect, incidental, special, consequential, exemplary, or punitive damages.
   b. Cap. CollabGlam’s total liability for any SOW shall not exceed the greater of platform fees received by CollabGlam for that SOW or USD 1,000.

20. Material Platform Change; Shadow-Ban or Suppression
   a. Material Platform Change. If a Channel materially changes policies or ad tools in a manner that makes performance commercially impracticable, the Parties shall in good faith renegotiate timelines and fees. If no agreement is reached within seven Business Days, either Party may terminate the affected SOW without fault, with escrowed amounts reconciled pro rata.
   b. Shadow-Ban or Suppression. If a Deliverable is materially suppressed beyond normal variance due to documented platform enforcement unrelated to breach by Influencer, the Parties shall implement remedies consistent with Schedule L.

21. Dispute Resolution; Mediation; Arbitration; Governing Law; Injunctive Relief
   a. Governing Law. This Agreement is governed by the laws of  USA without regard to conflict-of-law rules. The default is California, United States.
   b. Mediation. As a condition precedent to arbitration, the Parties shall mediate any dispute in good faith for at least ten Business Days after a written mediation request.
   c. Arbitration. Unresolved disputes shall be finally resolved by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules. The seat shall be {{Arbitration.Seat}} and the language English. Judgment may be entered in any court of competent jurisdiction.
   d. Fees. The arbitrator may award reasonable costs and attorneys’ fees to the prevailing Party.
   e. Injunctive Relief. A Party may seek temporary injunctive relief in court to preserve the status quo or protect intellectual property or Confidential Information.

22. Force Majeure
   a. No Party is liable for delay or failure to perform due to events beyond reasonable control. The impacted Party shall notify the others and mitigate. Posting windows shall be extended for the duration of the force majeure event.

23. Sanctions; Export; Anti-Corruption; Anti-Spam
   a. Each Party represents it is not subject to sanctions and will comply with sanctions, export controls, anti-corruption, and anti-spam laws. Deliverables shall not be targeted to embargoed territories contrary to law.

24. Notices
   a. Routine communications may occur via the platform. Formal notices shall be sent to the addresses and emails listed above, with a copy to legal@collabglam.com, and are deemed received upon confirmed courier delivery or email transmission with confirmation.

25. Assignment; Change of Control; Insolvency
   a. Assignment. Brand and Influencer may not assign this Agreement or any SOW without prior written consent of the other Parties. CollabGlam may assign to an affiliate or in connection with a merger, acquisition, or sale of substantially all assets.
   b. Change of Control. A Party undergoing a change of control shall notify the other Parties within a reasonable period and ensure continuity of licenses granted for fully paid Deliverables.
   c. Insolvency. Upon insolvency proceedings, non-insolvent Parties may terminate outstanding SOWs for cause. Licenses already paid for shall continue per their terms.

26. Records; Audit Trail; Evidence Preservation
   a. The platform maintains records of SOWs, approvals, submissions, and milestone events. The Parties consent to CollabGlam’s retention of such records for compliance and dispute resolution.

27. Platform Terms; Fees; Suspension; Audit Rights
   a. Platform Fees. Brand authorizes deduction of platform and processing fees as published in the dashboard at SOW acceptance.
   b. Suspension. CollabGlam may suspend accounts or SOWs for repeated violations, fraud, or non-payment after notice.
   c. Limited Audit. CollabGlam may conduct a limited audit of SOW performance records where reasonably necessary to verify milestone completion or suspected fraud.

28. Independent-Contractor Safeguards; Non-Solicit
   a. Contractor Safeguards. Influencer shall provide tools, select methods, and control scheduling subject to SOW outcomes. No benefits, withholdings, or supervision constituting employment shall be imposed.
   b. Non-Solicit. During the Term and for six months thereafter, the Parties shall not knowingly solicit for employment the other Party’s employees or exclusive roster talent directly involved in an SOW, excluding general solicitations not targeted at such personnel.

29. Entire Agreement; Amendments; Waiver; Severability; Counterparts; Survival Map
   a. Entire Agreement. This Agreement, Schedules, and executed SOWs constitute the entire agreement and supersede prior or contemporaneous agreements on the subject matter.
   b. Amendments. Amendments must be in writing and executed via platform e-signature by all Parties. Locked clauses may not be modified without CollabGlam’s written consent.
   c. Waiver. Failure to enforce any provision is not a waiver of future enforcement.
   d. Severability. If any provision is held invalid or unenforceable, the remainder remains effective.
   e. Counterparts; E-Signatures. Counterparts and electronic signatures are valid and binding.
   f. Survival. The survival durations in Schedule N apply.

Signatures

Brand: {{Brand.LegalName}}
By: __________________________
Name: {{Brand.ContactName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

Influencer: {{Influencer.LegalName}}
By: __________________________
Name: {{Influencer.ContactName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

CollabGlam: CollabGlam, Inc.
By: __________________________
Name: {{CollabGlam.SignatoryName}}
Title: ________________________
Date: {{Agreement.EffectiveDate}}

Schedule A – Statement of Work (SOW)

1. Campaign Title: {{Campaign.Title}}
2. Territory: {{Campaign.Territory}}
3. Channels: {{Campaign.Channels}}
4. Deliverables:
   a. Type, quantity, format, duration.
   b. Posting window start and end dates.
   c. Draft requirement and draft due date, if applicable.
   d. Included revision rounds and fee per additional round.
   e. Minimum live retention period.
   f. Required tags, handles, captions, links, and disclosures.
   g. Whitelisting, spark ads, or equivalent access, if applicable.
5. Approvals and Service Levels:
   a. Brand review window: {{Approval.BrandResponseWindow}} Business Days.
   b. Included revision rounds: {{Approval.RoundsIncluded}}.
   c. Additional revision fee: {{Approval.AdditionalRevisionFee}}.
6. Usage Rights Matrix Reference: See Schedule K selections.
7. Compensation and Payments:
   a. Total Fee and currency: {{Comp.TotalFee}} {{Comp.Currency}}.
   b. Milestones and triggers: {{Comp.MilestoneSplit}}.
   c. Net terms if escrow is not used: {{Comp.NetTerms}}.
   d. Payment method: {{Comp.PaymentMethod}}.
8. Tracking and Reporting:
   a. Affiliate link or UTM parameters, if applicable.
   b. Insights or screenshots within 48 hours and a day-30 snapshot upon request.
9. Exclusivity:
   a. Category definition and competitor list, if applicable.
   b. Exclusivity window after go-live: {{Exclusivity.WindowHoursAfterPost}} hours.
10. Product Handling:
    a. Shipment date required: {{ProductShipment.RequiredDate}}.
    b. Return required or not: {{ProductShipment.ReturnRequired}}.
11. Contacts and Escalation:
    a. Primary contacts for each Party.
    b. Escalation contact and timelines.
12. Special Terms:
    a. Any specific provisions expressly agreed to override SOW defaults consistent with Section 2.

// Schedules B through Q follow exactly as per your template text...
`;

const toStr = v => (v == null ? '' : String(v));

function businessDaysSubtract(date, days) {
  // subtract N business days (Mon-Fri). Very simple implementation.
  let d = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay(); // 0 Sun ... 6 Sat
    if (day !== 0 && day !== 6) remaining--;
  }
  return d;
}

function clampDraftDue(goLiveStart, now = new Date()) {
  // 7 business days before goLive start, with a 2-business-day safety floor from NOW
  const ideal = businessDaysSubtract(goLiveStart, 7);
  const floor = businessDaysSubtract(now, -2); // add 2 business days
  return ideal < floor ? floor : ideal;
}

function formatDateTZ(date, tz, fmt = 'MMMM D, YYYY') {
  return moment(date).tz(tz).format(fmt);
}

// Build token map from a Contract doc (live or snapshot)
function buildTokenMap(contract) {
  const tz = contract.green?.timezone || contract.effectiveDateTimezone || 'America/Los_Angeles';
  const eff = contract.effectiveDateOverride || contract.effectiveDate || new Date();
  const brand = contract.grey?.brandProfile || {};
  const infl = contract.grey?.influencerProfile || {};
  const y = contract.yellow || {};
  const green = contract.green || {};

  const channels = (y.platforms || []).join(', ');
  const territory = 'Worldwide'; // default per template (can be overridden in schedule A)
  const compNetTerms = 'Net 15'; // set from your UI if you expose it
  const compMethod = 'Escrow via CollabGlam'; // can be customized

  return {
    'Agreement.EffectiveDate': formatDateTZ(eff, tz),
    'Brand.LegalName': brand.legalName || contract.brandName || '',
    'Brand.Address': brand.address || contract.brandAddress || '',
    'Brand.ContactName': brand.contactName || '',
    'Influencer.LegalName': infl.legalName || contract.influencerName || '',
    'Influencer.Address': infl.address || contract.influencerAddress || '',
    'Influencer.ContactName': infl.contactName || '',
    'CollabGlam.Address': '548 Market St, San Francisco, CA 94104, USA', // editable at admin side via green.legalTemplateText if desired
    'Time.StandardTimezone': green.timezone || tz,
    'Time.StandardJurisdiction': green.jurisdiction || 'USA',
    'Arbitration.Seat': green.arbitrationSeat || 'San Francisco, CA',
    'Payments.FXSource': green.fxSource || 'ECB',

    // SOW / schedules
    'Campaign.Title': y.campaignTitle || '',
    'Campaign.Territory': territory,
    'Campaign.Channels': channels,
    'Approval.BrandResponseWindow': green.defaultBrandReviewWindowBDays ?? 2,
    'Approval.RoundsIncluded': y.revisionsIncluded ?? 1,
    'Approval.AdditionalRevisionFee': green.extraRevisionFee ?? 0,
    'Comp.TotalFee': y.totalFee ?? contract.feeAmount ?? 0,
    'Comp.Currency': y.currency || contract.currency || 'USD',
    'Comp.MilestoneSplit': y.milestoneSplit || '50/50',
    'Comp.NetTerms': compNetTerms,
    'Comp.PaymentMethod': compMethod,
    'Exclusivity.WindowHoursAfterPost': 0,
    'ProductShipment.RequiredDate': y.deliverablesExpanded?.[0]?.postingWindow?.start
      ? formatDateTZ(y.deliverablesExpanded[0].postingWindow.start, tz)
      : '',
    'ProductShipment.ReturnRequired': 'No'
  };
}

function renderTemplate(templateText, tokenMap) {
  return templateText.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const v = tokenMap[key];
    return (v === undefined || v === null) ? '' : String(v);
  });
}

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    {
      'milestoneHistory.influencerId': influencerId,
      'milestoneHistory.campaignId': { $in: campaignIds }
    },
    'milestoneHistory.campaignId milestoneHistory.influencerId'
  ).lean();

  const set = new Set();
  docs.forEach(d => {
    d.milestoneHistory.forEach(e => {
      if (toStr(e.influencerId) === toStr(influencerId) &&
        campaignIds.includes(toStr(e.campaignId))) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

function writeLongText(doc, text) {
  const paragraphs = String(text).split(/\n\s*\n/);
  paragraphs.forEach((p, i) => {
    doc.text(p, { align: 'justify' });
    if (i < paragraphs.length - 1) doc.moveDown();
  });
}

// ---------- ENDPOINTS ----------

/**
 * 1) INITIATE (Brand fills YELLOW → System expands GREY)
 * POST /contract/initiate
 * Body: brandId, influencerId, campaignId, yellow: {...}, type (0=PDF stream, 1=save)
 */
exports.initiate = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId, yellow = {}, type = 1 } = req.body;

    if (![0, 1].includes(+type)) return res.status(400).json({ message: 'Invalid type; must be 0 or 1' });
    if (!brandId || !influencerId || !campaignId) {
      return res.status(400).json({ message: 'brandId, influencerId, campaignId are required' });
    }
    const [campaign, brand, influencer] = await Promise.all([
      Campaign.findOne({ campaignsId: campaignId }),
      Brand.findOne({ brandId }),
      Influencer.findOne({ influencerId })
    ]);
    if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
    if (!brand) return res.status(404).json({ message: 'Brand not found' });
    if (!influencer) return res.status(404).json({ message: 'Influencer not found' });

    // System GREY pull
    const grey = {
      brandProfile: {
        legalName: brand.legalName || brand.name || '',
        address: brand.address || '',
        contactName: brand.contactName || brand.ownerName || '',
        email: brand.email || '',
        country: brand.country || ''
      },
      influencerProfile: {
        legalName: influencer.legalName || influencer.name || '',
        address: influencer.address || '',
        contactName: influencer.contactName || influencer.name || '',
        email: influencer.email || '',
        country: influencer.country || '',
        handle: influencer.handle || yellow.influencerHandle || ''
      },
      autoCalcs: {}
    };

    // Expand Deliverables from preset (you can replace with your actual preset engine)
    const deliverablesExpanded = Array.isArray(yellow.deliverablesExpanded)
      ? yellow.deliverablesExpanded
      : [{
        type: 'Video',
        quantity: 1,
        format: 'MP4',
        durationSec: 60,
        postingWindow: { start: yellow.goLive?.start, end: yellow.goLive?.end },
        draftRequired: yellow.revisionsIncluded > 0,
        minLiveHours: 720, // 30 days
        tags: [],
        handles: [],
        captions: '',
        links: [],
        disclosures: '#ad'
      }];

    // Draft due date calc with floor
    const draftDue = clampDraftDue(yellow.goLive?.start || new Date());
    deliverablesExpanded.forEach(d => {
      if (d.draftRequired && !d.draftDueDate) d.draftDueDate = draftDue;
    });
    grey.autoCalcs.firstDraftDue = draftDue;
    grey.autoCalcs.tokensExpandedAt = new Date();

    const green = {
      timezone: 'America/Los_Angeles',
      jurisdiction: 'USA',
      arbitrationSeat: 'San Francisco, CA',
      fxSource: 'ECB',
      defaultBrandReviewWindowBDays: 2,
      extraRevisionFee: 0,
      escrowAMLFlags: '',
      legalTemplateVersion: 1,
      legalTemplateText: MASTER_TEMPLATE,
      legalTemplateHistory: [{
        version: 1,
        text: MASTER_TEMPLATE,
        updatedAt: new Date(),
        updatedBy: req.user?.email || 'system'
      }]
    };

    const contractData = {
      brandId, influencerId, campaignId, type,
      yellow: { ...yellow, deliverablesExpanded },
      purple: {},
      grey,
      green,
      isAssigned: 1,
      lastSentAt: new Date(),
      brandName: grey.brandProfile.legalName,
      brandAddress: grey.brandProfile.address,
      influencerName: grey.influencerProfile.legalName,
      influencerAddress: grey.influencerProfile.address,
      influencerHandle: grey.influencerProfile.handle
    };

    // TYPE 0: generate PDF preview on the fly (not saved)
    if (+type === 0) {
      const tmp = new Contract(contractData);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(green.legalTemplateText, tokens);

      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=Contract-Preview.pdf');
      doc.pipe(res);

      doc.fontSize(18).text('Master Brand–Influencer Agreement', { align: 'center' });
      doc.moveDown();
      writeLongText(doc, text);

      doc.end();
      return;
    }

    // Save to DB and update ApplyCampaign / Invitation like before
    const newContract = new Contract(contractData);
    await newContract.save();

    let appRec = await ApplyCampaign.findOne({ campaignId });
    if (!appRec) {
      appRec = new ApplyCampaign({
        campaignId,
        applicants: [],
        approved: [{ influencerId, name: contractData.influencerName }]
      });
    } else {
      // ensure influencer is in approved list
      appRec.approved = [{ influencerId, name: contractData.influencerName }];
    }
    await appRec.save();

    await Invitation.findOneAndUpdate(
      { campaignId, influencerId },
      { isContracted: 1 },
      { new: true }
    ).catch(() => { });

    // Audit
    await Contract.updateOne(
      { contractId: newContract.contractId },
      { $push: { audit: { type: 'INITIATED', role: 'brand', details: { campaignId } } } }
    );

    return res.status(201).json({
      message: 'Contract initialized successfully',
      contract: newContract
    });

  } catch (err) {
    console.error('initiate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 2) INFLUENCER QUICK CONFIRM (PURPLE)
 * POST /contract/influencer-confirm
 * Body: contractId, purple: {...}
 */
exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, purple = {} } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.lockedAt) return res.status(400).json({ message: 'Contract is locked' });

    contract.purple = { ...contract.purple, ...purple };
    await contract.save();

    contract.audit.push({ type: 'PURPLE_CONFIRMED', role: 'influencer', details: purple });
    await contract.save();

    return res.json({ message: 'Influencer confirmation saved', contract });
  } catch (err) {
    console.error('influencerConfirm error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 3) ADMIN UPDATE (GREEN) — locked legal, versioned
 * POST /contract/admin-update
 * Body: contractId, greenUpdates: {...}, newLegalText? (optional, creates new version)
 */
exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, greenUpdates = {}, newLegalText } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.lockedAt) return res.status(400).json({ message: 'Contract is locked' });

    // Only admin should access this endpoint — enforce via middleware in your app
    // if (!req.user?.isAdmin) return res.status(403).json({ message: 'Forbidden' });

    // Update green fields
    contract.green = { ...contract.green, ...greenUpdates };

    if (typeof newLegalText === 'string' && newLegalText.trim()) {
      const newVersion = (contract.green.legalTemplateVersion || 1) + 1;
      contract.green.legalTemplateVersion = newVersion;
      contract.green.legalTemplateText = newLegalText;
      contract.green.legalTemplateHistory = contract.green.legalTemplateHistory || [];
      contract.green.legalTemplateHistory.push({
        version: newVersion,
        text: newLegalText,
        updatedAt: new Date(),
        updatedBy: req.user?.email || 'admin'
      });
    }

    await contract.save();

    contract.audit.push({ type: 'ADMIN_UPDATED', role: 'admin', details: { greenUpdates: Object.keys(greenUpdates), newVersion: contract.green.legalTemplateVersion } });
    await contract.save();

    return res.json({ message: 'Admin settings updated', contract });
  } catch (err) {
    console.error('adminUpdate error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.preview = async (req, res) => {
  try {
    const { contractId, pdf } = req.query;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const tokens = buildTokenMap(contract);
    const text = renderTemplate(contract.green?.legalTemplateText || MASTER_TEMPLATE, tokens);
    const html = renderContractHTML({
      contract,
      templateText: text,
      renderedAt: formatDateTZ(new Date(), contract.green?.timezone || 'America/Los_Angeles', 'MMM D, YYYY HH:mm z'),
      isSnapshot: false
    });

    if (String(pdf) === '1') {
      return await renderPDFWithPuppeteer({ html, res, filename: `Contract-Preview-${contractId}.pdf` });
    }

    // Return HTML preview + tokens (handy for a web UI)
    return res.json({ tokens, html });
  } catch (err) {
    console.error('preview error:', err);
    // Fallback to plain text (in case Puppeteer fails in your env)
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 6) VIEW (Locked) PDF — uses snapshot when locked; else live render
 * POST /contract/view-pdf
 * Body: contractId
 */
exports.viewContractPdf = async (req, res) => {
  try {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    const text = contract.lockedAt
      ? contract.renderedTextSnapshot
      : renderTemplate(contract.green?.legalTemplateText || MASTER_TEMPLATE, buildTokenMap(contract));

    const html = renderContractHTML({
      contract,
      templateText: text,
      renderedAt: formatDateTZ(new Date(), contract.green?.timezone || 'America/Los_Angeles', 'MMM D, YYYY HH:mm z'),
      isSnapshot: Boolean(contract.lockedAt)
    });

    return await renderPDFWithPuppeteer({ html, res, filename: `Contract-${contractId}.pdf` });
  } catch (err) {
    console.error('viewContractPdf error:', err);

    // -------- PDFKIT FALLBACK (if Chromium is unavailable) --------
    try {
      const templateText = renderTemplate(
        contract.green?.legalTemplateText || MASTER_TEMPLATE,
        buildTokenMap(contract)
      );
      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename=Contract-${contractId}.pdf`);
      doc.pipe(res);
      doc.fontSize(18).text('Master Brand–Influencer Agreement', { align: 'center' }).moveDown();
      writeLongText(doc, templateText);
      doc.end();
    } catch (e2) {
      console.error('fallback PDFKit also failed:', e2);
      res.status(500).json({ error: 'Failed to render PDF' });
    }
  }
};


/**
 * 5) SIGN (Brand/Influencer/CollabGlam). Lock on final signature; set Effective Date
 * POST /contract/sign
 * Body: contractId, role ('brand'|'influencer'|'collabglam'), name, email, effectiveDateOverride? (admin only)
 */
exports.sign = async (req, res) => {
  try {
    const { contractId, role, name, email, effectiveDateOverride } = req.body;
    if (!contractId || !role) return res.status(400).json({ message: 'contractId and role are required' });
    if (!['brand', 'influencer', 'collabglam'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.lockedAt) return res.status(400).json({ message: 'Contract is locked' });

    const now = new Date();
    contract.signatures[role] = {
      signed: true,
      byUserId: req.user?.id,
      name,
      email,
      at: now
    };

    // Mark legacy flag for compatibility
    if (role === 'influencer') contract.isAccepted = 1;

    await contract.save();
    contract.audit.push({ type: 'SIGNED', role, details: { name, email } });
    await contract.save();

    const allSigned = contract.signatures.brand?.signed && contract.signatures.influencer?.signed && contract.signatures.collabglam?.signed;
    if (allSigned) {
      // Lock + set Effective Date to last signature time in TZ (stored in UTC)
      const lastAt = [contract.signatures.brand.at, contract.signatures.influencer.at, contract.signatures.collabglam.at]
        .filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b))
        .pop() || now;

      contract.effectiveDate = lastAt;
      contract.effectiveDateTimezone = contract.green?.timezone || 'America/Los_Angeles';

      // Optional admin override
      if (effectiveDateOverride && req.user?.isAdmin) {
        contract.effectiveDateOverride = new Date(effectiveDateOverride);
      }

      // Freeze snapshot of tokens/template
      const tokens = buildTokenMap(contract);
      const templateText = contract.green?.legalTemplateText || MASTER_TEMPLATE;
      const rendered = renderTemplate(templateText, tokens);

      contract.templateVersion = contract.green?.legalTemplateVersion || 1;
      contract.templateTokensSnapshot = tokens;
      contract.renderedTextSnapshot = rendered;

      contract.lockedAt = new Date();
      await contract.save();

      contract.audit.push({ type: 'LOCKED', role: 'system', details: { effectiveDate: contract.effectiveDate, override: contract.effectiveDateOverride || null } });
      await contract.save();
    }

    return res.json({ message: allSigned ? 'Signed & locked' : 'Signature recorded', contract });
  } catch (err) {
    console.error('sign error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 7) RESEND (Brand) — clears reject flags, bumps resend count
 * POST /contract/resend
 * Body: contractId, brandId, yellowUpdates? (allowed limited), reason?
 */
exports.resendContract = async (req, res) => {
  try {
    const { contractId, brandId, yellowUpdates = {} } = req.body;
    if (!contractId || !brandId) return res.status(400).json({ message: 'contractId and brandId are required' });

    const contract = await Contract.findOne({ contractId, brandId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.lockedAt) return res.status(400).json({ message: 'Contract is locked' });

    // Whitelist: brand-owned (YELLOW) fields only
    const allowed = ['campaignTitle', 'platforms', 'goLive', 'totalFee', 'currency', 'milestoneSplit', 'usageBundle', 'revisionsIncluded', 'deliverablesPresetKey', 'deliverablesExpanded'];
    Object.keys(yellowUpdates).forEach(k => {
      if (allowed.includes(k)) {
        if (k === 'goLive' && yellowUpdates.goLive?.start) {
          // Recompute draft due if start moved
          const dd = clampDraftDue(yellowUpdates.goLive.start);
          (contract.yellow.deliverablesExpanded || []).forEach(d => {
            if (d.draftRequired) d.draftDueDate = dd;
          });
          contract.grey.autoCalcs.firstDraftDue = dd;
        }
        contract.yellow[k] = yellowUpdates[k];
      }
    });

    contract.isRejected = 0;
    contract.rejectedReason = '';
    contract.rejectedAt = undefined;
    contract.isAssigned = 1;
    contract.lastSentAt = new Date();
    contract.resendCount = (contract.resendCount || 0) + 1;
    await contract.save();

    contract.audit.push({ type: 'RESENT', role: 'brand', details: { yellowUpdates: Object.keys(yellowUpdates) } });
    await contract.save();

    return res.json({ message: 'Contract resent successfully', contract });
  } catch (err) {
    console.error('resendContract error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 8) REJECT (Influencer) — same milestone guard
 * POST /contract/reject
 * Body: contractId, influencerId, reason
 */
exports.rejectContract = async (req, res) => {
  try {
    const { contractId, influencerId, reason = '' } = req.body;
    if (!contractId || !influencerId) {
      return res.status(400).json({ message: 'contractId and influencerId are required' });
    }
    const contract = await Contract.findOne({ contractId, influencerId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });
    if (contract.lockedAt) return res.status(400).json({ message: 'Contract is locked' });
    if (contract.isAccepted === 1) return res.status(400).json({ message: 'Contract already accepted' });
    if (contract.isRejected === 1) return res.status(400).json({ message: 'Contract already rejected' });

    const msSet = await milestoneSetForInfluencer(contract.influencerId, [toStr(contract.campaignId)]);
    if (msSet.has(toStr(contract.campaignId))) {
      return res.status(400).json({ message: 'Milestone already exists, cannot reject now' });
    }

    contract.isRejected = 1;
    contract.rejectedReason = reason;
    contract.rejectedAt = new Date();
    await contract.save();

    // optional ApplyCampaign mark
    await ApplyCampaign.updateOne(
      { campaignId: contract.campaignId, 'applicants.influencerId': influencerId },
      { $set: { 'applicants.$.isRejected': 1 } }
    ).catch(() => { });

    contract.audit.push({ type: 'REJECTED', role: 'influencer', details: { reason } });
    await contract.save();

    return res.json({ message: 'Contract rejected successfully', contract });
  } catch (err) {
    console.error('rejectContract error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 9) LEGACY send-or-generate (kept for backward compatibility)
 * POST /contract/send-or-generate
 * Now proxies to /contract/initiate behavior with basic mapping
 */
exports.sendOrGenerateContract = async (req, res) => {
  try {
    const {
      brandId, influencerId, campaignId,
      effectiveDate,
      brandName, brandAddress,
      influencerName, influencerAddress, influencerHandle,
      feeAmount, paymentTerms,
      type
    } = req.body;

    // map to new model
    const yellow = {
      campaignTitle: (await Campaign.findOne({ campaignsId: campaignId }))?.title || '',
      platforms: ['YouTube', 'Instagram', 'TikTok'],
      goLive: {
        start: (await Campaign.findOne({ campaignsId: campaignId }))?.timeline?.startDate,
        end: (await Campaign.findOne({ campaignsId: campaignId }))?.timeline?.endDate
      },
      totalFee: Number(feeAmount) || 0,
      currency: 'USD',
      milestoneSplit: '50/50',
      revisionsIncluded: 1,
      deliverablesPresetKey: 'legacy',
      deliverablesExpanded: [{
        type: 'Scope (Legacy)',
        quantity: 1,
        format: 'Text',
        durationSec: 0,
        postingWindow: { start: undefined, end: undefined },
        draftRequired: false,
        minLiveHours: 0,
        tags: [],
        handles: [influencerHandle].filter(Boolean),
        captions: paymentTerms || '',
        links: [],
        disclosures: ''
      }]
    };

    req.body.brandId = brandId; // keep body consistent
    req.body.influencerId = influencerId;
    req.body.campaignId = campaignId;
    req.body.yellow = yellow;
    req.body.type = type;

    return exports.initiate(req, res);
  } catch (err) {
    console.error('sendOrGenerateContract error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 10) GET contracts for Brand+Influencer (unchanged)
 * POST /contract/get
 */
exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId } = req.body;
    if (!brandId || !influencerId) {
      return res.status(400).json({ message: 'brandId and influencerId are required' });
    }
    const contracts = await Contract.find({ brandId, influencerId }).sort({ createdAt: -1 });
    if (!contracts.length) {
      return res.status(404).json({ message: 'No contracts found for that Brand & Influencer' });
    }
    res.status(200).json({ contracts });
  } catch (err) {
    console.error('Error fetching contracts:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * 11) Accept (legacy) — just marks influencer signature as signed
 * POST /contract/accept
 */
exports.acceptContract = async (req, res) => {
  try {
    const { contractId, name, email } = req.body;
    if (!contractId) return res.status(400).json({ message: 'contractId is required' });

    const contract = await Contract.findOne({ contractId });
    if (!contract) return res.status(404).json({ message: 'Contract not found' });

    // mark influencer signature
    contract.signatures.influencer = {
      signed: true,
      byUserId: req.user?.id,
      name,
      email,
      at: new Date()
    };
    contract.isAccepted = 1;
    await contract.save();

    contract.audit.push({ type: 'SIGNED', role: 'influencer', details: { name, email } });
    await contract.save();

    return res.status(200).json({ message: 'Contract approved successfully', contract });
  } catch (err) {
    console.error('Error approving contract:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * 12) Brand list of rejected contracts
 * POST /contract/brand-rejected
 */
exports.getRejectedContractsByBrand = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10 } = req.body;
    if (!brandId) return res.status(400).json({ message: 'brandId is required' });

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const filter = {
      brandId,
      isRejected: 1,
      isAccepted: { $ne: 1 }
    };

    const [total, contracts] = await Promise.all([
      Contract.countDocuments(filter),
      Contract.find(filter).sort({ rejectedAt: -1 }).skip(skip).limit(limNum).lean()
    ]);

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      contracts
    });
  } catch (err) {
    console.error('getRejectedContractsByBrand error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * 13) Influencer list of rejected contracts (+ campaign details)
 * POST /contract/influencer-rejected
 */
exports.getRejectedContractsByInfluencer = async (req, res) => {
  try {
    const { influencerId, page = 1, limit = 10, search = '' } = req.body;
    if (!influencerId) {
      return res.status(400).json({ message: 'influencerId is required' });
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limNum;

    const baseMatch = { influencerId };
    if (search.trim()) {
      const term = search.trim();
      const regex = new RegExp(term, 'i');
      baseMatch.$or = [
        { 'grey.brandProfile.legalName': regex },
        { campaignId: regex },
        { 'yellow.campaignTitle': regex },
        { 'yellow.totalFee': regex }
      ];
    }

    const grouped = await Contract.aggregate([
      { $match: baseMatch },
      { $sort: { lastSentAt: -1, createdAt: -1 } },
      { $group: { _id: '$campaignId', doc: { $first: '$$ROOT' } } },
      { $match: { 'doc.isRejected': 1, 'doc.isAccepted': { $ne: 1 } } }
    ]);

    if (!grouped.length) {
      return res.json({
        meta: { total: 0, page: pageNum, limit: limNum, totalPages: 0 },
        contracts: []
      });
    }

    const campaignIds = grouped.map(g => g._id);
    const campaigns = await Campaign.find({ campaignsId: { $in: campaignIds } })
      .populate('interestId', 'name')
      .lean();

    const campaignMap = new Map(campaigns.map(c => [c.campaignsId, c]));
    const merged = grouped.map(g => ({ ...g.doc, campaign: campaignMap.get(g._id) || null }));

    const total = merged.length;
    const paged = merged.slice(skip, skip + limNum);

    return res.json({
      meta: { total, page: pageNum, limit: limNum, totalPages: Math.ceil(total / limNum) },
      contracts: paged
    });
  } catch (err) {
    console.error('getRejectedContractsByInfluencer error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
};
