import { api, ApiError, handleSubmit, showStatus } from '/js/auth.js';

const form = document.getElementById('reset-form');
const mfaField = document.getElementById('mfa-field');
const statusEl = document.getElementById('status');
const token = new URLSearchParams(location.search).get('token');
// Keep the one-time token out of history and later navigations.
history.replaceState(null, '', location.pathname);

if (!token) {
  form.querySelector('button[type="submit"]').disabled = true;
  showStatus(statusEl, 'This link is missing its token. Request a new reset link.');
}

handleSubmit(form, statusEl, async ({ new_password: newPassword, confirm, mfa }) => {
  if (newPassword.length < 10) throw new ApiError(0, 'CLIENT', 'Password must be at least 10 characters.');
  if (newPassword !== confirm) throw new ApiError(0, 'CLIENT', 'Passwords do not match.');

  const body = { token, new_password: newPassword };
  const factor = (mfa ?? '').replace(/\s+/g, '');
  if (factor) Object.assign(body, /^\d{6}$/.test(factor) ? { mfa_code: factor } : { recovery_code: factor });

  try {
    await api('/auth/password/reset', { auth: false, method: 'POST', body });
  } catch (error) {
    if (error.code === 'MFA_REQUIRED') {
      mfaField.hidden = false;
      mfaField.querySelector('input').focus();
    }
    throw error;
  }
  location.replace('/login/?notice=password-reset');
});
