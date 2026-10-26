// Products page: public client apps from the catalog API, plus SGS AI's own announced products.
// A committed fallback (/assets/data/catalog.json) keeps the page useful if the API is unavailable.
const KIND = { pwa: 'Web app', web: 'Website', android: 'Android', ios: 'iOS', service: 'Service' };
const STATUS = { planned: 'In development', beta: 'Beta', live: 'Live' };
const SECTOR = { business: 'Business', education: 'Education' };

const catalogList = document.querySelector('#catalog-list');
const productList = document.querySelector('#product-list');


// Catalog values become link and image targets: allow only same-origin paths and https URLs.
const safeUrl = (value) => (typeof value === 'string' && /^(\/(?!\/)|https:\/\/)/.test(value) ? value : null);
function text(tagName, className, value) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

let formCount = 0;

function createNotifyForm(productName) {
  formCount += 1;
  const id = (name) => `product-${name}-${formCount}`;
  const form = document.createElement('form');
  form.className = 'contact-form product-form';
  form.method = 'post';
  form.dataset.source = 'product-updates';

  const field = (labelText, input, className = 'field') => {
    const wrapper = document.createElement('div');
    wrapper.className = className;
    const label = text('label', '', labelText);
    label.htmlFor = input.id;
    wrapper.append(label, input);
    return wrapper;
  };
  const email = Object.assign(document.createElement('input'), { id: id('email'), name: 'email', type: 'email', autocomplete: 'email', maxLength: 254, required: true });
  const name = Object.assign(document.createElement('input'), { id: id('name'), name: 'name', autocomplete: 'name', maxLength: 100 });
  const trap = Object.assign(document.createElement('input'), { id: id('website'), name: 'website', tabIndex: -1, autocomplete: 'off' });
  const trapWrapper = field('Leave this field empty', trap, 'form-trap');
  trapWrapper.setAttribute('aria-hidden', 'true');
  const message = Object.assign(document.createElement('input'), { type: 'hidden', name: 'message', value: `Please send me updates about ${productName}.` });
  const consent = Object.assign(document.createElement('input'), { id: id('consent'), name: 'consent', type: 'checkbox', required: true });
  const consentField = document.createElement('div');
  consentField.className = 'field field-full field-checkbox';
  const consentLabel = text('label', '', 'I agree that SGS AI Technology may use my email to respond to this product update request.');
  consentLabel.htmlFor = consent.id;
  consentField.append(consent, consentLabel);
  const actions = document.createElement('div');
  actions.className = 'field field-full';
  const submit = text('button', 'button button-primary', 'Request updates ↗');
  submit.type = 'submit';
  const status = text('p', 'form-status', '');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(submit, status);
  form.append(field('Email for updates', email), field('Name (optional)', name), trapWrapper, message, consentField, actions);
  return form;
}

function card(item, { notify }) {
  const article = document.createElement('article');
  article.className = 'product-card';
  const heading = document.createElement('div');
  if (safeUrl(item.icon_url)) {
    const icon = Object.assign(document.createElement('img'), { src: safeUrl(item.icon_url), alt: '', width: 48, height: 48, loading: 'lazy', className: 'product-icon' });
    heading.append(icon);
  }
  heading.append(text('h2', '', item.name));
  article.append(heading, text('span', 'status-badge', STATUS[item.status] ?? item.status));
  const meta = document.createElement('ul');
  meta.className = 'product-meta';
  for (const value of [KIND[item.kind], SECTOR[item.sector]].filter(Boolean)) meta.append(text('li', '', value));
  article.append(meta);
  const copy = document.createElement('div');
  copy.className = 'product-copy';
  if (item.summary) copy.append(text('p', '', item.summary));
  if (item.availability) copy.append(text('p', '', `Availability: ${item.availability}`));
  if (item.audience) copy.append(text('p', '', `For whom: ${item.audience}`));
  if (safeUrl(item.launch_path) && item.status !== 'planned') {
    const open = text('a', 'button button-primary', `Open ${item.name} ↗`);
    open.href = safeUrl(item.launch_path);
    open.target = '_blank';
    open.rel = 'noopener';
    copy.append(open);
  }
  article.append(copy);
  if (notify) article.append(createNotifyForm(item.name));
  return article;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function main() {
  const [own, published] = await Promise.allSettled([fetchJson('/assets/data/catalog.json'), fetchJson('/api/v1/catalog')]);
  const ownItems = own.status === 'fulfilled' ? own.value.items : [];
  const clientItems = published.status === 'fulfilled' ? published.value.items : [];
  const available = clientItems.filter((item) => item.status !== 'planned');
  const upcoming = [...ownItems, ...clientItems.filter((item) => item.status === 'planned')];

  if (available.length && catalogList) {
    catalogList.replaceChildren(...available.map((item) => card(item, { notify: false })));
    document.querySelector('#catalog-section').hidden = false;
  }
  if (productList) {
    productList.replaceChildren(...(upcoming.length
      ? upcoming.map((item) => card(item, { notify: true }))
      : [text('p', 'empty-products', 'There are no products announced at this time. Please check back for updates.')]));
    if (published.status === 'rejected') {
      productList.append(text('p', 'timeline-note', 'Some product information could not be loaded right now. Please refresh later.'));
    }
  }
}

main().catch(() => {
  productList?.replaceChildren(text('p', 'empty-products', 'Product information could not be loaded. Please refresh the page or email hello@sgsaitechnology.com.'));
});
