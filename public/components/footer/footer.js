const yearEl = document.querySelector('#year');
if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
}

// "Stay updated" forms (footer and services page) post product-update requests to the contact API.
if (!window.sgsUpdatesFormBound) {
  window.sgsUpdatesFormBound = true;
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-updates-form')) return;
    event.preventDefault();
    const status = form.querySelector('[role="status"]');
    const setStatus = (text, state) => {
      status.textContent = text;
      status.dataset.state = state;
    };
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form).entries());
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    setStatus('Sending…', 'pending');
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name ?? '',
          email: values.email,
          message: form.dataset.message,
          consent: values.consent === 'on',
          website: values.website ?? '',
          source: 'product-updates'
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Your request could not be sent.');
      form.reset();
      setStatus('Thank you. We will email you with updates.', 'success');
    } catch (error) {
      setStatus(`${error instanceof Error ? error.message : 'Your request could not be sent.'} You can email hello@sgsaitechnology.com instead.`, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
