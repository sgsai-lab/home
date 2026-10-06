// Keep product claims and availability together; publish only confirmed details.
const products = [
  {
    name: 'SGS AI mobile MVP',
    status: 'In development',
    platforms: ['Mobile'],
    availability: 'Targeting a Q1 2027 private beta',
    problem: 'The specific problem this application addresses has not yet been announced.',
    audience: 'The intended audience has not yet been announced.'
  }
];

const productList = document.querySelector('#product-list');

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function createNotifyForm(productName) {
  const form = document.createElement('form');
  form.className = 'contact-form product-form';
  form.dataset.source = 'product-updates';
  form.noValidate = false;
  const emailField = document.createElement('div');
  emailField.className = 'field';
  emailField.innerHTML = '<label for="product-email">Email for updates</label><input id="product-email" name="email" type="email" autocomplete="email" maxlength="254" required>';
  const nameField = document.createElement('div');
  nameField.className = 'field';
  nameField.innerHTML = '<label for="product-name">Name <span>(optional)</span></label><input id="product-name" name="name" autocomplete="name" maxlength="100">';
  const trap = document.createElement('div');
  trap.className = 'form-trap';
  trap.setAttribute('aria-hidden', 'true');
  trap.innerHTML = '<label for="product-website">Leave this field empty</label><input id="product-website" name="website" tabindex="-1" autocomplete="off">';
  const company = document.createElement('input');
  company.type = 'hidden';
  company.name = 'company';
  const message = document.createElement('input');
  message.type = 'hidden';
  message.name = 'message';
  message.value = `Please send me updates about ${productName}.`;
  const consentField = document.createElement('div');
  consentField.className = 'field field-full field-checkbox';
  consentField.innerHTML = '<input id="product-consent" name="consent" type="checkbox" required><label for="product-consent">I agree that SGS AI Technology may use my email to respond to this product update request.</label>';
  const actionField = document.createElement('div');
  actionField.className = 'field field-full';
  actionField.innerHTML = '<button class="button button-primary" type="submit">Request updates <span aria-hidden="true">↗</span></button><p class="form-status" role="status" aria-live="polite"></p><p class="form-fallback">Prefer email? <a href="mailto:hello@sgsaitechnology.com">Contact us directly</a>.</p>';
  form.append(emailField, nameField, trap, company, message, consentField, actionField);
  form.addEventListener('submit', (event) => {
    const consent = form.querySelector('#product-consent');
    if (consent.checked) return;
    event.preventDefault();
    consent.setCustomValidity('Please agree before requesting product updates.');
    consent.reportValidity();
  });
  form.querySelector('#product-consent').addEventListener('change', (event) => event.currentTarget.setCustomValidity(''));
  return form;
}

if (productList && products.length) {
  productList.replaceChildren(...products.map((product) => {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.append(createTextElement('h2', '', product.name));
    card.append(createTextElement('span', 'status-badge', product.status));
    const meta = document.createElement('ul');
    meta.className = 'product-meta';
    for (const platform of product.platforms) meta.append(createTextElement('li', '', platform));
    card.append(meta);
    const details = document.createElement('div');
    details.className = 'product-copy';
    details.append(createTextElement('p', '', `Availability: ${product.availability}`));
    details.append(createTextElement('p', '', `Problem: ${product.problem}`));
    details.append(createTextElement('p', '', `For whom: ${product.audience}`));
    card.append(details, createNotifyForm(product.name));
    return card;
  }));
} else if (productList) {
  productList.replaceChildren(createTextElement('p', 'empty-products', 'There are no products announced at this time. Please check back for updates.'));
}