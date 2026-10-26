import { HttpError } from './http.mjs';

const UPLOAD_TTL_MS = 15 * 60 * 1000;

function notConfigured() {
  return new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured on this server.');
}

/**
 * Google Cloud Storage adapter. Binaries never pass through Cloud Run: the browser or app
 * uploads with a V4 signed URL, and reads use short-lived signed URLs. On Cloud Run the
 * runtime service account signs through IAM signBlob; no key files are involved.
 */
export function createGcsStorage(env) {
  const mediaBucket = env.MEDIA_BUCKET || null;
  const publicBucket = env.PUBLIC_ASSETS_BUCKET || null;
  let client;

  async function gcs() {
    if (!mediaBucket) throw notConfigured();
    if (!client) {
      const { Storage } = await import('@google-cloud/storage');
      client = new Storage();
    }
    return client;
  }

  return {
    configured: Boolean(mediaBucket),
    mediaBucket,
    publicBucket,

    async signedUploadUrl({ object, contentType, size }) {
      const lengthRange = `${size},${size}`;
      const [url] = await (await gcs()).bucket(mediaBucket).file(object).getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + UPLOAD_TTL_MS,
        contentType,
        extensionHeaders: { 'x-goog-content-length-range': lengthRange }
      });
      return { url, method: 'PUT', headers: { 'Content-Type': contentType, 'x-goog-content-length-range': lengthRange }, expires_in: UPLOAD_TTL_MS / 1000 };
    },

    async signedReadUrl({ object, ttlMs = 60 * 60 * 1000, downloadName = null }) {
      const [url] = await (await gcs()).bucket(mediaBucket).file(object).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlMs,
        ...(downloadName ? { responseDisposition: `attachment; filename="${downloadName.replace(/["\\]/g, '')}"` } : {})
      });
      return url;
    },

    async head(object) {
      try {
        const [metadata] = await (await gcs()).bucket(mediaBucket).file(object).getMetadata();
        return { size: Number(metadata.size), contentType: metadata.contentType, md5: metadata.md5Hash ?? null };
      } catch (error) {
        if (error.code === 404) return null;
        throw error;
      }
    },

    /** Moves a confirmed upload out of `pending/`, where a lifecycle rule deletes abandoned uploads. */
    async promote(pendingObject, object) {
      await (await gcs()).bucket(mediaBucket).file(pendingObject).move(object);
    },

    async remove(object) {
      await (await gcs()).bucket(mediaBucket).file(object).delete({ ignoreNotFound: true });
    },

    /** Copies an object to the public assets bucket and returns its public URL, or null if none is configured. */
    async publish(object, publicObject) {
      if (!publicBucket) return null;
      const storage = await gcs();
      const [copy] = await storage.bucket(mediaBucket).file(object).copy(storage.bucket(publicBucket).file(publicObject));
      await copy.setMetadata({ cacheControl: 'public, max-age=86400' });
      return `https://storage.googleapis.com/${publicBucket}/${publicObject.split('/').map(encodeURIComponent).join('/')}`;
    },

    async unpublish(publicObject) {
      if (!publicBucket || !publicObject) return;
      await (await gcs()).bucket(publicBucket).file(publicObject).delete({ ignoreNotFound: true });
    }
  };
}
