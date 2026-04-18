import { dom } from './dom.js';

const INSTALL_NOTICE_KEY = 'lipu_install_notice_seen';

let deferredInstallPrompt = null;

function getInstallNoticeSeen() {
  try {
    return localStorage.getItem(INSTALL_NOTICE_KEY) === '1';
  } catch {
    return true;
  }
}

function setInstallNoticeSeen() {
  try {
    localStorage.setItem(INSTALL_NOTICE_KEY, '1');
  } catch {
    // Ignore storage failures; the notice is non-critical UI.
  }
}

function isMobileViewport() {
  return window.matchMedia?.('(max-width: 768px), (pointer: coarse)')?.matches || false;
}

function isStandaloneApp() {
  return window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true;
}

function hideInstallNotice() {
  dom.installAppNotice?.classList.remove('is-visible');
  window.setTimeout(() => {
    dom.installAppNotice?.classList.add('hidden');
  }, 220);
}

function showInstallNoticeOnce() {
  if (!dom.installAppNotice || !dom.installAppBtn) return;
  if (!isMobileViewport() || isStandaloneApp()) return;
  if (getInstallNoticeSeen()) return;

  setInstallNoticeSeen();
  dom.installAppNotice.classList.remove('hidden');
  requestAnimationFrame(() => {
    dom.installAppNotice?.classList.add('is-visible');
  });
}

async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => undefined);
    deferredInstallPrompt = null;
  } else {
    window.alert('Apri il menu del browser e scegli "Aggiungi alla schermata Home".');
  }

  hideInstallNotice();
}

export function initInstallPrompt() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(err => {
      console.warn('Service worker non registrato:', err);
    });
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });

  dom.installAppBtn?.addEventListener('click', handleInstallClick);

  window.setTimeout(showInstallNoticeOnce, 650);
}
