// Service worker registration, update prompt and "install the hub" banner.
const DISMISS_KEY = 'sgsai.install.dismissed';

function showUpdateToast(worker) {
  if (document.getElementById('update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'update-toast';
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'A new version of the site is available.';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'button button-primary button-small';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => worker.postMessage({ type: 'SKIP_WAITING' }));
  toast.append(text, reload);
  document.body.append(toast);
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js').then((registration) => {
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateToast(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(worker);
      });
    });
  }).catch(() => {
    // The site works without a service worker.
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/** Shows the install banner when the browser offers installation and the user has not dismissed it. */
export function setupInstallPrompt(banner, installButton, dismissButton) {
  registerServiceWorker();
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    if (localStorage.getItem(DISMISS_KEY) !== '1') banner.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    banner.hidden = true;
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null;
  });
  dismissButton.addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem(DISMISS_KEY, '1');
  });
  window.addEventListener('appinstalled', () => { banner.hidden = true; });
}
