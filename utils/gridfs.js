const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const path = require('path');
const mime = require('mime-types');

const BUCKET_NAME = 'uploads';

async function ensureMongoConnected(timeoutMs = 7000) {
  if (mongoose.connection?.db) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MongoDB not connected')), timeoutMs);
    mongoose.connection.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function getBucket() {
  if (!mongoose.connection?.db) {
    throw new Error('MongoDB connection is not ready');
  }
  return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}

function buildFilename(originalName = '', prefix = 'file', mimetype = '') {
  const extFromOriginal = path.extname(originalName);
  const fallbackExt = mime.extension(mimetype || '') ? `.${mime.extension(mimetype)}` : '';
  const ext = extFromOriginal || fallbackExt || '.bin';
  const stamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const prefixPart = prefix ? `${prefix}_` : '';
  return `${prefixPart}${stamp}_${random}${ext}`;
}

function baseUrlFromReq(req) {
  if (!req) return null;
  const host = typeof req.get === 'function' ? req.get('host') : (req.headers?.host || null);
  const protocol = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  if (!host) return null;
  return `${protocol}://${host}`;
}

function buildFileUrl(source, filename) {
  if (!filename) return '';
  const encoded = encodeURIComponent(filename);
  if (!source) return `/file/${encoded}`;
  if (typeof source === 'string') {
    const trimmed = source.replace(/\/$/, '');
    return `${trimmed}/file/${encoded}`;
  }
  const base = baseUrlFromReq(source);
  return base ? `${base}/file/${encoded}` : `/file/${encoded}`;
}

async function uploadToGridFS(files, options = {}) {
  const arr = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
  if (!arr.length) return [];

  await ensureMongoConnected();
  const bucket = getBucket();

  const results = [];
  for (const file of arr) {
    const filename = buildFilename(file.originalname, options.prefix, file.mimetype);
    const metadata = {
      originalName: file.originalname,
      ...(options.metadata || {})
    };
    const contentType = file.mimetype || options.defaultMimeType || 'application/octet-stream';

    const { id } = await new Promise((resolve, reject) => {
      const upload = bucket.openUploadStream(filename, { contentType, metadata });
      upload.once('finish', () => resolve({ id: upload.id }));
      upload.once('error', reject);
      upload.end(file.buffer);
    });

    results.push({
      id: String(id),
      filename,
      originalName: file.originalname,
      mimeType: contentType,
      size: typeof file.size === 'number' ? file.size : (file.buffer?.length || 0),
      url: buildFileUrl(options.req, filename),
    });
  }
  return results;
}

async function deleteGridFsFiles(ids = []) {
  const arr = Array.isArray(ids) ? ids : [ids];
  if (!arr.length) return;
  await ensureMongoConnected();
  const bucket = getBucket();
  for (const id of arr) {
    if (!id) continue;
    try {
      const objectId = new mongoose.Types.ObjectId(String(id));
      await bucket.delete(objectId);
    } catch (err) {
      console.warn('Failed to delete GridFS file', id, err.message);
    }
  }
}

module.exports = {
  uploadToGridFS,
  ensureMongoConnected,
  getBucket,
  buildFileUrl,
  deleteGridFsFiles,
};
