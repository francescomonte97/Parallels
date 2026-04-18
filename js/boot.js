import { dom } from './dom.js';

const FACE_API_MODELS_PATH = './models';

function setBootProgress(percent = 0, text = '') {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));

  if (dom.bootProgressBar) {
    dom.bootProgressBar.style.width = `${safePercent}%`;
  }

  if (dom.bootStatus && text) {
    dom.bootStatus.textContent = text;
  }
}

function waitForFaceApi(timeoutMs = 4500) {
  if (window.faceapi) return Promise.resolve(window.faceapi);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (window.faceapi) {
        window.clearInterval(timer);
        resolve(window.faceapi);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error('face-api.js non disponibile'));
      }
    }, 80);
  });
}

export async function preloadStartupModels() {
  setBootProgress(8, 'Avvio interfaccia...');

  try {
    const faceapi = await waitForFaceApi();
    setBootProgress(24, 'Caricamento rilevamento volto...');
    await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODELS_PATH);

    setBootProgress(54, 'Caricamento punti del volto...');
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_API_MODELS_PATH);

    setBootProgress(82, 'Caricamento riconoscimento...');
    await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_API_MODELS_PATH);

    setBootProgress(100, 'Modelli pronti.');
  } catch (err) {
    console.warn('Preload modelli non completato:', err);
    setBootProgress(100, 'Avvio senza preload completo.');
  }

  await new Promise(resolve => window.setTimeout(resolve, 260));
}

export function hideBootScreen() {
  if (!dom.bootScreen) return;

  dom.bootScreen.classList.add('is-hidden');
  window.setTimeout(() => {
    dom.bootScreen?.remove();
  }, 420);
}
