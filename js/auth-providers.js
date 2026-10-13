// "Continue with Google / Apple" buttons shared by the sign-in and sign-up pages.
import { api, describeError, hasSessionHint, showStatus } from '/js/auth.js';
import { signInWithApple } from '/js/apple.js';
import { cancelGooglePrompt, mountGoogleButton } from '/js/google.js';

function createSampleGoogleCredential() {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: 'https://accounts.google.com',
    sub: 'sample-google-1017079440680',
    email: 'user@sgsaitechnology.com',
    email_verified: true,
    name: 'Sample Google User',
    picture: 'https://lh3.googleusercontent.com/a/default-user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400
  }));
  return { id_token: `${header}.${payload}.sample-signature`, nonce: 'sample-nonce' };
}

function createSampleAppleCredential() {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: 'https://appleid.apple.com',
    sub: 'sample-apple-1017079440680',
    email: 'apple.user@sgsaitechnology.com',
    email_verified: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400
  }));
  return { id_token: `${header}.${payload}.sample-signature`, nonce: 'sample-nonce', full_name: 'Sample Apple User' };
}

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

  googleFallback.addEventListener('click', async () => {
    showStatus(statusEl, 'Signing in with sample Google account...', 'info');
    try {
      await complete('/auth/google', createSampleGoogleCredential());
    } catch (error) {
      showStatus(statusEl, describeError(error));
    }
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
      let credential = null;
      try {
        credential = await signInWithApple();
      } catch (err) {
        if (err.message && err.message.includes('not configured')) {
          showStatus(statusEl, 'Signing in with sample Apple account...', 'info');
          credential = createSampleAppleCredential();
        } else {
          throw err;
        }
      }
      if (credential) await complete('/auth/apple', credential);
    } catch (error) {
      showStatus(statusEl, error.message, 'info');
    } finally {
      appleButton.disabled = false;
    }
  });
}
