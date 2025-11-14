'use strict';

require('dotenv').config();
const { fetch } = require('undici');

const ModashProfile = require('../models/modash');
const Influencer = require('../models/influencer');

const MODASH_API_KEY = process.env.MODASH_API_KEY;
const MODASH_BASE_URL = process.env.MODASH_BASE_URL || 'https://api.modash.io/v1';
const MODASH_AUTH_HEADER = (process.env.MODASH_AUTH_HEADER || '').toLowerCase(); // optional override

if (!MODASH_API_KEY) {
  throw new Error('MODASH_API_KEY is missing. Add it to your environment.');
}

const ALLOWED_PLATFORMS = new Set(['instagram', 'youtube', 'tiktok']);

/* -------------------------------------------------------------------------- */
/*                               Auth header logic                            */
/* -------------------------------------------------------------------------- */

/**
 * Map normalized legacy report -> Modash model fields
 */
function mapReportToModashDoc(normalized, platform, influencerDoc) {
  const prof = normalized.profile || {};

  return {
    // Relations
    influencer: influencerDoc ? influencerDoc._id : undefined,
    influencerId: influencerDoc ? influencerDoc.influencerId : undefined,

    // Core
    provider: platform,
    userId: prof.userId,
    username: prof.username,
    fullname: prof.fullname,
    handle: prof.handle,
    url: prof.url,
    picture: prof.picture,

    followers: prof.followers,
    engagements: prof.engagements,
    engagementRate: prof.engagementRate,
    averageViews: prof.averageViews,

    isPrivate: normalized.isPrivate,
    isVerified: normalized.isVerified,
    accountType: normalized.accountType,
    secUid: normalized.secUid,

    city: normalized.city,
    state: normalized.state,
    country: normalized.country,
    ageGroup: normalized.ageGroup,
    gender: normalized.gender,
    language: normalized.language,

    statsByContentType: normalized.statsByContentType,
    stats: normalized.stats,
    recentPosts: normalized.recentPosts,
    popularPosts: normalized.popularPosts,

    postsCount: normalized.postsCount,
    avgLikes: normalized.avgLikes,
    avgComments: normalized.avgComments,
    avgViews: normalized.avgViews,
    avgReelsPlays: normalized.avgReelsPlays,
    totalLikes: normalized.totalLikes,
    totalViews: normalized.totalViews,

    bio: normalized.bio,

    categories: normalized.categories || [],

    hashtags: normalized.hashtags || [],
    mentions: normalized.mentions || [],
    brandAffinity: normalized.brandAffinity || [],

    audience: normalized.audience,
    audienceCommenters: normalized.audienceCommenters,
    lookalikes: normalized.lookalikes || [],

    sponsoredPosts: normalized.sponsoredPosts || [],
    paidPostPerformance: normalized.paidPostPerformance,
    paidPostPerformanceViews: normalized.paidPostPerformanceViews,
    sponsoredPostsMedianViews: normalized.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: normalized.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: normalized.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: normalized.nonSponsoredPostsMedianLikes,

    audienceExtra: normalized.audienceExtra,
    providerRaw: normalized.providerRaw,
  };
}

