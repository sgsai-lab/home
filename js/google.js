// Google Identity Services button. The client ID comes from /api/config at runtime.
const GSI_SRC = 'https://accounts.google.com/gsi/client';

let configPromise = null;
let scriptPromise = null;

export function loadConfig() {
  configPromise ??= fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  return configPromise;
}

function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google sign-in could not be loaded.'));
    document.head.append(script);
  });
  return scriptPromise;
}

function randomNonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Renders a Google button (personalised as "Continue as <name>" when the browser has a Google session)
 * and optionally the One Tap prompt. Resolves false when Google sign-in is not configured.
 */
export async function mountGoogleButton(container, onCredential, { text = 'continue_with', context = 'signin', oneTap = false } = {}) {
  const { googleClientId } = await loadConfig();
  if (!googleClientId) return false;
  await loadScript();
  const nonce = randomNonce();
  window.google.accounts.id.initialize({
    client_id: googleClientId,
    nonce,
    context,
    ux_mode: 'popup',
    itp_support: true,
    use_fedcm_for_prompt: true,
    callback: (response) => onCredential({ id_token: response.credential, nonce })
  });
  container.hidden = false;
  window.google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    shape: 'pill',
    text,
    logo_alignment: 'center',
    width: Math.min(Math.max(container.clientWidth, 240), 400)
  });
  if (oneTap) window.google.accounts.id.prompt();
  return true;
}

export function cancelGooglePrompt() {
  window.google?.accounts?.id?.cancel();
}
