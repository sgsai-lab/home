import { api, ApiError, describeError, handleSubmit, hasSessionHint, offerContinueAs, safeNext, showStatus, storeTokens } from '/js/auth.js';
import { cancelGooglePrompt, mountGoogleButton } from '/js/google.js';

const NOTICES = {
  'password-reset': 'Your password has been updated. Sign in with your new password.',
  'signed-out-everywhere': 'You have been signed out of all sessions.',
  'account-deleted': 'Your account has been deleted.'
};

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const loginForm = document.getElementById('login-form');
const mfaForm = document.getElementById('mfa-form');
const statusEl = document.getElementById('status');
let mfaToken = null;

if (NOTICES[params.get('notice')]) showStatus(statusEl, NOTICES[params.get('notice')], 'success');

function showLogin() {
  mfaToken = null;
  mfaForm.reset();
  mfaForm.hidden = true;
  loginForm.hidden = false;
  loginForm.elements.email.focus();
}

function finish(result) {
  cancelGooglePrompt();
  if (result.mfa_required) {
    mfaToken = result.mfa_token;
    loginForm.hidden = true;
    mfaForm.hidden = false;
    mfaForm.elements.code.focus();
    return;
  }
  storeTokens(result);
  location.replace(next);
}

handleSubmit(loginForm, statusEl, async ({ email, password }) => {
  if (!email.trim() || !password) throw new ApiError(0, 'CLIENT', 'Enter your email and password.');
  const result = await api('/auth/login', { auth: false, method: 'POST', body: { email: email.trim(), password } });
  loginForm.elements.password.value = '';
  finish(result);
});

handleSubmit(mfaForm, statusEl, async ({ code }) => {
  const value = code.replace(/\s+/g, '');
  if (!value) throw new ApiError(0, 'CLIENT', 'Enter your code.');
  const factor = /^\d{6}$/.test(value) ? { code: value } : { recovery_code: value };
  finish(await api('/auth/mfa/verify', { auth: false, method: 'POST', body: { mfa_token: mfaToken, ...factor } }));
});

document.getElementById('mfa-cancel').addEventListener('click', showLogin);

mountGoogleButton(document.getElementById('google-button'), async (credential) => {
  showStatus(statusEl, '');
  try {
    finish(await api('/auth/google', { auth: false, method: 'POST', body: credential }));
  } catch (error) {
    showStatus(statusEl, describeError(error));
  }
}, { context: 'signin', oneTap: !hasSessionHint() }).then((shown) => {
  document.getElementById('google-divider').hidden = !shown;
}).catch(() => {});

offerContinueAs(document.getElementById('continue-card'), [loginForm], next).catch(() => {});
