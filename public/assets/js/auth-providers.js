// "Continue with Google / Apple" buttons shared by the sign-in and sign-up pages.
import { api, describeError, showStatus } from '/assets/js/auth.js';
import { signInWithApple } from '/assets/js/apple.js';
import { cancelGooglePrompt, mountGoogleButton, promptGoogleOneTap } from '/assets/js/google.js';

/**
 * onResult receives the API response (tokens or MFA challenge).
 * Returns { offerGoogleOneTap } so the page can show One Tap once it knows nobody is signed in.
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
    showStatus(statusEl, 'Google sign-in is not available right now. Continue with email instead.', 'info');
  });
  const googleReady = mountGoogleButton(googleSlot, (credential) => complete('/auth/google', credential), {
    text: context === 'signup' ? 'signup_with' : 'continue_with',
    context,
    autoSelect: context === 'signin'
  }).catch(() => false);
  googleReady.then((shown) => { googleFallback.hidden = shown; });

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

  return {
    async offerGoogleOneTap() {
      if (await googleReady) promptGoogleOneTap();
    }
  };
}
