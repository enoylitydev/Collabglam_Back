'use strict';

require('dotenv').config();
const { fetch, Agent } = require('undici');

const InfluencerProfile = require('../models/youtube');

const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);

const httpAgent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 });

const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_PLAYLIST_ITEMS = 'https://www.googleapis.com/youtube/v3/playlistItems';
const YT_VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';

const CHANNEL_PARTS = [
  'snippet',
  'statistics',
  'topicDetails',
  'brandingSettings',
  'contentDetails',
  'status',
  'localizations',
];

// ======================================================
// Helpers
// ======================================================
function normalizeHandle(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/@([A-Za-z0-9._\-]+)/);
  if (m && m[1]) return `@${m[1]}`;
  if (/^[A-Za-z0-9._\-]+$/.test(s)) return `@${s}`;
  return null;
}

function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch {
    return String(url);
  }
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickInstagramHandle(text) {
  const t = String(text || '');
  const m =
    t.match(/instagram\.com\/([A-Za-z0-9._]+)/i) ||
    t.match(/\B@([A-Za-z0-9._]{3,})\b/);
  if (!m) return null;
  return `@${String(m[1]).toLowerCase()}`;
}

function cleanStrOrNull(v) {
  if (v === null || typeof v === 'undefined') return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseDateOrNull(v) {
  if (v === null || v === '' || typeof v === 'undefined') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { __invalid: true };
  return d;
}

function parseBoolOrNull(v) {
  if (v === null || typeof v === 'undefined' || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(s)) return true;
  if (['false', 'no', '0'].includes(s)) return false;
  return { __invalid: true };
}

// ======================================================
// HTTP fetch wrapper
// ======================================================
async function ytFetch(url, timeoutMs = YT_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('YouTube API timeout')), timeoutMs);

  try {
    const r = await fetch(url, { dispatcher: httpAgent, signal: ac.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`YouTube API ${r.status}: ${txt || r.statusText}`);
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ======================================================
// YouTube API calls
// ======================================================
async function fetchChannelByHandle(handle) {
  const params = new URLSearchParams({
    part: CHANNEL_PARTS.join(','),
    forHandle: handle,
    key: YT_API_KEY,
  });
  const data = await ytFetch(`${YT_CHANNELS}?${params.toString()}`);
  return data?.items?.[0] || null;
}

/**
 * Fetch latest uploads. YouTube API maxResults per request is 50.
 */
async function fetchLatestVideosFromUploads(uploadsPlaylistId, limit = 50) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 50));

  // 1) get videoIds from uploads playlist
  const params = new URLSearchParams({
    part: 'contentDetails,snippet',
    playlistId: uploadsPlaylistId,
    maxResults: String(safeLimit),
    key: YT_API_KEY,
  });
  const data = await ytFetch(`${YT_PLAYLIST_ITEMS}?${params.toString()}`);

  const ids = (data?.items || [])
    .map((it) => it?.contentDetails?.videoId)
    .filter(Boolean);

  if (!ids.length) return [];

  // 2) fetch details+stats (max 50 IDs per request)
  const parts = ['snippet', 'contentDetails', 'statistics', 'topicDetails', 'status'];
  const p2 = new URLSearchParams({
    part: parts.join(','),
    id: ids.join(','),
    key: YT_API_KEY,
  });

  const v = await ytFetch(`${YT_VIDEOS}?${p2.toString()}`);
  return Array.isArray(v?.items) ? v.items : [];
}

// ======================================================
// Compute metrics
// ======================================================
function computeMetricsFromVideos(videos = []) {
  const rows = videos
    .map((v) => {
      const st = v?.statistics || {};
      const sn = v?.snippet || {};
      const cd = v?.contentDetails || {};
      return {
        videoId: v?.id || null,
        title: sn?.title || '',
        publishedAt: sn?.publishedAt ? new Date(sn.publishedAt) : null,
        viewCount: toNum(st.viewCount) ?? 0,
        likeCount: toNum(st.likeCount) ?? 0,
        commentCount: toNum(st.commentCount) ?? 0,
        duration: cd?.duration || null,
      };
    })
    .filter((r) => r.videoId && r.publishedAt);

  rows.sort((a, b) => b.publishedAt - a.publishedAt);

  if (!rows.length) {
    return {
      lastVideos: [],
      avgViews: null,
      engagementRate: null,
      postsPerWeek: null,
      avgDaysBetween: null,
      lastUploadAt: null,
      lastVideoId: null,
      lastVideoTitle: null,
    };
  }

  const avgViews = Math.round(rows.reduce((a, r) => a + r.viewCount, 0) / rows.length);

  const erArr = rows
    .map((r) => (r.viewCount > 0 ? (r.likeCount + r.commentCount) / r.viewCount : 0))
    .filter(Number.isFinite);

  const engagementRate = erArr.length
    ? Number((erArr.reduce((a, b) => a + b, 0) / erArr.length).toFixed(6))
    : null;

  let postsPerWeek = null;
  let avgDaysBetween = null;

  if (rows.length >= 2) {
    const newest = rows[0].publishedAt.getTime();
    const oldest = rows[rows.length - 1].publishedAt.getTime();
    const days = Math.max(1, (newest - oldest) / (1000 * 60 * 60 * 24));
    postsPerWeek = Number(((rows.length / days) * 7).toFixed(3));

    const gaps = [];
    for (let i = 0; i < rows.length - 1; i++) {
      gaps.push((rows[i].publishedAt - rows[i + 1].publishedAt) / (1000 * 60 * 60 * 24));
    }
    avgDaysBetween = gaps.length
      ? Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3))
      : null;
  }

  return {
    lastVideos: rows,
    avgViews,
    engagementRate,
    postsPerWeek,
    avgDaysBetween,
    lastUploadAt: rows[0].publishedAt,
    lastVideoId: rows[0].videoId,
    lastVideoTitle: rows[0].title,
  };
}

