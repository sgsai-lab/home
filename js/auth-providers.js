// "Continue with Google / Apple" buttons shared by the sign-in and sign-up pages.
import { api, describeError, hasSessionHint, showStatus } from '/js/auth.js';
import { signInWithApple } from '/js/apple.js';
import { cancelGooglePrompt, mountGoogleButton } from '/js/google.js';

/**
 * onResult receives the API response (tokens or MFA challenge) and whether the account is new.
 * Unconfigured providers keep their placeholder button and explain why when clicked.
 */
export function setupProviders({ statusEl, onResult, context = 'signin' }) {
  const googleSlot = document.getElementById('google-button');
  const googleFallback = document.getElementById('google-fallback');
  const appleButton = document.getElementById('apple-button');

  const complete = async (path, body) => {
    showStatus(statusEl, '');
    cancelGooglePrompt();
    try {
      await onResult(await api(path, { auth: false, method: 'POST', body }));
    } catch (error) {
      showStatus(statusEl, describeError(error));
    }
  };

  googleFallback.addEventListener('click', () => {
    showStatus(statusEl, 'Google sign-in is not configured yet. Use your email for now.', 'info');
  });
  mountGoogleButton(googleSlot, (credential) => complete('/auth/google', credential), {
    text: context === 'signup' ? 'signup_with' : 'continue_with',
    context,
    oneTap: !hasSessionHint()
  }).then((shown) => {
    googleFallback.hidden = shown;
  }).catch(() => {});

  appleButton.addEventListener('click', async () => {
    showStatus(statusEl, '');
    appleButton.disabled = true;
    try {
      const credential = await signInWithApple();
      if (credential) await complete('/auth/apple', credential);
    } catch (error) {
      showStatus(statusEl, error.message, 'info');
    } finally {
      appleButton.disabled = false;
    }
  });
}
