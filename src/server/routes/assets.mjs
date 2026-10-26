import { HttpError, sanitizeText } from '../http.mjs';
import { deleteDoc, getDoc, newId, queryDocs, setDoc, updateDoc } from '../db.mjs';
import { requireMembership } from '../authz.mjs';
import { Checker, slugify } from '../validation.mjs';
import { syncPublicIcon } from './products.mjs';

const MB = 1024 * 1024;
const PENDING_TTL = 24 * 60 * 60 * 1000;
const READ_TTL = 60 * 60 * 1000;

// SVG and HTML are excluded on purpose: they can carry script.
export const MEDIA_TYPES = {
  image: { max: 10 * MB, types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } },
  video: { max: 500 * MB, types: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' } },
  document: {
    max: 25 * MB,
    types: {
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/csv': 'csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
  }
};

// Which owner each purpose attaches to, which kinds it accepts and which field it sets.
const PURPOSES = {
  logo: { owner: 'client', kinds: ['image'], field: 'logo' },
  cover: { owner: 'project', kinds: ['image'], field: 'cover_asset_id' },
  icon: { owner: 'product', kinds: ['image'], field: 'icon_asset_id' },
  deliverable: { owner: 'project', kinds: ['image', 'video', 'document'] },
  media: { owner: null, kinds: ['image', 'video'] }
};

const OWNER_COLLECTIONS = { client: 'clients', project: 'projects', product: 'products' };

function publicAsset(asset) {
  return {
    id: asset.id,
    client_id: asset.client_id,
    owner: { type: asset.owner_type, id: asset.owner_id },
    purpose: asset.purpose,
    kind: asset.kind,
    filename: asset.filename,
    alt_text: asset.alt_text ?? null,
    content_type: asset.content_type,
    size_bytes: asset.size_bytes,
    status: asset.status,
    created_at: asset.created_at
  };
}

async function resolveOwner(type, id) {
  const collection = OWNER_COLLECTIONS[type];
  const owner = collection && id ? await getDoc(collection, id) : null;
  if (!owner || owner.deleted_at) throw new HttpError(404, 'NOT_FOUND', 'The item to attach this file to was not found.');
  return { owner, clientId: type === 'client' ? owner.id : owner.client_id };
}

function requireStorage(ctx) {
  if (!ctx.deps.storage.configured) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured on this server.');
}

async function createUploadUrl(ctx) {
  const { user } = await ctx.auth();
  requireStorage(ctx);
  const input = await ctx.body();
  const check = new Checker(input);
  const purpose = check.oneOf('purpose', Object.keys(PURPOSES), { required: true });
  const kind = check.oneOf('kind', Object.keys(MEDIA_TYPES), { required: true });
  const filename = check.text('filename', { required: true, max: 200 });
  const contentType = check.text('content_type', { required: true, max: 120 });
  const size = check.integer('size_bytes', { min: 1, max: 500 * MB });
  const altText = check.text('alt_text', { max: 300, nullable: true });
  const ownerType = input.owner?.type;
  const ownerId = typeof input.owner?.id === 'string' ? input.owner.id : null;
  if (!OWNER_COLLECTIONS[ownerType]) check.fail('owner.type', 'Use client, project or product.');
  check.done();
  const rule = PURPOSES[purpose];
  if (rule.owner && rule.owner !== ownerType) check.fail('owner.type', `A ${purpose} belongs to a ${rule.owner}.`);
  if (!rule.kinds.includes(kind)) check.fail('kind', `A ${purpose} must be ${rule.kinds.join(' or ')}.`);
  const media = MEDIA_TYPES[kind];
  if (!media.types[contentType]) check.details.push({ field: 'content_type', message: `Allowed ${kind} types: ${Object.keys(media.types).join(', ')}.` });
  if (size > media.max) check.fail('size_bytes', `${kind[0].toUpperCase()}${kind.slice(1)}s must be ${media.max / MB} MB or smaller.`);
  if (kind === 'image' && ['logo', 'cover', 'icon'].includes(purpose) && !altText) check.fail('alt_text', 'Describe the image for people using screen readers.');
  if (check.details.some((detail) => detail.field === 'content_type')) throw new HttpError(400, 'UNSUPPORTED_TYPE', 'This file type is not allowed.', check.details);
  check.done();

  const { clientId } = await resolveOwner(ownerType, ownerId);
  await requireMembership(user, clientId, 'admin');
  ctx.limit('uploads', user.id);

  const id = newId('ast');
  const base = slugify(filename.replace(/\.[^.]*$/, '')) || 'file';
  const object = `clients/${clientId}/${kind}/${id}-${base}.${media.types[contentType]}`;
  // Uploads land under pending/; confirm moves them. A bucket lifecycle rule deletes abandoned ones.
  const pendingObject = `pending/${object}`;
  const now = Date.now();
  const asset = {
    id,
    client_id: clientId,
    owner_type: ownerType,
    owner_id: ownerId,
    purpose,
    kind,
    filename: `${base}.${media.types[contentType]}`,
    alt_text: altText ?? null,
    content_type: contentType,
    size_bytes: size,
    gcs_bucket: ctx.deps.storage.mediaBucket,
    gcs_object: object,
    gcs_pending_object: pendingObject,
    status: 'pending',
    md5: null,
    created_by: user.id,
    created_at: new Date(now).toISOString(),
    // Pending uploads that are never confirmed are purged by the Firestore TTL policy.
    expires_at: now + PENDING_TTL
  };
  await setDoc('assets', id, asset);
  const upload = await ctx.deps.storage.signedUploadUrl({ object: pendingObject, contentType, size });
  return ctx.send(201, { asset: publicAsset(asset), upload });
}

async function loadAsset(ctx, minimum) {
  const { user } = await ctx.auth();
  const asset = await getDoc('assets', ctx.params.id);
  if (!asset || asset.status === 'deleted') throw new HttpError(404, 'NOT_FOUND', 'File not found.');
  await requireMembership(user, asset.client_id, minimum);
  return { user, asset };
}

async function attach(ctx, asset) {
  if (asset.purpose === 'logo') {
    await updateDoc('clients', asset.owner_id, (client) => client && { ...client, branding: { ...client.branding, logo_asset_id: asset.id }, updated_at: new Date().toISOString() });
  } else if (asset.purpose === 'cover') {
    await updateDoc('projects', asset.owner_id, (project) => project && { ...project, cover_asset_id: asset.id, version: (project.version ?? 1) + 1, updated_at: new Date().toISOString() });
  } else if (asset.purpose === 'icon') {
    const { after } = await updateDoc('products', asset.owner_id, (product) => product && { ...product, icon_asset_id: asset.id, updated_at: new Date().toISOString() });
    if (after) await syncPublicIcon(ctx.deps.storage, after);
  }
}

async function detach(ctx, asset) {
  if (asset.purpose === 'logo') {
    await updateDoc('clients', asset.owner_id, (client) => (client?.branding?.logo_asset_id === asset.id ? { ...client, branding: { ...client.branding, logo_asset_id: null }, updated_at: new Date().toISOString() } : undefined));
  } else if (asset.purpose === 'cover') {
    await updateDoc('projects', asset.owner_id, (project) => (project?.cover_asset_id === asset.id ? { ...project, cover_asset_id: null, version: (project.version ?? 1) + 1, updated_at: new Date().toISOString() } : undefined));
  } else if (asset.purpose === 'icon') {
    const { after } = await updateDoc('products', asset.owner_id, (product) => (product?.icon_asset_id === asset.id ? { ...product, icon_asset_id: null, updated_at: new Date().toISOString() } : undefined));
    if (after) await syncPublicIcon(ctx.deps.storage, after);
  }
}

async function confirmUpload(ctx) {
  requireStorage(ctx);
  const { user, asset } = await loadAsset(ctx, 'admin');
  if (asset.status === 'ready') return ctx.send(200, publicAsset(asset));
  const uploaded = asset.gcs_pending_object ?? asset.gcs_object;
  const head = await ctx.deps.storage.head(uploaded);
  if (!head) throw new HttpError(409, 'OBJECT_MISSING', 'The upload has not finished yet. Upload the file, then confirm.');
  if (head.size !== asset.size_bytes || head.contentType !== asset.content_type) {
    await ctx.deps.storage.remove(uploaded);
    await deleteDoc('assets', asset.id);
    throw new HttpError(409, 'OBJECT_MISMATCH', 'The uploaded file did not match what was announced. Please upload it again.');
  }
  if (uploaded !== asset.gcs_object) await ctx.deps.storage.promote(uploaded, asset.gcs_object);
  const { after } = await updateDoc('assets', asset.id, (current) => current && {
    ...current, status: 'ready', md5: head.md5, gcs_pending_object: null, expires_at: null, confirmed_at: new Date().toISOString()
  });
  await attach(ctx, after);
  await ctx.audit('asset.uploaded', { type: 'asset', id: asset.id }, { actorId: user.id, clientId: asset.client_id, diff: { purpose: asset.purpose, kind: asset.kind } });
  return ctx.send(200, publicAsset(after));
}

async function readUrl(ctx) {
  requireStorage(ctx);
  const { asset } = await loadAsset(ctx, 'viewer');
  if (asset.status !== 'ready') throw new HttpError(409, 'NOT_READY', 'This file is still uploading.');
  const url = await ctx.deps.storage.signedReadUrl({ object: asset.gcs_object, ttlMs: READ_TTL, downloadName: asset.purpose === 'deliverable' ? asset.filename : null });
  return ctx.send(200, { url, expires_in: READ_TTL / 1000, content_type: asset.content_type });
}

async function listAssets(ctx) {
  const { user } = await ctx.auth();
  const ownerType = ctx.query.get('owner_type');
  const ownerId = sanitizeText(ctx.query.get('owner_id'), 80);
  const { clientId } = await resolveOwner(ownerType, ownerId);
  await requireMembership(user, clientId);
  const purpose = ctx.query.get('purpose');
  const assets = await queryDocs('assets', { where: [['owner_id', '==', ownerId], ['status', '==', 'ready']] });
  const items = assets
    .filter((asset) => asset.owner_type === ownerType && (!purpose || asset.purpose === purpose))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(publicAsset);
  return ctx.send(200, { items });
}

async function deleteAsset(ctx) {
  const { user, asset } = await loadAsset(ctx, 'admin');
  ctx.limit('mutations', user.id);
  await detach(ctx, asset);
  if (ctx.deps.storage.configured) await ctx.deps.storage.remove(asset.status === 'ready' ? asset.gcs_object : asset.gcs_pending_object ?? asset.gcs_object);
  await deleteDoc('assets', asset.id);
  await ctx.audit('asset.deleted', { type: 'asset', id: asset.id }, { actorId: user.id, clientId: asset.client_id, diff: { purpose: asset.purpose } });
  return ctx.send(200, { ok: true });
}

export const assetRoutes = [
  ['POST', '/api/v1/assets/upload-url', createUploadUrl],
  ['GET', '/api/v1/assets', listAssets],
  ['POST', '/api/v1/assets/:id/confirm', confirmUpload],
  ['GET', '/api/v1/assets/:id/url', readUrl],
  ['DELETE', '/api/v1/assets/:id', deleteAsset]
];
