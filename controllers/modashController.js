'use strict';

require('dotenv').config();
const { fetch } = require('undici');

const MODASH_API_KEY = process.env.MODASH_API_KEY;
const MODASH_BASE_URL = process.env.MODASH_BASE_URL || 'https://api.modash.io/v1';
const MODASH_AUTH_HEADER = (process.env.MODASH_AUTH_HEADER || '').toLowerCase(); // optional override

if (!MODASH_API_KEY) {
  throw new Error('MODASH_API_KEY is missing. Add it to your environment.');
}

const ALLOWED_PLATFORMS = new Set(['instagram', 'youtube', 'tiktok']);

/* ------------------------------- Auth headers ------------------------------ */
// Build one header style
function headerVariant(kind, rawKey) {
  const key = String(rawKey).trim();
  const bearerToken = key.replace(/^bearer\s+/i, '');
  const h = { 'content-type': 'application/json' };

  if (kind === 'authorization') {
    h.authorization = `Bearer ${bearerToken}`;
  } else if (kind === 'accesstoken') {
    h.accesstoken = bearerToken; // exact header name per some Modash builds
  } else {
    h['x-api-key'] = key;
  }
  return h;
}

// Determine the initial preference, but we’ll auto-fallback on 403
function primaryHeaderKind() {
  if (MODASH_AUTH_HEADER === 'authorization') return 'authorization';
  if (MODASH_AUTH_HEADER === 'accesstoken' || MODASH_AUTH_HEADER === 'accessToken') return 'accesstoken';
  if (/^bearer\s+/i.test(MODASH_API_KEY)) return 'authorization';
  return 'x-api-key';
}

// Order we’ll try on a 403
function fallbackKinds(primary) {
  const all = ['x-api-key', 'authorization', 'accesstoken'];
  return [primary, ...all.filter(k => k !== primary)];
}