exports.syncYouTubeProfile = asyncHandler(async (req, res) => {
  if (!YT_API_KEY) return res.status(500).json({ status: 'error', message: 'Missing YOUTUBE_API_KEY' });

  const body = req.body || {};
  const handle = normalizeHandle(body.handle);
  if (!handle) return res.status(400).json({ status: 'error', message: 'Valid handle required, e.g. "@mrbeast"' });

  const channel = await fetchChannelByHandle(handle);
  if (!channel) {
    return res.status(404).json({ status: 'error', message: `No channel found for ${handle}`, handle });
  }

  const snippet = channel.snippet || {};
  const stats = channel.statistics || {};
  const topic = channel.topicDetails || {};
  const branding = channel.brandingSettings || {};
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || null;

  const videos = uploadsPlaylistId ? await fetchLatestVideosFromUploads(uploadsPlaylistId, 50) : [];
  const computed = computeMetricsFromVideos(videos);

  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const topicLabels = topicCategories.map(labelFromWikiUrl);

  const bannerUrl = branding?.image?.bannerExternalUrl || null;
  const keywords = branding?.channel?.keywords || '';

  const instagramFromChannel = pickInstagramHandle(snippet.description);
  const instagramFromVideos = videos.map((v) => pickInstagramHandle(v?.snippet?.description)).find(Boolean) || null;
  const instagramHandle = instagramFromChannel || instagramFromVideos || null;

  const handleLower = handle.toLowerCase();
  const filter = { platform: 'youtube', handle: handleLower };

  // IMPORTANT: do NOT include manual fields here, so they won't get overwritten
  const update = {
    channelId: channel.id,

    title: snippet.title || '',
    description: snippet.description || '',
    country: snippet.country || null,
    defaultLanguage: snippet.defaultLanguage || null,
    thumbnails: snippet.thumbnails || null,

    keywords,
    bannerUrl,

    topicCategories,
    topicLabels,

    subscriberCount: toNum(stats.subscriberCount),
    totalViewCount: toNum(stats.viewCount),
    totalVideoCount: toNum(stats.videoCount),

    lastVideos: computed.lastVideos,

    avgViewsLast15: computed.avgViews,
    engagementRateLast15: computed.engagementRate,
    uploadFrequencyPerWeek: computed.postsPerWeek,
    avgDaysBetweenUploads: computed.avgDaysBetween,

    lastUploadAt: computed.lastUploadAt,
    lastVideoId: computed.lastVideoId,
    lastVideoTitle: computed.lastVideoTitle,

    instagramHandle,

    rawChannel: channel,
    syncedAt: new Date(),
    updatedAt: new Date(), // keep timestamps correct for findOneAndUpdate
  };

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return res.json({ status: 'ok', handle, handleId: doc.handleId, data: doc });
});

