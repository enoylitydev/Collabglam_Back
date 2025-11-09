// utils/notifier.js
const Notification = require('../models/notification');
const sockets = require('../sockets'); // { emitToBrand, emitToInfluencer }

/**
 * Create a notification row and emit via socket.io.
 * Provide exactly ONE of { brandId, influencerId }.
 */
async function createAndEmit({
  brandId = null,
  influencerId = null,
  type,
  title,
  message = '',
  entityType = null,
  entityId = null,
  actionPath = null,
}) {
  if (!!brandId === !!influencerId) {
    // true==true or false==false -> not allowed
    throw new Error('createAndEmit: provide exactly one of brandId or influencerId');
  }

  const doc = await Notification.create({
    brandId: brandId ? String(brandId) : null,
    influencerId: influencerId ? String(influencerId) : null,
    type,
    title,
    message,
    entityType,
    entityId,
    actionPath,
  });

  try {
    if (brandId) sockets.emitToBrand(String(brandId), 'notification.new', doc);
    if (influencerId) sockets.emitToInfluencer(String(influencerId), 'notification.new', doc);
  } catch (e) {
    console.warn('Socket emit failed:', e.message);
  }

  return doc;
}

module.exports = { createAndEmit };
