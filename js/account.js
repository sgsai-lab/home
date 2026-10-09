import {
  api,
  ApiError,
  bindAction,
  clearSession,
  formatDate,
  getCurrentUser,
  h,
  handleSubmit,
  logout,
  requireUser,
  showStatus
} from '/js/auth.js';
import { mountGoogleButton } from '/js/google.js';

const $ = (id) => document.getElementById(id);
const pageStatus = $('page-status');
let recoveryCodes = [];

function reauthBody(secret) {
  const value = secret.trim();
  return /^\d{6}$/.test(value) ? { code: value } : { password: secret };
}

function checkNewPassword(newPassword, confirm) {
  if (newPassword.length < 10) throw new ApiError(0, 'CLIENT', 'Password must be at least 10 characters.');
  if (newPassword !== confirm) throw new ApiError(0, 'CLIENT', 'Passwords do not match.');
}

// --- Profile ---------------------------------------------------------------
function renderProfile(user) {
  $('profile-email').textContent = user.email;
  $('profile-role').textContent = user.role;
  $('profile-since').textContent = new Date(user.created_at).toLocaleDateString();
  const form = $('profile-form');
  form.elements.full_name.value = user.full_name;
  form.elements.avatar_url.value = user.avatar_url ?? '';
  $('verify-banner').hidden = user.email_verified;
}

handleSubmit($('profile-form'), $('profile-status'), async ({ full_name: fullName, avatar_url: avatarUrl }) => {
  if (!fullName.trim()) throw new ApiError(0, 'CLIENT', 'Enter your name.');
  const updated = await api('/users/me', {
    method: 'PATCH',
    body: { full_name: fullName.trim(), avatar_url: avatarUrl.trim() || null }
  });
  renderProfile(updated);
  await getCurrentUser({ reload: true });
  showStatus($('profile-status'), 'Profile saved.', 'success');
});

bindAction($('verify-resend'), pageStatus, async () => {
  const user = await getCurrentUser();
  await api('/auth/verify-email/resend', { auth: false, method: 'POST', body: { email: user.email } });
  showStatus(pageStatus, `A verification link was sent to ${user.email}.`, 'success');
});

// --- Password --------------------------------------------------------------
handleSubmit($('password-form'), $('password-status'), async ({ current_password: current, new_password: newPassword, confirm }) => {
  if (!current) throw new ApiError(0, 'CLIENT', 'Enter your current password.');
  checkNewPassword(newPassword, confirm);
  try {
    await api('/auth/password/change', { method: 'POST', body: { current_password: current, new_password: newPassword } });
  } catch (error) {
    if (error.code === 'PASSWORD_NOT_SET') {
      $('password-form').hidden = true;
      $('set-password-form').hidden = false;
    }
    throw error;
  }
  $('password-form').reset();
  showStatus($('password-status'), 'Password changed. Your other sessions were signed out.', 'success');
  await loadSessions();
});

handleSubmit($('set-password-form'), $('password-status'), async ({ new_password: newPassword, confirm }) => {
  checkNewPassword(newPassword, confirm);
  await api('/auth/password/set', { method: 'POST', body: { new_password: newPassword } });
  $('set-password-form').reset();
  $('set-password-form').hidden = true;
  $('password-form').hidden = false;
  showStatus($('password-status'), 'Password set. You can now sign in with your email address.', 'success');
});

// --- Two-factor authentication -----------------------------------------------
const mfaStatus = $('mfa-status');

async function loadMfa() {
  const state = await api('/auth/mfa');
  $('mfa-setup').hidden = true;
  $('mfa-off').hidden = state.enabled || !state.available;
  $('mfa-on').hidden = !state.enabled;
  if (state.enabled) {
    $('mfa-summary').textContent = `Enabled. ${state.recovery_codes_remaining} recovery codes remaining.`;
  } else if (state.available) {
    $('mfa-summary').textContent = 'Not enabled. Add a second sign-in step using an authenticator app.';
  } else {
    $('mfa-summary').textContent = 'Two-factor authentication is not available on this server.';
  }
}

function renderQr(uri) {
  const qr = window.qrcode(0, 'M');
  qr.addData(uri);
  qr.make();
  const image = h('img', { src: qr.createDataURL(5, 8), alt: 'QR code to add this account to your authenticator app', width: 200, height: 200 });
  $('mfa-qr').replaceChildren(image);
}

function showRecoveryCodes(codes) {
  recoveryCodes = codes;
  $('mfa-code-list').replaceChildren(...codes.map((code) => h('li', { text: code })));
  $('mfa-codes').hidden = false;
  $('mfa-on').hidden = true;
  $('mfa-setup').hidden = true;
}

bindAction($('mfa-start'), mfaStatus, async () => {
  const setup = await api('/auth/mfa/totp/setup', { method: 'POST' });
  renderQr(setup.otpauth_uri);
  $('mfa-secret').textContent = setup.secret.match(/.{1,4}/g).join(' ');
  $('mfa-off').hidden = true;
  $('mfa-setup').hidden = false;
  $('mfa-confirm-form').elements.code.focus();
});