// ======================================================
// POST /youtube/profile/update-manual  ✅ NEW
// body: { handleId OR handle, ...manualFields }
// - Updates ONLY provided manual fields (email included)
// - Supports clearing fields by sending null or "" (except email must be valid or null)
// ======================================================
exports.updateInfluencerManualFields = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const handleId = cleanStrOrNull(body.handleId);
  const handle = body.handle ? normalizeHandle(body.handle) : null;

  // only requirement: we need something to identify the influencer
  if (!handleId && !handle) {
    return res.status(400).json({ status: 'error', message: 'Provide handleId OR handle.' });
  }

  const filter = handleId
    ? { handleId }
    : { platform: 'youtube', handle: String(handle).toLowerCase() };

  const $set = {};

  // ---- OPTIONAL FIELDS (update only if provided) ----
  if ('email' in body) {
    const email = cleanStrOrNull(body.email);
    if (email === null) {
      $set.email = null;
    } else {
      const emailLc = email.toLowerCase();
      // not required, but if provided must be valid
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) {
        return res.status(400).json({ status: 'error', message: 'Invalid email format.' });
      }
      $set.email = emailLc;
    }
  }

  if ('lastSponsor' in body) $set.lastSponsor = cleanStrOrNull(body.lastSponsor);

  if ('managedByAgency' in body) {
    const b = parseBoolOrNull(body.managedByAgency);
    if (b && b.__invalid) {
      return res.status(400).json({ status: 'error', message: 'managedByAgency must be boolean.' });
    }
    $set.managedByAgency = b;
  }

  if ('topAudienceCountry' in body) $set.topAudienceCountry = cleanStrOrNull(body.topAudienceCountry);

  if ('averageAudienceAge' in body) {
    const v = body.averageAudienceAge;
    if (v === null || v === '' || typeof v === 'undefined') {
      $set.averageAudienceAge = null;
    } else {
      const n = Number(v);
      // optional, but if present must be valid
      if (!Number.isFinite(n) || n < 0 || n > 120) {
        return res.status(400).json({ status: 'error', message: 'averageAudienceAge must be 0-120.' });
      }
      $set.averageAudienceAge = n;
    }
  }

  if ('lastContactedAt' in body || 'lastContactedDate' in body) {
    const raw = ('lastContactedAt' in body) ? body.lastContactedAt : body.lastContactedDate;
    const d = parseDateOrNull(raw);
    if (d && d.__invalid) {
      return res.status(400).json({ status: 'error', message: 'Invalid lastContactedAt date.' });
    }
    $set.lastContactedAt = d; // can be null
  }

  if ('followUpDates' in body) {
    const arr = Array.isArray(body.followUpDates) ? body.followUpDates : [];
    const parsed = [];
    for (const x of arr) {
      const d = parseDateOrNull(x);
      if (d && d.__invalid) {
        return res.status(400).json({ status: 'error', message: 'followUpDates contains invalid date.' });
      }
      if (d) parsed.push(d);
    }
    const uniq = Array.from(new Map(parsed.map(d => [d.getTime(), d])).values())
      .sort((a, b) => a.getTime() - b.getTime());
    $set.followUpDates = uniq; // can be []
  }

  if ('workingHandle' in body) $set.workingHandle = cleanStrOrNull(body.workingHandle);

  // if user sends nothing except handleId/handle, just return current doc (no error)
  if (Object.keys($set).length === 0) {
    const existing = await InfluencerProfile.findOne(filter).lean();
    if (!existing) {
      return res.status(404).json({ status: 'error', message: 'Influencer not found. Run sync API first.' });
    }
    return res.json({ status: 'ok', handleId: existing.handleId, data: existing });
  }

  $set.updatedAt = new Date();

  const doc = await InfluencerProfile.findOneAndUpdate(
    filter,
    { $set },
    { new: true }
  ).lean();

  if (!doc) {
    return res.status(404).json({ status: 'error', message: 'Influencer not found. Run sync API first.' });
  }

  return res.json({ status: 'ok', handleId: doc.handleId, data: doc });
});


// ======================================================
// POST /youtube/getall
// ======================================================
const ALLOWED_SORT = new Set([
  'createdAt',
  'updatedAt',
  'syncedAt',
  'subscriberCount',
  'avgViewsLast15',
  'lastContactedAt', // ✅ allow sorting by manual field
]);

