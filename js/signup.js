import { api, ApiError, describeError, handleSubmit, hasSessionHint, offerContinueAs, showStatus, storeTokens } from '/js/auth.js';
import { cancelGooglePrompt, mountGoogleButton } from '/js/google.js';

const form = document.getElementById('signup-form');
const done = document.getElementById('signup-done');
const statusEl = document.getElementById('status');
let signedUpEmail = '';

handleSubmit(form, statusEl, async ({ full_name: fullName, email, password, confirm, accept_terms: acceptTerms }) => {
  if (!fullName.trim() || !email.trim()) throw new ApiError(0, 'CLIENT', 'Enter your name and email.');
  if (password.length < 10) throw new ApiError(0, 'CLIENT', 'Password must be at least 10 characters.');
  if (password !== confirm) throw new ApiError(0, 'CLIENT', 'Passwords do not match.');
  if (!acceptTerms) throw new ApiError(0, 'CLIENT', 'Accept the terms to continue.');

  const user = await api('/auth/signup', {
    auth: false,
    method: 'POST',
    body: { full_name: fullName.trim(), email: email.trim(), password, accept_terms: true }
  });
  signedUpEmail = user.email;
  form.reset();
  form.hidden = true;
  document.getElementById('signup-email').textContent = signedUpEmail;
  done.hidden = false;
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

mountGoogleButton(document.getElementById('google-button'), async (credential) => {
  showStatus(statusEl, '');
  cancelGooglePrompt();
  try {
    const result = await api('/auth/google', { auth: false, method: 'POST', body: credential });
    if (result.mfa_required) {
      location.assign('/login/');
      return;
    }
    storeTokens(result);
    location.replace('/projects/');
  } catch (error) {
    showStatus(statusEl, describeError(error));
  }
}, { text: 'signup_with', context: 'signup', oneTap: !hasSessionHint() }).then((shown) => {
  document.getElementById('google-divider').hidden = !shown;
}).catch(() => {});

offerContinueAs(document.getElementById('continue-card'), [form], '/projects/').catch(() => {});
