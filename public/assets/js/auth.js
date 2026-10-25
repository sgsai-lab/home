// Shared API client for the account pages. The access token is kept per-tab in sessionStorage;
// the refresh token is an HttpOnly cookie that only the API can read.
const API_BASE = '/api/v1';
const SESSION_KEY = 'sgsai.session';
// Non-sensitive flag so public pages only attempt a refresh when a session likely exists.
const SIGNED_IN_HINT_KEY = 'sgsai.signedIn';
const EXPIRY_MARGIN_MS = 30_000;

export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let session = loadSession();
let refreshing = null;
let currentUser = null;

function loadSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (stored?.accessToken && stored.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return stored;
  } catch {
    // Corrupt storage is treated as signed out.
  }
  return null;
}

export function storeTokens(tokens) {
  session = { accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(SIGNED_IN_HINT_KEY, '1');
  currentUser = null;
}

export function clearSession() {
  session = null;
  currentUser = null;
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SIGNED_IN_HINT_KEY);
}

export function hasSessionHint() {
  return Boolean(session) || localStorage.getItem(SIGNED_IN_HINT_KEY) === '1';
}

async function send(path, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = { 'X-Client': 'web', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: requestHeaders,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection and try again.');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? 'Something went wrong. Please try again.', error.details ?? []);
  }
  return { data, headers: response.headers };
}

// Refresh tokens are single-use, so serialise refreshes across tabs to avoid reuse detection.
function withRefreshLock(task) {
  return navigator.locks ? navigator.locks.request('sgsai-token-refresh', task) : task();
}

export function refreshSession() {
  refreshing ??= withRefreshLock(() => send('/auth/token/refresh', { method: 'POST' }))
    .then(({ data }) => storeTokens(data))
    .catch((error) => {
      clearSession();
      throw error;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** Calls the API. Authenticated calls refresh the access token once on 401. */
export async function api(path, { auth = true, withHeaders = false, ...options } = {}) {
  let result;
  if (!auth) {
    result = await send(path, options);
  } else {
    if (!session) await refreshSession();
    try {
      result = await send(path, { ...options, token: session.accessToken });
    } catch (error) {
      if (error.status !== 401) throw error;
      await refreshSession();
      result = await send(path, { ...options, token: session.accessToken });
    }
  }
  return withHeaders ? result : result.data;
}

/** Shared by the header and the page so /users/me is fetched once per page load. */
export function getCurrentUser({ reload = false } = {}) {
  if (reload || !currentUser) {
    currentUser = api('/users/me');
    currentUser.catch(() => { currentUser = null; });
  }
  return currentUser;
}

export function safeNext(value, fallback = '/projects/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

export function redirectToLogin() {
  const next = `${location.pathname}${location.search}${location.hash}`;
  location.replace(`/login/?next=${encodeURIComponent(next)}`);
}

/** Resolves the signed-in user or redirects to the login page. */
export async function requireUser({ admin = false } = {}) {
  let user;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      redirectToLogin();
      return new Promise(() => {});
    }
    throw error;
  }
  if (admin && user.role !== 'admin') {
    location.replace('/projects/');
    return new Promise(() => {});
  }
  return user;
}

/** Ends the session without navigating away. */
export async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // The local session is discarded even if the server call fails.
  }
  clearSession();
}

export async function logout() {
  await signOut();
  location.assign('/login/');
}

/** On sign-in/sign-up pages: offers "Continue as <name>" when a session already exists. */
export async function offerContinueAs(card, hiddenWhileShown, next) {
  if (!hasSessionHint()) return false;
  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return false;
  }
  card.querySelector('[data-continue-email]').textContent = user.email;
  const proceed = card.querySelector('[data-continue]');
  proceed.textContent = `Continue as ${user.full_name}`;
  proceed.addEventListener('click', () => location.assign(next));
  card.querySelector('[data-switch-account]').addEventListener('click', async () => {
    await signOut();
    // Reload so the header and Google prompt reflect the signed-out state.
    location.reload();
  }, { once: true });
  hiddenWhileShown.forEach((element) => { element.hidden = true; });
  card.hidden = false;
  return true;
}

export function describeError(error) {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  const fields = error.details
    .filter((detail) => detail.message)
    .map((detail) => (detail.field ? `${detail.field.replace(/^body\./, '')}: ${detail.message}` : detail.message));
  return fields.length ? `${error.message} (${fields.join('; ')})` : error.message;
}

export function showStatus(element, message, kind = 'error') {
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = !message;
}

/** Disables the form's controls while the async handler runs and reports errors to statusEl. */
export function handleSubmit(form, statusEl, handler) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showStatus(statusEl, '');
    // Read values before disabling: disabled controls are excluded from FormData.
    const values = Object.fromEntries(new FormData(form));
    const controls = [...form.querySelectorAll('button, input, select, textarea')];
    const previouslyDisabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try {
      await handler(values, event);
    } catch (error) {
      showStatus(statusEl, describeError(error));
    } finally {
      controls.forEach((control, index) => { control.disabled = previouslyDisabled[index]; });
    }
  });
}

/** Disables the button while the async handler runs and reports errors to statusEl. */
export function bindAction(button, statusEl, handler) {
  button.addEventListener('click', async () => {
    showStatus(statusEl, '');
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      showStatus(statusEl, describeError(error));
    } finally {
      button.disabled = false;
    }
  });
}

export function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Minimal DOM builder; text is always assigned via textContent. */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}
