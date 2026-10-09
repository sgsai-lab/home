import { api, ApiError, describeError, handleSubmit, showStatus } from '/js/auth.js';

const title = document.getElementById('title');
const resendForm = document.getElementById('resend-form');
const statusEl = document.getElementById('status');
const token = new URLSearchParams(location.search).get('token');
// Keep the one-time token out of history and later navigations.
history.replaceState(null, '', location.pathname);

function showResend(message) {
  title.textContent = 'Verify your email';
  resendForm.hidden = false;
  if (message) showStatus(statusEl, message);
}

if (!token) {
  showResend();
} else {
  api('/auth/verify-email', { auth: false, method: 'POST', body: { token } })
    .then(() => {
      title.textContent = 'Email verified';
      document.getElementById('verified').hidden = false;
    })
    .catch((error) => showResend(describeError(error)));
}

handleSubmit(resendForm, statusEl, async ({ email }) => {
  if (!email.trim()) throw new ApiError(0, 'CLIENT', 'Enter your email address.');
  await api('/auth/verify-email/resend', { auth: false, method: 'POST', body: { email: email.trim() } });
  showStatus(statusEl, 'If the address needs verifying, a new link is on its way.', 'success');
});
