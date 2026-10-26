import { api, describeError, requireUser } from '/assets/js/auth.js';

const message = document.getElementById('launch-message');
const slug = new URLSearchParams(location.search).get('slug') ?? '';

async function main() {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new Error('This app link is not valid.');
  await requireUser();
  const product = await api(`/products/by-slug/${encodeURIComponent(slug)}`);
  message.textContent = `Opening ${product.name}…`;
  const { path } = await api(`/products/${encodeURIComponent(product.id)}/launch-token`, { method: 'POST' });
  location.replace(path);
}

main().catch((error) => {
  document.getElementById('launch-heading').textContent = 'We could not open this app';
  message.textContent = error.status === 403
    ? 'You do not have access to this app. Ask your workspace administrator to invite you.'
    : error.status === 410 ? 'This app has been retired.' : describeError(error);
});