$('mfa-cancel').addEventListener('click', () => {
  $('mfa-confirm-form').reset();
  $('mfa-qr').replaceChildren();
  $('mfa-secret').textContent = '';
  loadMfa().catch((error) => showStatus(mfaStatus, error.message));
});

handleSubmit($('mfa-confirm-form'), mfaStatus, async ({ code }) => {
  if (!/^\d{6}$/.test(code.trim())) throw new ApiError(0, 'CLIENT', 'Enter the 6-digit code from your app.');
  const result = await api('/auth/mfa/totp/confirm', { method: 'POST', body: { code: code.trim() } });
  $('mfa-confirm-form').reset();
  $('mfa-qr').replaceChildren();
  $('mfa-secret').textContent = '';
  showRecoveryCodes(result.recovery_codes);
  showStatus(mfaStatus, 'Two-factor authentication is now enabled.', 'success');
});

handleSubmit($('mfa-regenerate-form'), mfaStatus, async ({ code }) => {
  if (!/^\d{6}$/.test(code.trim())) throw new ApiError(0, 'CLIENT', 'Enter the 6-digit code from your app.');
  const result = await api('/auth/mfa/recovery-codes', { method: 'POST', body: { code: code.trim() } });
  $('mfa-regenerate-form').reset();
  showRecoveryCodes(result.recovery_codes);
});

handleSubmit($('mfa-disable-form'), mfaStatus, async ({ secret }) => {
  if (!secret) throw new ApiError(0, 'CLIENT', 'Enter your password or an authenticator code.');
  await api('/auth/mfa/totp', { method: 'DELETE', body: reauthBody(secret) });
  $('mfa-disable-form').reset();
  await loadMfa();
  await loadSessions();
  showStatus(mfaStatus, 'Two-factor authentication disabled. Other sessions were signed out.', 'success');
});

bindAction($('mfa-copy'), mfaStatus, async () => {
  await navigator.clipboard.writeText(recoveryCodes.join('\n'));
  showStatus(mfaStatus, 'Recovery codes copied.', 'success');
});

$('mfa-download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([`SGS AI recovery codes\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' }));
  const link = h('a', { href: url, download: 'sgsai-recovery-codes.txt' });
  link.click();
  URL.revokeObjectURL(url);
});

$('mfa-done').addEventListener('click', () => {
  recoveryCodes = [];
  $('mfa-code-list').replaceChildren();
  $('mfa-codes').hidden = true;
  loadMfa().catch((error) => showStatus(mfaStatus, error.message));
});

// --- Google ------------------------------------------------------------------
const googleStatus = $('google-status');

mountGoogleButton($('google-link'), async (credential) => {
  showStatus(googleStatus, '');
  try {
    await api('/auth/google/link', { method: 'POST', body: credential });
    showStatus(googleStatus, 'Google account linked.', 'success');
  } catch (error) {
    showStatus(googleStatus, error.message);
  }
}).then((shown) => {
  $('google-unavailable').hidden = shown;
}).catch(() => {
  $('google-unavailable').hidden = false;
});

bindAction($('google-unlink'), googleStatus, async () => {
  await api('/auth/google/link', { method: 'DELETE' });
  showStatus(googleStatus, 'Google account unlinked.', 'success');
});

// --- Sessions ----------------------------------------------------------------
const sessionsStatus = $('sessions-status');

function deviceLabel(session) {
  const agent = session.user_agent ? session.user_agent.slice(0, 70) : 'Unknown device';
  return session.current ? `${agent} (this device)` : agent;
}

async function loadSessions() {
  const sessions = await api('/auth/sessions');
  $('sessions-body').replaceChildren(...sessions.map((session) => {
    const button = h('button', {
      type: 'button',
      className: 'button button-secondary button-small',
      text: session.current ? 'Sign out' : 'Revoke'
    });
    bindAction(button, sessionsStatus, async () => {
      if (session.current) return logout();
      await api(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      await loadSessions();
    });
    return h('tr', {},
      h('td', { text: deviceLabel(session) }),
      h('td', { text: session.ip ?? '—' }),
      h('td', { text: formatDate(session.started_at) }),
      h('td', { text: formatDate(session.last_used_at) }),
      h('td', {}, button));
  }));
}

bindAction($('logout-all'), sessionsStatus, async () => {
  await api('/auth/logout-all', { method: 'POST' });
  clearSession();
  location.assign('/login/?notice=signed-out-everywhere');
});

// --- Delete account ------------------------------------------------------------
handleSubmit($('delete-form'), $('delete-status'), async ({ secret }) => {
  if (!secret) throw new ApiError(0, 'CLIENT', 'Enter your password or an authenticator code.');
  if (!window.confirm('Delete your account permanently? This cannot be undone.')) return;
  await api('/users/me', { method: 'DELETE', body: reauthBody(secret) });
  clearSession();
  location.assign('/login/?notice=account-deleted');
});

async function main() {
  const user = await requireUser();
  renderProfile(user);
  await Promise.all([loadMfa(), loadSessions()]);
}

main().catch((error) => showStatus(pageStatus, error.message));
