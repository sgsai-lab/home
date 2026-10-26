// Direct-to-storage uploads: ask the API for a signed URL, PUT the file to Cloud Storage, then confirm.
import { api, ApiError, describeError, h, showStatus } from '/assets/js/auth.js';

const MB = 1024 * 1024;
export const LIMITS = {
  image: { max: 10 * MB, types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  video: { max: 500 * MB, types: ['video/mp4', 'video/webm', 'video/quicktime'] },
  document: {
    max: 25 * MB,
    types: [
      'application/pdf', 'text/plain', 'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  }
};

export function kindOf(file, kinds) {
  return kinds.find((kind) => LIMITS[kind].types.includes(file.type)) ?? null;
}

function put(upload, file, onProgress) {
  const request = new XMLHttpRequest();
  const done = new Promise((resolve, reject) => {
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new ApiError(request.status, 'UPLOAD_FAILED', 'The upload was rejected by storage. Try again.'))));
    request.addEventListener('error', () => reject(new ApiError(0, 'NETWORK_ERROR', 'The upload failed. Check your connection and try again.')));
    request.addEventListener('abort', () => reject(new ApiError(0, 'CANCELLED', 'Upload cancelled.')));
  });
  request.open(upload.method, upload.url);
  for (const [name, value] of Object.entries(upload.headers)) request.setRequestHeader(name, value);
  request.send(file);
  return { done, cancel: () => request.abort() };
}

/**
 * Builds an upload control. `kinds` lists accepted media kinds; images can require alt text.
 * Calls onUploaded(asset) once the API has confirmed the stored object.
 */
export function createUploader({ owner, purpose, kinds = ['image'], label = 'Upload a file', requireAlt = false, onUploaded }) {
  const id = `upload-${purpose}-${Math.random().toString(36).slice(2, 8)}`;
  const accept = kinds.flatMap((kind) => LIMITS[kind].types).join(',');
  const input = h('input', { type: 'file', id, accept, className: 'visually-hidden' });
  const alt = requireAlt ? h('input', { type: 'text', maxlength: 300, placeholder: 'Describe the image for screen readers', 'aria-label': 'Image description' }) : null;
  const progress = h('progress', { max: 1, value: 0, hidden: true });
  const cancel = h('button', { type: 'button', className: 'link-button', text: 'Cancel upload', hidden: true });
  const status = h('p', { className: 'form-status', role: 'status', hidden: true });
  const zone = h('label', { className: 'drop-zone', for: id },
    h('strong', { text: label }),
    h('span', { className: 'hint', text: `Drop a file here or choose one. ${kinds.map((kind) => `${kind}s up to ${LIMITS[kind].max / MB} MB`).join(', ')}.` }));
  let active = null;

  async function upload(file) {
    showStatus(status, '');
    const kind = kindOf(file, kinds);
    try {
      if (!kind) throw new ApiError(0, 'CLIENT', 'This file type is not supported here.');
      if (file.size > LIMITS[kind].max) throw new ApiError(0, 'CLIENT', `${kind[0].toUpperCase()}${kind.slice(1)}s must be ${LIMITS[kind].max / MB} MB or smaller.`);
      if (alt && kind === 'image' && !alt.value.trim()) {
        alt.focus();
        throw new ApiError(0, 'CLIENT', 'Describe the image first, for people using screen readers.');
      }
      const { asset, upload: target } = await api('/assets/upload-url', {
        method: 'POST',
        body: { owner, purpose, kind, filename: file.name, content_type: file.type, size_bytes: file.size, alt_text: alt?.value.trim() || null }
      });
      progress.hidden = false;
      cancel.hidden = false;
      progress.value = 0;
      active = put(target, file, (ratio) => { progress.value = ratio; });
      await active.done;
      const confirmed = await api(`/assets/${encodeURIComponent(asset.id)}/confirm`, { method: 'POST' });
      showStatus(status, `${file.name} uploaded.`, 'success');
      if (alt) alt.value = '';
      await onUploaded?.(confirmed);
    } catch (error) {
      showStatus(status, describeError(error));
    } finally {
      active = null;
      progress.hidden = true;
      cancel.hidden = true;
      input.value = '';
    }
  }

  input.addEventListener('change', () => input.files[0] && upload(input.files[0]));
  cancel.addEventListener('click', () => active?.cancel());
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragging');
    if (event.dataTransfer.files[0]) upload(event.dataTransfer.files[0]);
  });

  return h('div', { className: 'uploader' }, alt, input, zone, progress, cancel, status);
}
