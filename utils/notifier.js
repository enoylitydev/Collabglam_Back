// utils/notifier.js
const Notification = require('../models/notification');
const sockets = require('../sockets'); // { emitToBrand, emitToInfluencer }

async function createAndEmit({
  brandId = null,
  influencerId = null,
  brandIds = null,
  influencerIds = null,
  type,
  title,
  message = '',
  entityType = null,
  entityId = null,
  actionPath = null,
}) {
  if (!type || !title) {
    throw new Error('createAndEmit: type and title are required');
  }

  // normalize recipients into arrays
  const bIds = [
    ...(brandId ? [brandId] : []),
    ...(Array.isArray(brandIds) ? brandIds : []),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  const iIds = [
    ...(influencerId ? [influencerId] : []),
    ...(Array.isArray(influencerIds) ? influencerIds : []),
  ]
    .filter(Boolean)
    .map((v) => String(v));

  // dedupe
  const uniqueBrandIds = Array.from(new Set(bIds));
  const uniqueInfluencerIds = Array.from(new Set(iIds));

  if (!uniqueBrandIds.length && !uniqueInfluencerIds.length) {
    throw new Error('createAndEmit: provide at least one recipient (brandId/influencerId)');
  }

  const resolveActionPath = (kind) => {
    if (!actionPath) return null;
    if (typeof actionPath === 'string') return actionPath;
    if (typeof actionPath === 'object') {
      if (kind === 'brand') return actionPath.brand || null;
      if (kind === 'influencer') return actionPath.influencer || null;
    }
    return null;
  };

  // build docs to insert (one row per recipient)
  const docsToInsert = [
    ...uniqueBrandIds.map((id) => ({
      brandId: id,
      influencerId: null,
      type,
      title,
      message,
      entityType,
      entityId,
      actionPath: resolveActionPath('brand'),
    })),
    ...uniqueInfluencerIds.map((id) => ({
      brandId: null,
      influencerId: id,
      type,
      title,
      message,
      entityType,
      entityId,
      actionPath: resolveActionPath('influencer'),
    })),
  ];

  const created = await Notification.insertMany(docsToInsert, { ordered: true });

  // emit socket events (best-effort)
  try {
    for (const doc of created) {
      const payload = doc.toObject ? doc.toObject() : doc;

      if (payload.brandId) {
        sockets.emitToBrand(String(payload.brandId), 'notification.new', payload);
      }
      if (payload.influencerId) {
        sockets.emitToInfluencer(
          String(payload.influencerId),
          'notification.new',
          payload
        );
      }
    }
  } catch (e) {
    console.warn('Socket emit failed:', e.message);
  }

  return created.length === 1 ? created[0] : created;
}

module.exports = { createAndEmit };
