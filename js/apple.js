// Sign in with Apple (popup). The Services ID comes from /api/config at runtime.
import { loadConfig } from '/js/google.js';

const APPLE_SDK = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
let sdkPromise = null;

function loadSdk() {
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = APPLE_SDK;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Apple sign-in could not be loaded.'));
    document.head.append(script);
  });
  return sdkPromise;
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function isAppleConfigured() {
  return Boolean((await loadConfig()).appleClientId);
}

/** Opens the Apple popup and resolves with the payload for POST /auth/apple, or null if cancelled. */
export async function signInWithApple() {
  const { appleClientId } = await loadConfig();
  if (!appleClientId) throw new Error('Sign in with Apple is not configured yet.');
  await loadSdk();
  const nonce = randomToken();
  const state = randomToken();
  window.AppleID.auth.init({
    clientId: appleClientId,
    scope: 'name email',
    redirectURI: `${location.origin}/login/`,
    state,
    nonce,
    usePopup: true
  });
  let data;
  try {
    data = await window.AppleID.auth.signIn();
  } catch (error) {
    if (error?.error === 'popup_closed_by_user' || error?.error === 'user_cancelled_authorize') return null;
    throw new Error('Apple sign-in failed. Please try again.');
  }
  if (data.authorization?.state !== state) throw new Error('Apple sign-in failed. Please try again.');
  const name = [data.user?.name?.firstName, data.user?.name?.lastName].filter(Boolean).join(' ').trim();
  return { id_token: data.authorization.id_token, nonce, ...(name ? { full_name: name.slice(0, 120) } : {}) };
}