async function upsertModashProfileFromReport({ platform, reportJSON, influencerId, fetchedAt }) {
  if (!reportJSON) return null;

  const normalized = normalizeReportLegacy(reportJSON);
  const prof = normalized.profile || {};
  if (!prof.userId) {
    // No stable id → nothing to store safely
    return null;
  }

  let influencerDoc = null;

  // Try to link to your internal Influencer (if provided)
  if (influencerId) {
    influencerDoc = await Influencer.findOne({ influencerId }).select('_id influencerId');
    if (!influencerDoc) {
      console.warn('[modash] No Influencer found for influencerId=', influencerId);
    }
  }

  const now = fetchedAt || new Date();

  // Build base doc data from normalized report
  const docData = Object.assign(
    {},
    mapReportToModashDoc(normalized, platform, influencerDoc),
    {
      providerRaw: reportJSON,
      lastFetchedAt: now,
    }
  );

  // Build an upsert query:
  // - If we have a linked Influencer → key by influencer+provider
  // - Else → key by userId+provider (pure Modash cache)
  const query = { provider: platform };

  if (influencerDoc && influencerDoc._id) {
    query.influencer = influencerDoc._id;
  } else {
    query.userId = prof.userId;
  }

  const saved = await ModashProfile.findOneAndUpdate(
    query,
    { $set: docData },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return saved;
}

async function findCachedReport({ platform, userId, influencerId }) {
  const q = { provider: platform };

  if (influencerId) {
    q.influencerId = influencerId;
  } else if (userId) {
    q.userId = userId;
  } else {
    return null;
  }

  const doc = await ModashProfile.findOne(q).lean();
  if (!doc || !doc.providerRaw) return null;

  return {
    providerRaw: doc.providerRaw,
    lastFetchedAt: doc.lastFetchedAt || doc.updatedAt || doc.createdAt || null,
  };
}

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

// Determine initial preference
function primaryHeaderKind() {
  if (MODASH_AUTH_HEADER === 'authorization') return 'authorization';
  if (MODASH_AUTH_HEADER === 'accesstoken' || MODASH_AUTH_HEADER === 'accessToken') return 'accesstoken';
  if (/^bearer\s+/i.test(MODASH_API_KEY)) return 'authorization';
  return 'x-api-key';
}

// Order we’ll try on a 403
function fallbackKinds(primary) {
  const all = ['x-api-key', 'authorization', 'accesstoken'];
  return [primary, ...all.filter((k) => k !== primary)];
}

/* -------------------------------------------------------------------------- */
/*                             Low-level Modash calls                         */
/* -------------------------------------------------------------------------- */

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
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        const err = new Error(
          (json && (json.message || json.error)) ||
            `Modash ${res.status} ${res.statusText}`
        );
        err.status = res.status;
        err.response = json || undefined;

        // 403 may be header-style related; try next header kind
        if (res.status === 403) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      // success
      return json;
    } catch (e) {
      lastErr = e;
      // try next header variant
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

/* -------------------------------------------------------------------------- */
/*                        Helpers shared by frontend APIs                     */
/* -------------------------------------------------------------------------- */

/** Convert to finite number (or undefined) */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Prefer the first non-empty trimmed string, else undefined
function firstNonEmpty() {
  for (const v of arguments) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

// Extract @handle from a YouTube URL like https://youtube.com/@somehandle
function extractYouTubeHandleFromUrl(u) {
  if (!u) return undefined;
  const m = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

// Some Modash shapes nest the primary data differently
function pickPrimarySrc(item) {
  return (item && (item.profile || item.channel || item.creator || item.user)) || item;
}

/** ---------- Normalization / Dedupe for search ---------- */

function normalizeSearchItem(item, platform) {
  const src = pickPrimarySrc(item);

  const url = firstNonEmpty(src && src.url, src && src.channelUrl, src && src.profileUrl);
  const derivedHandleFromUrl = extractYouTubeHandleFromUrl(url);

  // Expand possible handle fields and strip a leading '@' if present
  const rawUsername = firstNonEmpty(
    src && src.username,
    src && src.handle,
    src && src.channelHandle,
    src && src.slug,
    src && src.customUrl,
    src && src.vanityUrl,
    derivedHandleFromUrl
  );
  const username = rawUsername ? rawUsername.replace(/^@/, '') : undefined;

  const userId = String(
    (item && item.userId) ||
      (src && src.userId) ||
      (src && src.id) ||
      (src && src.channelId) ||
      (src && src.profileId) ||
      ''
  )
    .trim() || undefined;

  return {
    userId,
    username,
    fullname:
      (src && (src.fullName || src.fullname || src.display_name || src.title || src.name)) || '',
    followers:
      toNum(src && (src.followers || src.followerCount || (src.stats && src.stats.followers))) || 0,
    engagementRate:
      toNum(src && (src.engagementRate || (src.stats && src.stats.engagementRate))) || 0,
    engagements: toNum(
      src &&
        (src.engagements ||
          (src.stats && (src.stats.avgEngagements || src.stats.avgLikes)))
    ),
    averageViews: toNum(
      src &&
        (src.averageViews ||
          (src.stats && src.stats.avgViews) ||
          src.avgViews)
    ),
    picture:
      (src &&
        (src.picture ||
          src.avatar ||
          src.profilePicUrl ||
          src.thumbnail ||
          src.channelThumbnailUrl)) ||
      undefined,
    url,
    isVerified: Boolean(src && (src.isVerified || src.verified)),
    isPrivate: Boolean(src && src.isPrivate),
    platform,
  };
}

// Prefer entries with verification, then ones that actually have a username
function betterSearchResult(a, b) {
  if (a.isVerified !== b.isVerified) return a.isVerified ? a : b;
  if (!!a.username !== !!b.username) return a.username ? a : b; // prefer item with a username
  if ((a.followers || 0) !== (b.followers || 0)) return (a.followers || 0) > (b.followers || 0) ? a : b;
  if ((a.engagementRate || 0) !== (b.engagementRate || 0))
    return (a.engagementRate || 0) > (b.engagementRate || 0) ? a : b;
  if ((a.engagements || 0) !== (b.engagements || 0))
    return (a.engagements || 0) > (b.engagements || 0) ? a : b;
  if (!!a.url !== !!b.url) return a.url ? a : b;
  if (!!a.picture !== !!b.picture) return a.picture ? a : b;
  return a;
}

function dedupeSearchItems(items) {
  const map = new Map();
  for (const it of items) {
    const keyBase =
      (it.userId && String(it.userId).toLowerCase()) ||
      (it.username && String(it.username).toLowerCase()) ||
      (it.url && String(it.url).toLowerCase());
    if (!keyBase) continue;

    const key = `${it.platform}:${keyBase}`;
    const prev = map.get(key);
    map.set(key, prev ? betterSearchResult(prev, it) : it);
  }
  return Array.from(map.values());
}

/* ---------- YouTube search body helpers (for /search endpoint) ---------- */

const DEFAULT_YT_SORT = { field: 'followers', direction: 'desc' };
const YT_ALLOWED_AGE = new Set([18, 25, 35, 45, 65]);

function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}

/**
 * Sanitize YouTube body so the API won't silently return empty results.
 */
function sanitizeYouTubeBody(original, opts) {
  const b = deepClone(original || {});
  b.page = b.page != null ? b.page : 0;

  if (!b.sort || !b.sort.field) {
    b.sort = Object.assign({}, b.sort || {}, DEFAULT_YT_SORT);
  }

  if (!b.filter) b.filter = {};
  if (!b.filter.influencer) b.filter.influencer = {};
  if (!b.filter.audience) b.filter.audience = {};

  const infl = b.filter.influencer;
  const aud = b.filter.audience;

  // lastposted must be >= 30 (days)
  if (typeof infl.lastposted === 'number' && infl.lastposted < 30) {
    infl.lastposted = 30;
  }

  // influencer.age min/max must be one of [18,25,35,45,65]
  if (infl.age) {
    const min = infl.age.min;
    const max = infl.age.max;
    if ((min && !YT_ALLOWED_AGE.has(min)) || (max && !YT_ALLOWED_AGE.has(max))) {
      delete infl.age;
    }
  }

  // Can't send both audience.age and audience.ageRange together
  if (aud.age && aud.ageRange) {
    delete aud.ageRange;
  }

  // Drop filterOperations entirely for YouTube
  if (Array.isArray(infl.filterOperations)) {
    delete infl.filterOperations;
  }

  if (opts && opts.relax) {
    delete b.filter.audience;
    delete infl.followersGrowthRate;
    delete infl.views;
    delete infl.engagements;
    if (typeof infl.lastposted === 'number') delete infl.lastposted;
    b.sort = { field: 'followers', direction: 'desc' };
  }

  return b;
}

function buildPlatformBody(platform, body, opts) {
  if (platform !== 'youtube') {
    const copy = deepClone(body || {});
    copy.page = copy.page != null ? copy.page : 0;
    return copy;
  }
  return sanitizeYouTubeBody(body, { relax: opts && opts.relax });
}

/* -------------------------------------------------------------------------- */
/*                          /api/modash/users equivalent                      */
/* -------------------------------------------------------------------------- */

function scoreForQuery(u, qLower) {
  const uname = String(u.username || u.handle || '').toLowerCase();
  const full = String(u.fullname || '').toLowerCase();
  const url = String(u.url || '').toLowerCase();

  if (uname === qLower) return 100;
  if (url.indexOf(`/@${qLower}`) !== -1) return 95;

  if (full === qLower) return 90;
  if (uname.startsWith(qLower)) return 70;
  if (full.startsWith(qLower)) return 60;
  if (uname.indexOf(qLower) !== -1) return 45;
  if (full.indexOf(qLower) !== -1) return 35;

  return 10;
}

/** Merge duplicates by platform+username, keeping the highest-score version */
function dedupeByBest(items) {
  const map = new Map();
  for (const it of items) {
    const uname = String(it.username || it.handle || '').toLowerCase();
    const key = `${it.platform}:${uname}`;
    const prev = map.get(key);
    if (!prev || it.__score > prev.__score) {
      map.set(key, it);
    }
  }
  return Array.from(map.values());
}

/**
 * FRONTEND USERS CONTROLLER
 * Mirrors Next `/api/modash/users` route.
 */
async function frontendUsers(req, res) {
  try {
    const qParam = (req.query.q || '').toString();
    const queries = qParam
      .split(',')
      .map((s) => s.replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean);

    const platformsParam = (req.query.platforms || '').toString();
    const platforms = platformsParam
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((p) => ALLOWED_PLATFORMS.has(p));

    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const matchMode = (req.query.match || 'exact-first').toString().toLowerCase();

    if (!queries.length || !platforms.length) {
      return res.status(400).json({
        error: 'Provide ?q=<handle>[,handle...]&platforms=instagram,tiktok,youtube',
      });
    }

    const collected = [];

    for (const p of platforms) {
      for (const q of queries) {
        const data = await modashGET(`/${p}/users`, {
          limit: 10,
          query: q,
        });

        const users = Array.isArray(data && data.users) ? data.users : [];
        for (const raw of users) {
          const username = raw.username || raw.handle || '';
          const u = {
            platform: p,
            userId: raw.userId,
            username,
            handle: raw.handle,
            fullname: raw.fullname,
            followers: raw.followers,
            isVerified: !!raw.isVerified,
            picture: raw.picture,
            url:
              p === 'instagram'
                ? `https://instagram.com/${username}`
                : p === 'tiktok'
                ? `https://www.tiktok.com/@${username}`
                : `https://www.youtube.com/@${username}`,
          };

          const s = scoreForQuery(u, q);
          collected.push(Object.assign({ __score: s }, u));
        }
      }
    }

    let results = dedupeByBest(collected);

    if (strict) {
      const qset = new Set(queries);
      results = results.filter((u) => {
        const uname = String(u.username || u.handle || '').toLowerCase();
        const url = String(u.url || '').toLowerCase();
        if (qset.has(uname)) return true;
        for (const q of qset) {
          if (url.indexOf(`/@${q}`) !== -1) return true;
        }
        return false;
      });
    }

    // Sort by score, then verified, then followers
    results.sort((a, b) => {
      const sDiff = (b.__score || 0) - (a.__score || 0);
      if (sDiff !== 0) return sDiff;
      if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;
      const af = a.followers || 0;
      const bf = b.followers || 0;
      if (bf !== af) return bf - af;
      return String(a.username || '').localeCompare(String(b.username || ''));
    });

    if (!strict && matchMode === 'exact') {
      const qset = new Set(queries);
      results = results.filter((u) => {
        const uname = String(u.username || u.handle || '').toLowerCase();
        const url = String(u.url || '').toLowerCase();
        if (qset.has(uname)) return true;
        for (const q of qset) {
          if (url.indexOf(`/@${q}`) !== -1) return true;
        }
        return false;
      });
    }

    const safeResults = results.map((r) => {
      const clone = Object.assign({}, r);
      delete clone.__score;
      return clone;
    });

    return res.json({ results: safeResults });
  } catch (err) {
    const raw = (err && err.message) || '';
    const isSensitive = /api token|developer section|modash|authorization|bearer|modash_api_key/i.test(
      String(raw)
    );
    const safe = isSensitive ? 'Lookup failed' : raw || 'Lookup failed';
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                        /api/modash (search) equivalent                     */
/* -------------------------------------------------------------------------- */

/**
 * FRONTEND SEARCH CONTROLLER
 * Mirrors Next `/api/modash` route:
 *  - POST { platforms: Platform[], body: any }
 */
async function frontendSearch(req, res) {
  try {
    const payload = req.body || {};
    const platforms = Array.isArray(payload.platforms) ? payload.platforms : [];
    const body = payload.body || {};

    if (!platforms.length || !body) {
      return res.status(400).json({ error: 'Provide { platforms, body }' });
    }

    const responses = [];

    for (const p of platforms) {
      const platform = String(p || '').toLowerCase();
      if (!ALLOWED_PLATFORMS.has(platform)) {
        return res.status(400).json({ error: `Unsupported platform: ${platform}` });
      }

      const firstBody = buildPlatformBody(platform, body);
      let data = await modashPOST(`/${platform}/search`, firstBody);

      // If YouTube came back empty, try ONE relaxed retry (optional)
      const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
      if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
        const retryBody = buildPlatformBody(platform, body, { relax: true });
        try {
          const retryData = await modashPOST(`/${platform}/search`, retryBody);
          if (retryData && Number((retryData && retryData.total) || 0) > 0) {
            data = retryData;
          }
        } catch {
          // ignore retry failures; keep original empty result
        }
      }

      responses.push({ platform, data });
    }

    const collected = [];

    for (const { platform, data } of responses) {
      const bag = []
        .concat(Array.isArray(data && data.results) ? data.results : [])
        .concat(Array.isArray(data && data.items) ? data.items : [])
        .concat(Array.isArray(data && data.influencers) ? data.influencers : [])
        .concat(Array.isArray(data && data.directs) ? data.directs : [])
        .concat(Array.isArray(data && data.lookalikes) ? data.lookalikes : [])
        .concat(Array.isArray(data && data.users) ? data.users : [])
        .concat(Array.isArray(data && data.channels) ? data.channels : []);

      for (const item of bag) {
        collected.push(normalizeSearchItem(item, platform));
      }
    }

    const merged = dedupeSearchItems(collected);
    const total = responses.reduce(
      (sum, r) => sum + Number((r.data && r.data.total) || 0),
      0
    );

    return res.json({ results: merged, total, unique: merged.length });
  } catch (err) {
    const raw = (err && err.message) || '';
    const isSensitive = /api token|developer section|modash|authorization|bearer|modash_api_key/i.test(
      String(raw)
    );
    const safe = isSensitive ? 'Search failed' : raw || 'Search failed';
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                      /api/modash/report equivalent (simple)                */
/* -------------------------------------------------------------------------- */

function toCalcMethod(input) {
  if (!input) return 'median';
  return String(input).toLowerCase() === 'average' ? 'average' : 'median';
}

/**
 * FRONTEND REPORT CONTROLLER
 * GET ?platform=instagram|tiktok|youtube&userId=...&calculationMethod=...
 * Optional:
 *  - influencerId
 *  - force=1 / refresh=1 → bypass cache
 */
async function frontendReport(req, res) {
  try {
    const platform = (req.query.platform || '').toString().toLowerCase();
    const userId = (req.query.userId || '').toString();
    const calculationMethod = toCalcMethod(req.query.calculationMethod);

    const influencerId =
      (req.query.influencerId || req.query.influencer_id || '')
        .toString()
        .trim() || null;

    const forceFresh =
      req.query.force === '1' ||
      req.query.force === 'true' ||
      req.query.refresh === '1' ||
      req.query.refresh === 'true';

    if (!platform || !ALLOWED_PLATFORMS.has(platform)) {
      return res
        .status(400)
        .json({ error: 'platform must be instagram|tiktok|youtube' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    /* -------------------- 1) Try DB cache first -------------------- */
    if (!forceFresh) {
      try {
        const cached = await findCachedReport({ platform, userId, influencerId });
        if (cached) {
          const out = Object.assign({}, cached.providerRaw);
          if (cached.lastFetchedAt) {
            const d = new Date(cached.lastFetchedAt);
            if (!isNaN(d.getTime())) {
              out._lastFetchedAt = d.toISOString();
            }
          }
          return res.json(out);
        }
      } catch (cacheErr) {
        console.error('[modash] Cache lookup failed:', cacheErr);
        // continue to live Modash call
      }
    }

    /* ---------------- 2) Fallback: call Modash API ----------------- */
    try {
      const fetchedAt = new Date();

      const data = await modashGET(
        `/${platform}/profile/${encodeURIComponent(userId)}/report`,
        { calculationMethod }
      );

      // Persist into Modash collection (best-effort)
      try {
        await upsertModashProfileFromReport({
          platform,
          reportJSON: data,
          influencerId,
          fetchedAt,
        });
      } catch (saveErr) {
        console.error('[modash] Failed to upsert Modash profile:', saveErr);
      }

      const out = Object.assign({}, data, {
        _lastFetchedAt: fetchedAt.toISOString(),
      });

      return res.json(out);
    } catch (e) {
      const raw = (e && e.message) || '';
      let safeMsg = 'Report unavailable';

      try {
        const errResp = e && e.response;
        const rawMsg =
          (errResp && (errResp.message || errResp.error)) || raw;
        const isSensitive =
          /api token|developer section|modash|authorization|bearer|modash_api_key|marketer\.modash\.io/i.test(
            String(rawMsg)
          );
        safeMsg = isSensitive ? 'Report unavailable' : rawMsg || safeMsg;
      } catch {
        // ignore
      }

      const status = (e && e.status) ? e.status : 502;
      return res.status(status).json({ error: safeMsg });
    }
  } catch (err) {
    const raw = (err && err.message) || '';
    return res.status(500).json({ error: raw || 'Internal error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                       Existing resolveProfile + search                     */
/* -------------------------------------------------------------------------- */

/* --- Legacy helpers for resolveProfile --- */

async function searchForUsername(platform, username) {
  const clean = String(username || '').replace(/^@/, '').trim();
  if (!clean) return null;

  const body = {
    page: 1,
    calculationMethod: 'median',
    sort: { field: 'relevance', direction: 'desc' },
    filter: { influencer: { relevance: [`@${clean}`] } },
  };

  const result = await modashPOST(`/${platform}/search`, body);

  const candidates = []
    .concat(Array.isArray(result && result.directs) ? result.directs : [])
    .concat(Array.isArray(result && result.lookalikes) ? result.lookalikes : []);

  if (!candidates.length) return null;

  const target =
    candidates.find((it) => {
      const prof = (it && it.profile) || {};
      const u = String(prof.username || '').toLowerCase();
      const h = String(prof.handle || '').toLowerCase().replace(/^@/, '');
      const c = clean.toLowerCase();
      return u === c || h === c;
    }) || candidates[0];

  if (!target) return null;

  const prof = (target && target.profile) || {};
  const id = target.userId || prof.userId;
  if (!id) return null;

  return {
    userId: String(id),
    username: String(prof.username || '').trim(),
    handle: String(prof.handle || '').trim(),
    picture: prof.picture,
    url: prof.url,
    followers: prof.followers,
  };
}

async function getReportLegacy(platform, userIdOrHandle) {
  const id = String(userIdOrHandle).trim();
  return modashGET(`/${platform}/profile/${encodeURIComponent(id)}/report`, {
    calculationMethod: 'median',
  });
}

function buildPreviewFromReport(reportJSON) {
  const p = (reportJSON && reportJSON.profile) || {};
  const prof = p.profile || p;
  return {
    fullname: prof.fullname || null,
    username: prof.username || null,
    followers:
      typeof prof.followers === 'number' ? prof.followers : null,
    picture: prof.picture || null,
    url: prof.url || null,
  };
}

function normalizeReportLegacy(reportJSON) {
  const p = (reportJSON && reportJSON.profile) || {};
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
      averageViews: prof.averageViews,
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
    postsCount: p.postsCount || p.postsCounts,
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
    providerRaw: reportJSON,
  };
}

/**
 * Legacy: resolveProfile
 */
async function resolveProfile(req, res) {
  try {
    let platform = (req.body && req.body.platform) || '';
    let username = (req.body && req.body.username) || '';

    platform = String(platform || '').toLowerCase().trim();
    username = String(username || '').trim();
    if (username.startsWith('@')) username = username.slice(1);

    if (!ALLOWED_PLATFORMS.has(platform)) {
      return res
        .status(400)
        .json({ message: 'platform must be instagram | youtube | tiktok' });
    }
    if (!username) {
      return res.status(400).json({ message: 'username (handle) is required' });
    }

    let reportJSON = null;
    let userIdResolved = null;

    // First try report directly with handle
    try {
      reportJSON = await getReportLegacy(platform, username);
      userIdResolved =
        (reportJSON &&
          reportJSON.profile &&
          (reportJSON.profile.userId ||
            (reportJSON.profile.profile &&
              reportJSON.profile.profile.userId))) ||
        null;
    } catch (e) {
      if (e && e.status === 403) {
        return res.status(403).json({
          message:
            'Forbidden from Modash. Verify your API key / header type and that your plan allows the report endpoint.',
          details: e.response || undefined,
        });
      }
      if (!e || (e.status !== 404 && e.status !== 400)) throw e;
    }

    // If direct handle failed, search to resolve userId
    if (!reportJSON) {
      const hit = await searchForUsername(platform, username);
      if (!hit || !hit.userId) {
        return res
          .status(404)
          .json({ message: 'No profile found for that username' });
      }
      userIdResolved = hit.userId;

      try {
        reportJSON = await getReportLegacy(platform, userIdResolved);
      } catch (e) {
        if (e && e.status === 403) {
          return res.status(403).json({
            message:
              'Forbidden from Modash when fetching the report. Your API key/plan likely lacks access to /profile/{id}/report.',
            details: e.response || undefined,
          });
        }
        throw e;
      }
    }

    const normalized = normalizeReportLegacy(reportJSON);
    const preview = buildPreviewFromReport(reportJSON);

    return res.json({
      message: 'ok',
      provider: platform,
      userId: userIdResolved || (normalized.profile && normalized.profile.userId) || null,
      preview,
      providerRaw: reportJSON,
      data: normalized,
    });
  } catch (e) {
    if (e && e.status === 403) {
      return res.status(403).json({
        message:
          'Forbidden from Modash. Verify your API key / plan and endpoint access.',
        details: e.response || undefined,
      });
    }
    if (e && e.status === 404) {
      return res.status(404).json({ message: 'No profile found' });
    }
    console.error('resolveProfile error:', e);
    return res
      .status(500)
      .json({ message: (e && e.message) || 'Modash error' });
  }
}

/**
 * Legacy simple passthrough search
 */
async function legacySearch(req, res) {
  try {
    const platform = String((req.body && req.body.platform) || '')
      .toLowerCase()
      .trim();
    if (!ALLOWED_PLATFORMS.has(platform)) {
      return res
        .status(400)
        .json({ message: 'platform must be instagram | youtube | tiktok' });
    }

    const body = Object.assign({}, req.body);
    delete body.platform;

    const data = await modashPOST(`/${platform}/search`, body || {});
    return res.json(data);
  } catch (e) {
    if (e && e.status === 403) {
      return res.status(403).json({
        message: 'Forbidden from Modash',
        details: e.response || undefined,
      });
    }
    return res
      .status(500)
      .json({ message: (e && e.message) || 'Modash error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

module.exports = {
  // New frontend APIs
  frontendUsers,    // GET /modash/users
  frontendSearch,   // POST /modash/search
  frontendReport,   // GET /modash/report

  // Legacy endpoints
  resolveProfile,   // POST /modash/resolveProfile
  search: legacySearch, // POST /modash/search-legacy
};