exports.getAllInfluencers = asyncHandler(async (req, res) => {
  try {
    const body = req.body || {};

    const _escapeRegex = typeof escapeRegex === 'function'
      ? escapeRegex
      : (str = '') => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const page = Math.max(1, parseInt(body.page ?? '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? '20', 10)));
    const skip = (page - 1) * limit;

    const search = typeof body.search === 'string' ? body.search.trim() : '';
    const sortBy = ALLOWED_SORT.has(String(body.sortBy)) ? String(body.sortBy) : 'createdAt';
    const sortOrder = String(body.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const includeRaw = String(body.includeRaw ?? 'false').toLowerCase() === 'true';
    const includeVideos = String(body.includeVideos ?? 'false').toLowerCase() === 'true';

    // -----------------------------
    // ✅ Filters (NEW)
    // -----------------------------
    // followers filter -> subscriberCount
    const followersMinRaw = body.followersMin ?? body.minFollowers ?? body.followers_from ?? null;
    const followersMaxRaw = body.followersMax ?? body.maxFollowers ?? body.followers_to ?? null;

    // country filter (channel country)
    const countryRaw = body.country ?? null;          // string like "US"
    const countriesRaw = body.countries ?? null;      // array like ["US","IN"]

    // category filter -> topicLabels/topicCategories (match any)
    const categoryRaw = body.category ?? null;        // string like "Entertainment"
    const categoriesRaw = body.categories ?? null;    // array like ["Entertainment","Lifestyle"]

    const baseQuery = { platform: 'youtube' };
    const and = [];

    // followers range
    const followersMin = followersMinRaw != null && followersMinRaw !== '' ? Number(followersMinRaw) : null;
    const followersMax = followersMaxRaw != null && followersMaxRaw !== '' ? Number(followersMaxRaw) : null;

    if (Number.isFinite(followersMin) || Number.isFinite(followersMax)) {
      const range = {};
      if (Number.isFinite(followersMin)) range.$gte = followersMin;
      if (Number.isFinite(followersMax)) range.$lte = followersMax;
      and.push({ subscriberCount: range });
    }

    // country (exact match, case-insensitive safe)
    const countries = Array.isArray(countriesRaw)
      ? countriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const country = typeof countryRaw === 'string' ? countryRaw.trim() : '';

    if (countries.length) {
      const rxList = countries.map((c) => new RegExp(`^${_escapeRegex(c)}$`, 'i'));
      and.push({ country: { $in: rxList } });
    } else if (country) {
      and.push({ country: new RegExp(`^${_escapeRegex(country)}$`, 'i') });
    }

    // category (match in topicLabels OR topicCategories)
    const categories = Array.isArray(categoriesRaw)
      ? categoriesRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const category = typeof categoryRaw === 'string' ? categoryRaw.trim() : '';

    if (categories.length) {
      const rxList = categories.map((c) => new RegExp(_escapeRegex(c), 'i'));
      and.push({
        $or: [
          { topicLabels: { $in: rxList } },
          { topicCategories: { $in: rxList } },
        ],
      });
    } else if (category) {
      const rx = new RegExp(_escapeRegex(category), 'i');
      and.push({
        $or: [
          { topicLabels: rx },
          { topicCategories: rx },
        ],
      });
    }

    // -----------------------------
    // ✅ Search (improved like getAllEmailContacts)
    // -----------------------------
    if (search) {
      const needleRaw = search;
      const needleNoAt = search.startsWith('@') ? search.slice(1) : search;

      const rxRaw = _escapeRegex(needleRaw);
      const rxNoAt = _escapeRegex(needleNoAt);

      const handleRx = new RegExp(rxRaw.startsWith('@') ? rxRaw : `@${rxNoAt}`, 'i');
      const plainRx = new RegExp(rxNoAt, 'i');

      and.push({
        $or: [
          { email: plainRx },
          { handle: handleRx },
          { title: plainRx },
          { channelId: plainRx },
          { instagramHandle: plainRx },
          { handleId: plainRx },

          // manual fields searchable
          { lastSponsor: plainRx },
          { topAudienceCountry: plainRx },
          { workingHandle: plainRx },
        ],
      });
    }

    // finalize query
    const query = { ...baseQuery };
    if (and.length) query.$and = and;

    // projection
    const projection = {
      __v: 0,
      ...(includeRaw ? {} : { rawChannel: 0 }),
      ...(includeVideos ? {} : { lastVideos: 0 }),
      rawPlaylists: 0,
    };

    const [total, items] = await Promise.all([
      InfluencerProfile.countDocuments(query),
      InfluencerProfile.find(query)
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .select(projection)
        .lean(),
    ]);

    return res.json({
      status: 'ok',
      page,
      limit,
      total,
      hasNext: page * limit < total,

      // echo back filters for UI/debug
      sortBy,
      sortOrder: sortOrder === 1 ? 'asc' : 'desc',
      search: search || '',
      filters: {
        followersMin: Number.isFinite(followersMin) ? followersMin : null,
        followersMax: Number.isFinite(followersMax) ? followersMax : null,
        country: country || null,
        countries: countries.length ? countries : null,
        category: category || null,
        categories: categories.length ? categories : null,
      },

      data: items,
    });
  } catch (err) {
    console.error('getAllInfluencers error:', err);
    return res.status(400).json({ status: 'error', message: err?.message || 'Failed to fetch influencers.' });
  }
});


exports.patchInfluencerEmail = asyncHandler(async (req, res) => {
  const handle = normalizeHandle(req.body.handle);
  const email = (req.body.email || '').trim().toLowerCase();

  if (!handle) return res.status(400).json({ status: 'error', message: 'Valid handle required' });
  if (!email) return res.status(400).json({ status: 'error', message: 'Valid email required' });

  const r = await InfluencerProfile.updateOne(
    {
      platform: 'youtube',
      handle: handle.toLowerCase(),
      $or: [{ email: null }, { email: '' }, { email: { $exists: false } }],
    },
    { $set: { email } }
  );

  return res.json({ status: 'ok', matched: r.matchedCount, modified: r.modifiedCount });
});