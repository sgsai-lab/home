import { api, ApiError, describeError, handleSubmit, offerContinueAs, showStatus, storeTokens } from '/js/auth.js';
import { setupProviders } from '/js/auth-providers.js';

const identifyStep = document.getElementById('identify-step');
const emailForm = document.getElementById('email-form');
const form = document.getElementById('signup-form');
const done = document.getElementById('signup-done');
const statusEl = document.getElementById('status');
let signedUpEmail = '';

function showStep(step) {
  for (const element of [identifyStep, form, done]) element.hidden = element !== step;
  step.querySelector('input:not([hidden])')?.focus();
}

handleSubmit(emailForm, statusEl, async ({ email }) => {
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ApiError(0, 'CLIENT', 'Enter a valid email address.');
  document.getElementById('signup-email-chip').textContent = value;
  form.elements.email.value = value;
  showStep(form);
});

handleSubmit(form, statusEl, async ({ full_name: fullName, email, password, accept_terms: acceptTerms }) => {
  if (!fullName.trim()) throw new ApiError(0, 'CLIENT', 'Enter your name.');
  if (password.length < 10) throw new ApiError(0, 'CLIENT', 'Password must be at least 10 characters.');
  if (!acceptTerms) throw new ApiError(0, 'CLIENT', 'Accept the terms to continue.');

  const user = await api('/auth/signup', {
    auth: false,
    method: 'POST',
    body: { full_name: fullName.trim(), email, password, accept_terms: true }
  });
  signedUpEmail = user.email;
  form.reset();
  document.getElementById('signup-email').textContent = signedUpEmail;
  showStep(done);
});

document.getElementById('change-email').addEventListener('click', () => {
  form.reset();
  showStatus(statusEl, '');
  showStep(identifyStep);
});

const resendButton = document.getElementById('resend');
resendButton.addEventListener('click', async () => {
  resendButton.disabled = true;
  try {
    await api('/auth/verify-email/resend', { auth: false, method: 'POST', body: { email: signedUpEmail } });
    showStatus(statusEl, 'If the address needs verifying, a new link is on its way.', 'success');
  } catch (error) {
    showStatus(statusEl, describeError(error));
  } finally {
    resendButton.disabled = false;
  }
});

setupProviders({
  statusEl,
  context: 'signup',
  onResult: (result) => {
    // Existing accounts with two-factor finish on the sign-in page.
    if (result.mfa_required) {
      location.assign('/login/');
      return;
    }
    storeTokens(result);
    location.replace('/projects/');
  }
});

offerContinueAs(document.getElementById('continue-card'), [identifyStep], '/projects/').catch(() => {});
