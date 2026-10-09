import { api, ApiError, handleSubmit, showStatus } from '/js/auth.js';

const form = document.getElementById('forgot-form');
const statusEl = document.getElementById('status');

handleSubmit(form, statusEl, async ({ email }) => {
  if (!email.trim()) throw new ApiError(0, 'CLIENT', 'Enter your email address.');
  await api('/auth/password/forgot', { auth: false, method: 'POST', body: { email: email.trim() } });
  form.reset();
  showStatus(statusEl, 'If an account exists for that address, a reset link is on its way. Check your inbox.', 'success');
});
