const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-navigation');

if (menuToggle && navigation) {
  const closeMenu = () => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    navigation.classList.remove('is-open');
  };

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
    navigation.classList.toggle('is-open', !isOpen);
  });

  navigation.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());

const analyticsPaths = new Set(['/', '/vision/', '/products/', '/roadmap/', '/about/', '/contact/', '/privacy/', '/terms/']);
if (analyticsPaths.has(window.location.pathname)) {
  const pageView = JSON.stringify({ path: window.location.pathname });
  if (!navigator.sendBeacon('/api/analytics', new Blob([pageView], { type: 'application/json' }))) {
    fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pageView,
      keepalive: true
    }).catch(() => {});
  }
}

document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('.contact-form')) return;
  event.preventDefault();
  const status = form.querySelector('.form-status');
  const submit = form.querySelector('[type="submit"]');
  if (!form.reportValidity()) return;

  const values = Object.fromEntries(new FormData(form).entries());
  const payload = {
    name: values.name,
    email: values.email,
    company: values.company,
    message: values.message,
    consent: values.consent === 'on',
    website: values.website,
    source: form.dataset.source || 'contact'
  };

  submit.disabled = true;
  status.dataset.state = 'pending';
  status.textContent = 'Sending your message…';
  try {
    const response = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Your message could not be sent.');
    form.reset();
    status.dataset.state = 'success';
    status.textContent = 'Thank you — your message has been sent.';
  } catch (error) {
    status.dataset.state = 'error';
    status.textContent = error instanceof Error
      ? `${error.message} You can email hello@sgsaitechnology.com instead.`
      : 'Your message could not be sent. Please email hello@sgsaitechnology.com instead.';
  } finally {
    submit.disabled = false;
  }
});
