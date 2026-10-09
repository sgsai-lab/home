import { api, ApiError, handleSubmit, offerContinueAs, safeNext, showStatus, storeTokens } from '/js/auth.js';
import { setupProviders } from '/js/auth-providers.js';

const NOTICES = {
  'password-reset': 'Your password has been updated. Sign in with your new password.',
  'signed-out-everywhere': 'You have been signed out of all sessions.',
  'account-deleted': 'Your account has been deleted.'
};

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const identifyStep = document.getElementById('identify-step');
const emailForm = document.getElementById('email-form');
const loginForm = document.getElementById('login-form');
const mfaForm = document.getElementById('mfa-form');
const statusEl = document.getElementById('status');
let mfaToken = null;

if (NOTICES[params.get('notice')]) showStatus(statusEl, NOTICES[params.get('notice')], 'success');

function showStep(step) {
  for (const element of [identifyStep, loginForm, mfaForm]) element.hidden = element !== step;
  step.querySelector('input:not([hidden])')?.focus();
}

function finish(result) {
  if (result.mfa_required) {
    mfaToken = result.mfa_token;
    showStep(mfaForm);
    return;
  }
  storeTokens(result);
  location.replace(next);
}

handleSubmit(emailForm, statusEl, async ({ email }) => {
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ApiError(0, 'CLIENT', 'Enter a valid email address.');
  document.getElementById('login-email').textContent = value;
  loginForm.elements.email.value = value;
  showStep(loginForm);
});

handleSubmit(loginForm, statusEl, async ({ email, password }) => {
  if (!password) throw new ApiError(0, 'CLIENT', 'Enter your password.');
  const result = await api('/auth/login', { auth: false, method: 'POST', body: { email, password } });
  loginForm.elements.password.value = '';
  finish(result);
});

handleSubmit(mfaForm, statusEl, async ({ code }) => {
  const value = code.replace(/\s+/g, '');
  if (!value) throw new ApiError(0, 'CLIENT', 'Enter your code.');
  const factor = /^\d{6}$/.test(value) ? { code: value } : { recovery_code: value };
  finish(await api('/auth/mfa/verify', { auth: false, method: 'POST', body: { mfa_token: mfaToken, ...factor } }));
});

document.getElementById('change-email').addEventListener('click', () => {
  loginForm.reset();
  showStatus(statusEl, '');
  showStep(identifyStep);
});

document.getElementById('mfa-cancel').addEventListener('click', () => {
  mfaToken = null;
  mfaForm.reset();
  showStep(identifyStep);
});

setupProviders({ statusEl, onResult: finish, context: 'signin' });

offerContinueAs(document.getElementById('continue-card'), [identifyStep], next).catch(() => {});