/* -------------------------------- Utilities -------------------------------- */
function toQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// Low-level request with automatic header fallbacks on 403
async function modashRequest({ method, path, query, body }) {
  const url = `${MODASH_BASE_URL}${path}${toQuery(query)}`;
  const kinds = fallbackKinds(primaryHeaderKind());

  let lastErr;
  for (const kind of kinds) {
    try {
      const res = await fetch(url, {
        method,
        headers: headerVariant(kind, MODASH_API_KEY),
        body: body ? JSON.stringify(body) : undefined
      });

      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok) {
        const err = new Error(json?.message || `Modash ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.response = json || undefined;

        // If this try used a non-primary header and still 403 → no more fallbacks can help
        if (res.status === 403) {
          lastErr = err;
          // try next header kind if available
          continue;
        }
        throw err;
      }

      // success
      return json;
    } catch (e) {
      // Network-level (not HTTP) error — keep for possible fallback try
      lastErr = e;
      // continue to next header variant
    }
  }

  // If we exhausted all variants
  throw lastErr || new Error('Unknown Modash error');
}

async function modashGET(path, query) {
  return modashRequest({ method: 'GET', path, query });
}
async function modashPOST(path, body) {
  return modashRequest({ method: 'POST', path, body });
}

/* --------------------------------- Search --------------------------------- */
async function searchForUsername(platform, username) {
  const clean = String(username).replace(/^@/, '').trim();
  if (!clean) return null;

  const body = {
    page: 1,
    calculationMethod: 'median',
    sort: { field: 'relevance', direction: 'desc' },
    filter: { influencer: { relevance: [`@${clean}`] } }
  };

  const result = await modashPOST(`/${platform}/search`, body);

  const candidates = [
    ...(Array.isArray(result?.directs) ? result.directs : []),
    ...(Array.isArray(result?.lookalikes) ? result.lookalikes : [])
  ];

  if (!candidates.length) return null;

  const target =
    candidates.find((it) => {
      const prof = it?.profile || {};
      const u = String(prof.username || '').toLowerCase();
      const h = String(prof.handle || '').toLowerCase().replace(/^@/, '');
      const c = clean.toLowerCase();
      return u === c || h === c;
    }) || candidates[0];

  if (!target) return null;

  const prof = target.profile || {};
  const id = target.userId || prof.userId;
  if (!id) return null;

  return {
    userId: String(id),
    username: String(prof.username || '').trim(),
    handle: String(prof.handle || '').trim(),
    picture: prof.picture,
    url: prof.url,
    followers: prof.followers
  };
}

/* --------------------------------- Report --------------------------------- */
async function getReport(platform, userIdOrHandle) {
  const id = String(userIdOrHandle).trim();
  return modashGET(`/${platform}/profile/${encodeURIComponent(id)}/report`, {
    calculationMethod: 'median'
  });
}

/* ----------------------------- Normalization ------------------------------ */
function buildPreviewFromReport(reportJSON) {
  const p = reportJSON?.profile || {};
  const prof = p.profile || p;
  return {
    fullname: prof.fullname || null,
    username: prof.username || null,
    followers: typeof prof.followers === 'number' ? prof.followers : null,
    picture: prof.picture || null,
    url: prof.url || null
  };
}

function normalizeReport(reportJSON) {
  const p = reportJSON?.profile || {};
  const prof = p.profile || p;

  return {
    profile: {
      userId: p.userId || prof.userId,
      username: prof.username,
      fullname: prof.fullname,
      handle: prof.handle || (prof.username ? `@${prof.username}` : undefined),
      url: prof.url,
      picture: prof.picture,
      followers: prof.followers,
      engagements: prof.engagements,
      engagementRate: prof.engagementRate,
      averageViews: prof.averageViews
    },
    isPrivate: p.isPrivate,
    isVerified: p.isVerified,
    accountType: p.accountType,
    secUid: p.secUid,
    city: p.city,
    state: p.state,
    country: p.country,
    ageGroup: p.ageGroup,
    gender: p.gender,
    language: p.language,
    statsByContentType: p.statsByContentType,
    stats: p.stats,
    recentPosts: p.recentPosts,
    popularPosts: p.popularPosts,
    postsCount: p.postsCount ?? p.postsCounts,
    avgLikes: p.avgLikes,
    avgComments: p.avgComments,
    avgViews: p.avgViews,
    avgReelsPlays: p.avgReelsPlays,
    totalLikes: p.totalLikes,
    totalViews: p.totalViews,
    bio: p.description || p.bio,
    hashtags: p.hashtags,
    mentions: p.mentions,
    brandAffinity: p.brandAffinity,
    audience: p.audience,
    audienceCommenters: p.audienceCommenters,
    lookalikes: p.lookalikes || p.audienceLookalikes,
    audienceExtra: p.audienceExtra,
    sponsoredPosts: p.sponsoredPosts,
    paidPostPerformance: p.paidPostPerformance,
    paidPostPerformanceViews: p.paidPostPerformanceViews,
    sponsoredPostsMedianViews: p.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: p.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: p.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: p.nonSponsoredPostsMedianLikes,
    providerRaw: reportJSON
  };
}

/* ------------------------------- Controller ------------------------------- */
exports.resolveProfile = async (req, res) => {
  try {
    let { platform, username } = req.body || {};
    platform = String(platform || '').toLowerCase().trim();
    username = String(username || '').trim();
    if (username.startsWith('@')) username = username.slice(1);

    if (!ALLOWED_PLATFORMS.has(platform)) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }
    if (!username) {
      return res.status(400).json({ message: 'username (handle) is required' });
    }

    let reportJSON = null;
    let userIdResolved = null;

    // First try report directly with handle
    try {
      reportJSON = await getReport(platform, username);
      userIdResolved = reportJSON?.profile?.userId || reportJSON?.profile?.profile?.userId || null;
    } catch (e) {
      // 403 here almost always means token/header/plan problem → bubble up clearly
      if (e.status === 403) {
        return res.status(403).json({
          message: 'Forbidden from Modash. Verify your API key / header type and that your plan allows the report endpoint.',
          details: e.response || undefined
        });
      }
      // 404/400 → try search
      if (e.status !== 404 && e.status !== 400) throw e;
    }

    // If direct handle failed, search to resolve userId
    if (!reportJSON) {
      const hit = await searchForUsername(platform, username);
      if (!hit?.userId) {
        return res.status(404).json({ message: 'No profile found for that username' });
      }
      userIdResolved = hit.userId;

      // Now try report by userId
      try {
        reportJSON = await getReport(platform, userIdResolved);
      } catch (e) {
        if (e.status === 403) {
          return res.status(403).json({
            message:
              'Forbidden from Modash when fetching the report. Your API key/plan likely lacks access to /profile/{id}/report.',
            details: e.response || undefined
          });
        }
        throw e;
      }
    }

    const normalized = normalizeReport(reportJSON);
    const preview = buildPreviewFromReport(reportJSON);

    return res.json({
      message: 'ok',
      provider: platform,
      userId: userIdResolved || normalized?.profile?.userId || null,
      preview,
      providerRaw: reportJSON,
      data: normalized
    });
  } catch (e) {
    if (e.status === 403) {
      return res.status(403).json({
        message: 'Forbidden from Modash. Verify your API key / plan and endpoint access.',
        details: e.response || undefined
      });
    }
    if (e.status === 404) {
      return res.status(404).json({ message: 'No profile found' });
    }
    console.error('resolveProfile error:', e);
    return res.status(500).json({ message: e.message || 'Modash error' });
  }
};

// Optional passthrough search endpoint
exports.search = async (req, res) => {
  try {
    const { platform, ...body } = req.body || {};
    const p = String(platform || '').toLowerCase().trim();
    if (!ALLOWED_PLATFORMS.has(p)) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }
    const data = await modashPOST(`/${p}/search`, body || {});
    return res.json(data);
  } catch (e) {
    if (e.status === 403) {
      return res.status(403).json({ message: 'Forbidden from Modash', details: e.response || undefined });
    }
    return res.status(500).json({ message: e.message || 'Modash error' });
  }
};
