// 🔥 MUST match settings.js key
const KNOWN_FACES_OVERRIDE_KEY = 'lipu_known_faces_override';

function readKnownFacesOverride() {
  try {
    const raw = localStorage.getItem(KNOWN_FACES_OVERRIDE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
import { dom } from './dom.js';
import {
  WORKER_BASE_URL,
  MAX_CONVERSATION_HISTORY_MESSAGES,
  STORAGE_KEYS
} from './config.js';
import { state, saveWorkingMemory, saveConversationHistory } from './state.js';
import {
  normalizeRole,
  normalizeString,
  blobToDataURL,
  SpeechRecognition
} from './utils.js';
import {
  renderMessage,
  renderAudioMessage,
  renderImageTextMessage,
  renderLIPULoadingMessage,
  removeLIPULoadingMessage
} from './render.js';
import {
  getLIPUResponse,
  transcribeAudioWithGemini,
  extractTextFromImageWithGemini,
  extractImageContextWithGemini,
  analyzeImageWithAI,
  generateSessionSummary,
  generateIntermediateSummary,
  generatePinnedSummaryIfNeeded
} from './services.js';
import {
  startRecording,
  stopRecording,
  resetAudioComposerState
} from './recorder.js';

let pendingImageFile = null;
let pendingImagePreviewUrl = '';
let pendingImagePreviewGenerated = false;
let pendingImageUI = null;
let pendingImageNaturalWidth = 0;
let pendingImageNaturalHeight = 0;
let pendingImageRecognitionStatus = '';

let pendingFaceDetections = [];
let pendingFaceAnalysisId = 0;

const KNOWN_FACES_JSON_PATH = './js/known-faces.json';
const FACE_API_MODELS_PATH = './models';
const LIPU_SELF_MIN_SCORE = 0.96;
const KNOWN_FACE_MIN_SCORE = 0.94;
const UNCERTAIN_FACE_MIN_SCORE = 0.88;
const IMAGE_SEND_MAX_DIMENSION = 1600;
const IMAGE_SEND_JPEG_QUALITY = 0.82;
const FACE_ANALYSIS_TIMEOUT_MS = 2200;
const MOBILE_FACE_PREVIEW_MAX_DIMENSION = 720;
const DESKTOP_FACE_PREVIEW_MAX_DIMENSION = 720;
const MOBILE_FACE_DETECTOR_INPUT_SIZE = 224;
const MOBILE_FACE_FALLBACK_DETECTOR_INPUT_SIZE = 320;
const DESKTOP_FACE_DETECTOR_INPUT_SIZE = 512;
const MOBILE_FACE_EMBEDDING_INPUT_SIZE = 160;
const MOBILE_FACE_FALLBACK_EMBEDDING_INPUT_SIZE = 224;
const DESKTOP_FACE_EMBEDDING_INPUT_SIZE = 224;
const MOBILE_FACE_SCORE_THRESHOLD = 0.35;
const MOBILE_FACE_FALLBACK_SCORE_THRESHOLD = 0.25;
const DESKTOP_FACE_SCORE_THRESHOLD = 0.25;
const MOBILE_FACE_MATCH_LIMIT = 2;
const MOBILE_FACE_FALLBACK_MATCH_LIMIT = 4;
const DESKTOP_FACE_MATCH_LIMIT = 6;

let knownFacesCache = null;

// 🔥 live update embeddings (no reload)
window.addEventListener('knownFacesUpdated', () => {
  console.warn('[FACES] cache invalidated (live)');
  knownFacesCache = null;
});


let faceApiModelsReadyPromise = null;
let pendingFaceMatches = [];
let pendingFaceAnalysisPromise = null;
let pendingFaceLowConfidenceBlocked = false;
let pendingFaceLowConfidenceAlertedAnalysisId = 0;
let pendingFaceAnalysisFailed = false;
let virtualKeyboardShift = false;
let virtualKeyboardMode = 'letters';
let virtualKeyboardDrag = null;
let virtualKeyboardAccentTimer = null;
let virtualKeyboardSuppressClick = false;
let virtualKeyboardAccentPopover = null;
let virtualKeyboardLastTap = null;

const VIRTUAL_KEYBOARD_LETTER_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
  [',', '.', '?']
];

const VIRTUAL_KEYBOARD_NUMBER_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['@', '#', '€', '&', '-', '+', '(', ')', '/'],
  ['*', "'", '"', ':', ';', '!', '='],
  [',', '.', '?']
];

const VIRTUAL_KEYBOARD_ACCENTS = {
  a: ['à', 'á', 'â', 'ä'],
  e: ['è', 'é', 'ê', 'ë'],
  i: ['ì', 'í', 'î', 'ï'],
  o: ['ò', 'ó', 'ô', 'ö'],
  u: ['ù', 'ú', 'û', 'ü']
};

function getImagePreviewElements() {
  return {
    container: document.getElementById('image-preview-container'),
    preview: document.getElementById('image-preview'),
    badge: document.getElementById('face-count-badge'),
    crops: document.getElementById('face-crops')
  };
}

function isMobileViewport() {
  return window.matchMedia?.('(max-width: 768px), (pointer: coarse)')?.matches || false;
}

function openFilePicker(input, { capture = false } = {}) {
  if (!input) return;

  input.value = '';

  if (capture) {
    input.setAttribute('capture', 'environment');
  } else {
    input.removeAttribute('capture');
  }

  try {
    input.click();
  } catch (err) {
    console.warn('Apertura file picker fallita:', err);
  }
}

function setComposerActionsOpen(open) {
  if (!dom.composerActionsBtn || !dom.composerActionsMenu) return;

  const isOpen = Boolean(open);
  dom.composer?.classList.toggle('actions-open', isOpen);
  dom.composerActionsBtn.setAttribute('aria-expanded', String(isOpen));
  dom.composerActionsBtn.classList.toggle('is-open', isOpen);
  dom.composerActionsMenu.classList.toggle('hidden', !isOpen);
  dom.composerActionsMenu.classList.toggle('is-open', isOpen);
}

function toggleComposerActions() {
  const isOpen = dom.composerActionsBtn?.getAttribute('aria-expanded') === 'true';
  setComposerActionsOpen(!isOpen);
}

function closeComposerActions() {
  setComposerActionsOpen(false);
}

function autoResizeUserInput() {
  if (!dom.userInput) return;
  dom.userInput.style.height = 'auto';
  const nextHeight = Math.min(dom.userInput.scrollHeight, 72);
  dom.userInput.style.height = `${Math.max(22, nextHeight)}px`;
}

function isVirtualKeyboardAvailable() {
  return isMobileViewport() && dom.virtualKeyboard;
}

function setVirtualKeyboardOpen(open) {
  if (!dom.virtualKeyboard) return;
  dom.virtualKeyboard.classList.toggle('hidden', !open);
  dom.virtualKeyboard.classList.toggle('is-open', Boolean(open));
  dom.userInput?.classList.toggle('uses-virtual-keyboard', Boolean(open));
  if (!open) {
    closeVirtualKeyboardAccents();
  }
}

function openVirtualKeyboard() {
  if (!isVirtualKeyboardAvailable()) return;
  setVirtualKeyboardOpen(true);
  syncVirtualKeyboardAutoShift();
}

function closeVirtualKeyboard() {
  setVirtualKeyboardOpen(false);
}

function syncMobileKeyboardMode() {
  if (!dom.userInput) return;

  const useVirtualKeyboard = isVirtualKeyboardAvailable();
  dom.userInput.readOnly = false;
  dom.userInput.setAttribute('inputmode', useVirtualKeyboard ? 'none' : 'text');
  dom.userInput.setAttribute('virtualkeyboardpolicy', useVirtualKeyboard ? 'manual' : 'auto');
  dom.userInput.setAttribute('autocapitalize', useVirtualKeyboard ? 'off' : 'sentences');

  if (!useVirtualKeyboard) {
    closeVirtualKeyboard();
  }
}

function updateVirtualKeyboardCase() {
  if (!dom.virtualKeyboard) return;

  dom.virtualKeyboard.querySelectorAll('[data-key]').forEach(button => {
    const value = button.dataset.key || '';
    if (virtualKeyboardMode === 'letters' && value.length === 1 && /[a-zàèéìòù]/i.test(value)) {
      button.textContent = virtualKeyboardShift ? value.toUpperCase() : value.toLowerCase();
    }
  });
}

function keepInputSelectionVisible() {
  if (!dom.userInput) return;

  try {
    dom.userInput.focus({ preventScroll: true });
  } catch {
    dom.userInput.focus();
  }

  window.setTimeout(() => {
    dom.userInput?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, 0);
}

function pulseVirtualKeyboardButton(button) {
  if (!button) return;
  button.classList.remove('is-pressed');
  void button.offsetWidth;
  button.classList.add('is-pressed');
  window.setTimeout(() => button.classList.remove('is-pressed'), 150);
}

function replaceInputSelection(value = '') {
  if (!dom.userInput || !value) return;

  const input = dom.userInput;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  input.setRangeText(value, start, end, 'end');
  keepInputSelectionVisible();
  autoResizeUserInput();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  syncVirtualKeyboardAutoShift();
}

function shouldAutoShiftAfterInput() {
  if (!dom.userInput || virtualKeyboardMode !== 'letters') return false;
  const cursor = Number.isInteger(dom.userInput.selectionStart)
    ? dom.userInput.selectionStart
    : dom.userInput.value.length;
  const beforeCursor = dom.userInput.value.slice(0, cursor);
  return /(^|[.!?]\s+|\n\s*)$/.test(beforeCursor);
}

function syncVirtualKeyboardAutoShift() {
  if (!dom.virtualKeyboard || virtualKeyboardMode !== 'letters') return;
  const shouldShift = shouldAutoShiftAfterInput();
  if (virtualKeyboardShift === shouldShift) return;

  virtualKeyboardShift = shouldShift;
  dom.virtualKeyboard.classList.toggle('has-shift', virtualKeyboardShift);
  updateVirtualKeyboardCase();
}

function setVirtualKeyboardButtonKey(button, key = '') {
  if (!button) return;
  button.dataset.key = key;
  button.textContent = key;
}

function updateVirtualKeyboardLayout() {
  if (!dom.virtualKeyboard) return;

  const rows = Array.from(dom.virtualKeyboard.querySelectorAll('.vk-row'));
  const layout = virtualKeyboardMode === 'numbers'
    ? VIRTUAL_KEYBOARD_NUMBER_ROWS
    : VIRTUAL_KEYBOARD_LETTER_ROWS;

  rows.forEach((row, rowIndex) => {
    const keyButtons = Array.from(row.querySelectorAll('button[data-key]'));
    keyButtons.forEach((button, index) => {
      const nextKey = layout[rowIndex]?.[index];
      if (nextKey) {
        setVirtualKeyboardButtonKey(button, nextKey);
      }
    });
  });

  const shiftButton = dom.virtualKeyboard.querySelector('[data-action="shift"]');
  const symbolButton = dom.virtualKeyboard.querySelector('[data-action="symbols"]');

  if (shiftButton) {
    shiftButton.textContent = virtualKeyboardMode === 'numbers' ? 'ABC' : 'Aa';
  }

  if (symbolButton) {
    symbolButton.textContent = virtualKeyboardMode === 'numbers' ? 'ABC' : '123';
  }

  dom.virtualKeyboard.classList.toggle('has-numbers', virtualKeyboardMode === 'numbers');
  updateVirtualKeyboardCase();
}

function appendToInput(value = '') {
  replaceInputSelection(value);
}

function backspaceInput() {
  if (!dom.userInput) return;

  const input = dom.userInput;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;

  if (start !== end) {
    input.setRangeText('', start, end, 'end');
  } else if (start > 0) {
    input.setRangeText('', start - 1, start, 'end');
  }

  keepInputSelectionVisible();
  autoResizeUserInput();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  syncVirtualKeyboardAutoShift();
}

function closeVirtualKeyboardAccents() {
  window.clearTimeout(virtualKeyboardAccentTimer);
  virtualKeyboardAccentTimer = null;
  virtualKeyboardAccentPopover?.remove();
  virtualKeyboardAccentPopover = null;
}

function showVirtualKeyboardAccents(button, key = '') {
  const accents = VIRTUAL_KEYBOARD_ACCENTS[String(key || '').toLowerCase()];
  if (!button || !accents?.length) return;

  closeVirtualKeyboardAccents();
  virtualKeyboardSuppressClick = true;

  const rect = button.getBoundingClientRect();
  const popover = document.createElement('div');
  popover.className = 'vk-accent-popover';

  accents.forEach(accent => {
    const accentButton = document.createElement('button');
    accentButton.type = 'button';
    accentButton.textContent = virtualKeyboardShift ? accent.toUpperCase() : accent;
    accentButton.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      pulseVirtualKeyboardButton(accentButton);
      appendToInput(accentButton.textContent);
      if (virtualKeyboardShift) {
        virtualKeyboardShift = false;
        dom.virtualKeyboard?.classList.remove('has-shift');
        updateVirtualKeyboardCase();
      }
      closeVirtualKeyboardAccents();
      virtualKeyboardSuppressClick = false;
    });
    popover.appendChild(accentButton);
  });

  document.body.appendChild(popover);
  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - popoverRect.width - 8, rect.left + rect.width / 2 - popoverRect.width / 2));
  const top = Math.max(8, rect.top - popoverRect.height - 8);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  virtualKeyboardAccentPopover = popover;
}

function beginVirtualKeyboardAccent(button) {
  const key = button?.dataset?.key || '';
  if (!VIRTUAL_KEYBOARD_ACCENTS[key.toLowerCase()]) return;

  window.clearTimeout(virtualKeyboardAccentTimer);
  virtualKeyboardAccentTimer = window.setTimeout(() => {
    showVirtualKeyboardAccents(button, key);
  }, 420);
}

function cancelVirtualKeyboardAccentTimer() {
  window.clearTimeout(virtualKeyboardAccentTimer);
  virtualKeyboardAccentTimer = null;
}

function startVirtualKeyboardDrag(event) {
  if (!isVirtualKeyboardAvailable() || !dom.virtualKeyboard) return;
  if (event.target.closest('button')) return;

  const rect = dom.virtualKeyboard.getBoundingClientRect();
  virtualKeyboardDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };

  dom.virtualKeyboard.classList.add('is-dragging');
  dom.virtualKeyboard.style.left = `${rect.left}px`;
  dom.virtualKeyboard.style.top = `${rect.top}px`;
  dom.virtualKeyboard.style.right = 'auto';
  dom.virtualKeyboard.style.bottom = 'auto';
  dom.virtualKeyboard.style.width = `${rect.width}px`;
  dom.virtualKeyboard.style.transform = 'none';
  dom.virtualKeyboard.setPointerCapture?.(event.pointerId);
}

function registerVirtualKeyboardTap(event) {
  virtualKeyboardLastTap = {
    x: event.clientX,
    y: event.clientY,
    time: performance.now()
  };
}

function wasVirtualKeyboardTapDragged(event) {
  if (!virtualKeyboardLastTap) return false;

  const elapsed = performance.now() - virtualKeyboardLastTap.time;
  const distance = Math.hypot(
    event.clientX - virtualKeyboardLastTap.x,
    event.clientY - virtualKeyboardLastTap.y
  );

  return elapsed > 450 || distance > 12;
}

function moveVirtualKeyboardDrag(event) {
  if (!virtualKeyboardDrag || !dom.virtualKeyboard) return;

  const margin = 8;
  const maxLeft = Math.max(margin, window.innerWidth - virtualKeyboardDrag.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - virtualKeyboardDrag.height - margin);
  const left = Math.max(margin, Math.min(maxLeft, event.clientX - virtualKeyboardDrag.offsetX));
  const top = Math.max(margin, Math.min(maxTop, event.clientY - virtualKeyboardDrag.offsetY));

  dom.virtualKeyboard.style.left = `${left}px`;
  dom.virtualKeyboard.style.top = `${top}px`;
}

function endVirtualKeyboardDrag(event) {
  if (!virtualKeyboardDrag || !dom.virtualKeyboard) return;
  dom.virtualKeyboard.releasePointerCapture?.(virtualKeyboardDrag.pointerId || event.pointerId);
  dom.virtualKeyboard.classList.remove('is-dragging');
  virtualKeyboardDrag = null;
}

async function handleVirtualKeyboardAction(action = '') {
  if (action === 'backspace') {
    backspaceInput();
    return;
  }

  if (action === 'space') {
    appendToInput(' ');
    return;
  }

  if (action === 'newline') {
    appendToInput('\n');
    dom.virtualKeyboard?.classList.add('vk-newline-pop');
    window.setTimeout(() => dom.virtualKeyboard?.classList.remove('vk-newline-pop'), 180);
    return;
  }

  if (action === 'symbols') {
    virtualKeyboardMode = virtualKeyboardMode === 'numbers' ? 'letters' : 'numbers';
    virtualKeyboardShift = false;
    dom.virtualKeyboard?.classList.remove('has-shift');
    updateVirtualKeyboardLayout();
    return;
  }

  if (action === 'shift') {
    if (virtualKeyboardMode === 'numbers') {
      virtualKeyboardMode = 'letters';
      virtualKeyboardShift = false;
      dom.virtualKeyboard?.classList.remove('has-shift');
      updateVirtualKeyboardLayout();
      return;
    }

    virtualKeyboardShift = !virtualKeyboardShift;
    dom.virtualKeyboard?.classList.toggle('has-shift', virtualKeyboardShift);
    updateVirtualKeyboardCase();
  }
}

function getFaceDetectorInputSize(highQuality = false) {
  if (!isMobileViewport()) return DESKTOP_FACE_DETECTOR_INPUT_SIZE;
  return highQuality ? MOBILE_FACE_FALLBACK_DETECTOR_INPUT_SIZE : MOBILE_FACE_DETECTOR_INPUT_SIZE;
}

function getFaceEmbeddingInputSize(highQuality = false) {
  if (!isMobileViewport()) return DESKTOP_FACE_EMBEDDING_INPUT_SIZE;
  return highQuality ? MOBILE_FACE_FALLBACK_EMBEDDING_INPUT_SIZE : MOBILE_FACE_EMBEDDING_INPUT_SIZE;
}

function getFaceDetectorScoreThreshold(highQuality = false) {
  if (!isMobileViewport()) return DESKTOP_FACE_SCORE_THRESHOLD;
  return highQuality ? MOBILE_FACE_FALLBACK_SCORE_THRESHOLD : MOBILE_FACE_SCORE_THRESHOLD;
}

function getFaceMatchLimit(highQuality = false) {
  if (!isMobileViewport()) return DESKTOP_FACE_MATCH_LIMIT;
  return highQuality ? MOBILE_FACE_FALLBACK_MATCH_LIMIT : MOBILE_FACE_MATCH_LIMIT;
}

function getFacePreviewMaxDimension() {
  return isMobileViewport() ? MOBILE_FACE_PREVIEW_MAX_DIMENSION : DESKTOP_FACE_PREVIEW_MAX_DIMENSION;
}

function setFaceAnalysisStatus(text = '') {
  const { badge } = getImagePreviewElements();
  if (!badge) return;

  if (!text) {
    badge.textContent = '';
    badge.classList.add('hidden');
    return;
  }

  badge.textContent = text;
  badge.classList.remove('hidden');
}

function normalizeExtractedImageText(value = '') {
  const safe = normalizeString(value).trim();
  if (!safe) return '';

  const lower = safe.toLowerCase();
  if (lower === '(no text)' || lower === 'no text' || lower === 'nessun testo') {
    return '';
  }

  return safe;
}

function isCurrentPendingPreview(previewUrl = '') {
  return Boolean(previewUrl && previewUrl === pendingImagePreviewUrl);
}

function loadImageElementFromUrl(url = '') {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('URL immagine non valido'));
      return;
    }

    const image = new Image();
    image.decoding = 'async';

    image.onload = () => {
      resolve(image);
    };

    image.onerror = () => {
      reject(new Error('Impossibile preparare l’immagine'));
    };

    image.src = url;
  });
}

function isLipuSelfLabel(label = '') {
  const normalized = String(label || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return /\b(lipu|alessandro lipuma)\b/.test(normalized);
}

function passesRecognitionThreshold(face, defaultThreshold) {
  const score = Number(face?.score || 0);
  const threshold = isLipuSelfLabel(face?.label)
    ? Math.max(Number(defaultThreshold) || 0, LIPU_SELF_MIN_SCORE)
    : Number(defaultThreshold) || 0;

  return score >= threshold;
}

function hasUncertainKnownFaces() {
  return (pendingFaceMatches || [])
    .some(match => {
      const label = normalizeString(match?.label).trim();

      return (
        label &&
        label !== 'Sconosciuto' &&
        match?.status === 'uncertain'
      );
    });
}

function hasRecognizedKnownFaces(matches = pendingFaceMatches) {
  return (matches || []).some(match => match?.status === 'known');
}

function updatePendingImageRecognitionIndicator(status = pendingImageRecognitionStatus) {
  pendingImageRecognitionStatus = status || '';
  const indicator = pendingImageUI?.recognitionIndicator;
  if (!indicator) return;

  indicator.classList.remove('is-known', 'is-unrecognized');

  if (!pendingImageRecognitionStatus || !pendingImageFile) {
    indicator.hidden = true;
    indicator.setAttribute('aria-label', '');
    return;
  }

  indicator.hidden = false;

  if (pendingImageRecognitionStatus === 'known') {
    indicator.classList.add('is-known');
    indicator.setAttribute('aria-label', 'Volto riconosciuto');
    return;
  }

  indicator.classList.add('is-unrecognized');
  indicator.setAttribute('aria-label', 'Volto non riconosciuto');
}

async function waitForFaceMatches(timeout = 2200) {
  if (pendingFaceAnalysisPromise) {
    const completed = await Promise.race([
      pendingFaceAnalysisPromise.then(() => true).catch(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), timeout))
    ]);

    return completed;
  }

  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (Array.isArray(pendingFaceMatches) && pendingFaceMatches.length > 0) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  console.warn('[FACES] timeout waiting for matches');
  return false;
}


async function ensureFaceApiModels() {
  if (faceApiModelsReadyPromise) return faceApiModelsReadyPromise;

  const faceapi = window.faceapi;
  if (!faceapi) {
    throw new Error('face-api.js non disponibile nel browser');
  }

  faceApiModelsReadyPromise = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODELS_PATH),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_API_MODELS_PATH),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_API_MODELS_PATH)
  ]).then(() => true);

  return faceApiModelsReadyPromise;
}



function normalizeKnownFaceThresholds(thresholds = {}) {
  const known = Math.max(
    KNOWN_FACE_MIN_SCORE,
    Number(thresholds?.known) || KNOWN_FACE_MIN_SCORE
  );
  const uncertain = Math.min(
    known,
    Math.max(
      UNCERTAIN_FACE_MIN_SCORE,
      Number(thresholds?.uncertain) || UNCERTAIN_FACE_MIN_SCORE
    )
  );

  return {
    known,
    uncertain,
    minMarginKnown: Number(thresholds?.minMarginKnown) || 0.03,
    minMarginUncertain: Number(thresholds?.minMarginUncertain) || 0.015
  };
}

function ensureKnownFacesShape(data) {
  if (!data || typeof data !== 'object') {
    return {
      version: 2,
      engine: 'face-api.js',
      descriptorLength: 128,
      metric: 'cosine',
      thresholds: normalizeKnownFaceThresholds(),
      people: []
    };
  }

  return {
    version: Number(data.version) || 2,
    engine: String(data.engine || 'face-api.js'),
    descriptorLength: Number(data.descriptorLength) || 128,
    metric: String(data.metric || 'cosine'),
    thresholds: normalizeKnownFaceThresholds(data?.thresholds),
    people: Array.isArray(data.people)
      ? data.people.map(person => ({
          id: String(person?.id || '').trim(),
          label: String(person?.label || person?.id || '').trim(),
          embeddings: Array.isArray(person?.embeddings) ? person.embeddings : []
        }))
      : []
  };
}

async function loadKnownFacesData() {
  if (knownFacesCache) return knownFacesCache;

  // 🔥 PRIORITY: use local override if present (embeddings just created)
  const override = readKnownFacesOverride();
  if (override && Array.isArray(override.people) && override.people.length) {
    knownFacesCache = ensureKnownFacesShape(override);
    console.warn('[DEBUG] using LOCAL embeddings override');
    return knownFacesCache;
  }

  // fallback to JSON
  const response = await fetch(`${KNOWN_FACES_JSON_PATH}?t=${Date.now()}`, {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Impossibile caricare known-faces.json: HTTP ${response.status}`);
  }

  const data = await response.json();
  knownFacesCache = ensureKnownFacesShape(data);

  console.warn('[DEBUG] using JSON embeddings');

  return knownFacesCache;
}

function normalizeEmbeddingVector(values = []) {
  const vector = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  if (!vector.length) return [];

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) return [];

  return vector.map(value => value / norm);
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return -1;
  if (!a.length || !b.length || a.length !== b.length) return -1;

  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Number(a[i] || 0) * Number(b[i] || 0);
  }

  return sum;
}

function averageEmbeddings(embeddings = []) {
  const valid = Array.isArray(embeddings)
    ? embeddings.filter(item => Array.isArray(item) && item.length)
    : [];

  if (!valid.length) return [];

  const length = valid[0].length;
  if (!valid.every(item => item.length === length)) return [];

  const sums = new Array(length).fill(0);

  for (const embedding of valid) {
    for (let i = 0; i < length; i += 1) {
      sums[i] += Number(embedding[i] || 0);
    }
  }

  return normalizeEmbeddingVector(sums.map(value => value / valid.length));
}

function scoreToPercent(score = 0) {
  const safe = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(100, Math.round(safe * 100)));
}

function buildUnknownMatch(score = 0) {
  return {
    personId: '',
    label: 'Sconosciuto',
    score,
    scorePercent: scoreToPercent(score),
    margin: 0,
    marginPercent: 0,
    status: 'unknown',
    topCandidates: []
  };
}


async function generateEmbeddingFromCanvas(faceCanvas, options = {}) {
  const highQuality = Boolean(options.highQuality);
  const faceapi = window.faceapi;
  if (!faceapi) {
    throw new Error('face-api.js non disponibile nel browser');
  }

  await ensureFaceApiModels();

  const result = await faceapi
    .detectSingleFace(
      faceCanvas,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: getFaceEmbeddingInputSize(highQuality),
        scoreThreshold: getFaceDetectorScoreThreshold(highQuality)
      })
    )
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!result?.descriptor) {
    return [];
  }

  return normalizeEmbeddingVector(Array.from(result.descriptor));
}


function classifyMatch(score, thresholds) {
  const normalizedThresholds = normalizeKnownFaceThresholds(thresholds);
  const knownThreshold = normalizedThresholds.known;
  const uncertainThreshold = normalizedThresholds.uncertain;

  if (score > knownThreshold) return 'known';
  if (score >= uncertainThreshold) return 'uncertain';
  return 'unknown';
}

async function matchFaceEmbedding(embedding) {
  console.warn('[DEBUG] matchFaceEmbedding ENTER', {
    embeddingLength: Array.isArray(embedding) ? embedding.length : 0
  });

  const database = await loadKnownFacesData();
  const people = Array.isArray(database.people) ? database.people : [];
  const thresholds = database?.thresholds || {};

  const candidates = [];

  for (const person of people) {
    const rawEmbeddings = Array.isArray(person.embeddings) ? person.embeddings : [];
    const normalizedEmbeddings = rawEmbeddings
      .map(stored => normalizeEmbeddingVector(stored))
      .filter(stored => stored.length && stored.length === embedding.length);

    if (!normalizedEmbeddings.length) continue;

    let bestSampleScore = -1;
    for (const stored of normalizedEmbeddings) {
      const score = cosineSimilarity(embedding, stored);
      if (score > bestSampleScore) {
        bestSampleScore = score;
      }
    }

    const prototype = averageEmbeddings(normalizedEmbeddings);
    const prototypeScore = prototype.length ? cosineSimilarity(embedding, prototype) : -1;

    const combinedScore =
      prototypeScore >= 0
        ? bestSampleScore * 0.7 + prototypeScore * 0.3
        : bestSampleScore;

    candidates.push({
      personId: person.id,
      label: person.label || person.id,
      bestSampleScore,
      prototypeScore,
      score: combinedScore,
      scorePercent: scoreToPercent(combinedScore),
      samples: normalizedEmbeddings.length
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const margin = best && second ? best.score - second.score : best ? best.score : 0;
  const status = best ? classifyMatch(best.score, thresholds) : 'unknown';

  const topCandidates = candidates.slice(0, 3).map(candidate => ({
    personId: candidate.personId,
    label: candidate.label,
    score: candidate.score,
    scorePercent: candidate.scorePercent,
    bestSampleScore: candidate.bestSampleScore,
    prototypeScore: candidate.prototypeScore,
    samples: candidate.samples
  }));

  console.warn(
    '[DEBUG] face-match-top3',
    topCandidates.map(candidate => ({
      label: candidate.label,
      score: candidate.score.toFixed(4),
      scorePercent: `${candidate.scorePercent}%`,
      bestSampleScore: candidate.bestSampleScore.toFixed(4),
      prototypeScore: candidate.prototypeScore >= 0 ? candidate.prototypeScore.toFixed(4) : 'n/a',
      samples: candidate.samples
    }))
  );

  if (!best) {
    return buildUnknownMatch(0);
  }

  const debugPayload = {
    bestLabel: best.label,
    bestScore: best.score.toFixed(4),
    bestScorePercent: `${best.scorePercent}%`,
    margin: margin.toFixed(4),
    marginPercent: `${scoreToPercent(margin)}%`,
    status
  };
  console.warn('[DEBUG] face-match-best', debugPayload);

  if (status === 'unknown') {
    return {
      ...buildUnknownMatch(best.score),
      topCandidates
    };
  }

  if (status === 'uncertain') {
    return {
      personId: best.personId,
      label: `${best.label}?`,
      score: best.score,
      scorePercent: best.scorePercent,
      margin,
      marginPercent: scoreToPercent(margin),
      status,
      topCandidates
    };
  }

  return {
    personId: best.personId,
    label: best.label,
    score: best.score,
    scorePercent: best.scorePercent,
    margin,
    marginPercent: scoreToPercent(margin),
    status,
    topCandidates
  };
}

function cropFaceDetectionToCanvas(sourceImage, detection) {
  const box = detection?.box || detection?.boundingBox;
  if (!box || !sourceImage?.naturalWidth || !sourceImage?.naturalHeight) return null;

  const xMin = Number(box.xMin ?? 0);
  const yMin = Number(box.yMin ?? 0);
  const width = Number(box.width ?? 0);
  const height = Number(box.height ?? 0);

  if (![xMin, yMin, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;

  const padX = width * 0.28;
  const padY = height * 0.35;

  const sx = Math.max(0, Math.floor(xMin - padX));
  const sy = Math.max(0, Math.floor(yMin - padY));
  const sw = Math.min(sourceImage.naturalWidth - sx, Math.floor(width + padX * 2));
  const sh = Math.min(sourceImage.naturalHeight - sy, Math.floor(height + padY * 2));

  if (sw <= 0 || sh <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}


function clearFacePreviewUI() {
  const { container, preview, badge, crops } = getImagePreviewElements();

  pendingFaceDetections = [];
  pendingFaceMatches = [];
  pendingFaceAnalysisId += 1;
  pendingFaceAnalysisFailed = false;
  pendingFaceLowConfidenceBlocked = false;
  pendingImageRecognitionStatus = '';
  updatePendingImageRecognitionIndicator('');
  setParticlesScanning(false);

  if (preview) {
    preview.removeAttribute('src');
    preview.classList.add('hidden');
  }

  if (badge) {
    badge.textContent = '';
    badge.classList.add('hidden');
  }

  if (crops) {
    crops.innerHTML = '';
  }

  if (container) {
    container.classList.add('hidden');
  }
}

function updateFaceCountBadge() {
  const { badge } = getImagePreviewElements();
  if (!badge) return;

  badge.textContent = '';
  badge.classList.add('hidden');
}





function renderFaceCrops(sourceImage, detections = [], matches = []) {
  const { crops } = getImagePreviewElements();
  if (!crops) return;

  crops.innerHTML = '';

  detections.forEach((detection, index) => {
    const box = detection?.box || detection?.boundingBox;
    if (!box) return;
    if (!sourceImage.complete || !sourceImage.naturalWidth || !sourceImage.naturalHeight) return;

    const naturalWidth = sourceImage.naturalWidth;
    const naturalHeight = sourceImage.naturalHeight;

    const xMin = Number(box.xMin ?? 0);
    const yMin = Number(box.yMin ?? 0);
    const width = Number(box.width ?? 0);
    const height = Number(box.height ?? 0);

    if (![xMin, yMin, width, height].every(Number.isFinite)) return;
    if (width <= 0 || height <= 0) return;

    const padX = width * 0.28;
    const padY = height * 0.35;

    const sx = Math.max(0, Math.floor(xMin - padX));
    const sy = Math.max(0, Math.floor(yMin - padY));
    const sw = Math.min(naturalWidth - sx, Math.floor(width + padX * 2));
    const sh = Math.min(naturalHeight - sy, Math.floor(height + padY * 2));

    if (sw <= 0 || sh <= 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);

    const cropWrap = document.createElement('div');
    cropWrap.className = 'face-crop-item';
    cropWrap.style.display = 'flex';
    cropWrap.style.flexDirection = 'column';
    cropWrap.style.alignItems = 'center';
    cropWrap.style.gap = '4px';

    const cropImg = document.createElement('img');
    cropImg.src = canvas.toDataURL('image/png');
    cropImg.alt = `Volto ${index + 1}`;
    cropImg.className = 'face-crop-image';
    cropImg.style.width = '52px';
    cropImg.style.height = '52px';
    cropImg.style.objectFit = 'cover';
    cropImg.style.borderRadius = '10px';
    cropImg.style.border = '1px solid rgba(255,255,255,0.08)';

    cropWrap.appendChild(cropImg);
    crops.appendChild(cropWrap);
  });
}

function normalizeFaceDetectionResults(results = [], limit = DESKTOP_FACE_MATCH_LIMIT) {
  return (Array.isArray(results) ? results : [])
    .map(result => ({
      box: {
        xMin: Number(result?.detection?.box?.x || 0),
        yMin: Number(result?.detection?.box?.y || 0),
        width: Number(result?.detection?.box?.width || 0),
        height: Number(result?.detection?.box?.height || 0)
      },
      descriptor: Array.isArray(result?.descriptor)
        ? result.descriptor
        : result?.descriptor
        ? Array.from(result.descriptor)
        : []
    }))
    .filter(detection => {
      const box = detection?.box;
      if (!box) return false;
      const { xMin, yMin, width, height } = box;
      if (![xMin, yMin, width, height].every(Number.isFinite)) return false;
      if (width <= 0 || height <= 0) return false;
      if (width < 20 || height < 20) return false;
      const aspectRatio = width / height;
      return aspectRatio >= 0.55 && aspectRatio <= 1.8;
    })
    .sort((a, b) => {
      const areaA = (a?.box?.width || 0) * (a?.box?.height || 0);
      const areaB = (b?.box?.width || 0) * (b?.box?.height || 0);
      return areaB - areaA;
    })
    .slice(0, limit);
}

async function runFaceRecognitionPass(analysisImage, options = {}) {
  const highQuality = Boolean(options.highQuality);
  const faceapi = window.faceapi;
  const results = await faceapi
    .detectAllFaces(
      analysisImage,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: getFaceDetectorInputSize(highQuality),
        scoreThreshold: getFaceDetectorScoreThreshold(highQuality)
      })
    )
    .withFaceLandmarks(true)
    .withFaceDescriptors();

  const detections = normalizeFaceDetectionResults(results, getFaceMatchLimit(highQuality));

  if (!isMobileViewport()) {
    console.warn('[DEBUG] face-detect-count:', detections.length);
    console.warn(
      '[DEBUG] face-detect-descriptors:',
      detections.map((d, i) => ({
        index: i,
        hasDescriptor: Array.isArray(d?.descriptor) && d.descriptor.length > 0,
        descriptorLength: Array.isArray(d?.descriptor) ? d.descriptor.length : 0
      }))
    );
  }

  const matches = [];

  for (const detection of detections) {
    let embedding = normalizeEmbeddingVector(detection?.descriptor || []);

    if (!isMobileViewport()) {
      console.warn('[DEBUG] before-match', {
        embeddingLength: embedding.length,
        hasDescriptor: Array.isArray(detection?.descriptor) && detection.descriptor.length > 0
      });
    }

    if (!embedding.length) {
      const faceCanvas = cropFaceDetectionToCanvas(analysisImage, detection);
      if (faceCanvas) {
        embedding = await generateEmbeddingFromCanvas(faceCanvas, { highQuality });
      }
    }

    if (!embedding.length) {
      matches.push({
        label: 'Sconosciuto',
        status: 'unknown',
        score: 0
      });
      continue;
    }

    const match = await matchFaceEmbedding(embedding);
    matches.push(match);
  }

  return { detections, matches };
}

async function analyzePendingImageFaces(previewUrl) {
  const analysisId = ++pendingFaceAnalysisId;
  const { container, preview, badge, crops } = getImagePreviewElements();
  if (!container || !preview || !badge || !crops || !previewUrl) return;

  container.classList.remove('hidden');
  preview.classList.remove('hidden');
  preview.src = previewUrl;
  setFaceAnalysisStatus('Analisi volto...');
  setParticlesScanning(true);
  crops.innerHTML = '';
  pendingFaceAnalysisFailed = false;

  try {
    if (!isCurrentPendingPreview(previewUrl)) return;

    const analysisImage = await loadImageElementFromUrl(previewUrl);

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingImageNaturalWidth = Number(analysisImage.naturalWidth || analysisImage.width || 0);
    pendingImageNaturalHeight = Number(analysisImage.naturalHeight || analysisImage.height || 0);

    const faceapi = window.faceapi;
    if (!faceapi) {
      throw new Error('face-api.js non disponibile nel browser');
    }

    await ensureFaceApiModels();

    let recognition = await runFaceRecognitionPass(analysisImage, { highQuality: false });

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    if (isMobileViewport() && !hasRecognizedKnownFaces(recognition.matches)) {
      setFaceAnalysisStatus('Verifica volto...');
      recognition = await runFaceRecognitionPass(analysisImage, { highQuality: true });
    }

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = recognition.detections;
    pendingFaceMatches = recognition.matches;
    pendingFaceLowConfidenceBlocked = hasUncertainKnownFaces();
    pendingFaceAnalysisFailed = false;
    updatePendingImageRecognitionIndicator(hasRecognizedKnownFaces(recognition.matches) ? 'known' : 'unrecognized');
    updateFaceCountBadge(pendingFaceDetections.length);
    if (isMobileViewport()) {
      crops.innerHTML = '';
    } else {
      renderFaceCrops(analysisImage, pendingFaceDetections, recognition.matches);
    }
  } catch (err) {
    console.error('Errore analyzePendingImageFaces:', err);

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = [];
    pendingFaceMatches = [];
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceAnalysisFailed = true;
    updatePendingImageRecognitionIndicator('unrecognized');
    setFaceAnalysisStatus('');
    crops.innerHTML = '';
  } finally {
    if (isCurrentPendingPreview(previewUrl) && analysisId === pendingFaceAnalysisId) {
      setParticlesScanning(false);
    }
  }
}

function ensurePendingImageUI() {
  if (pendingImageUI || !dom.userInput) return pendingImageUI;

  const composerCenter = dom.userInput.closest('.composer-center') || dom.userInput.parentElement;
  if (!composerCenter) return null;

  const wrap = document.createElement('div');
  wrap.className = 'pending-image-chip';
  wrap.style.display = 'none';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '5px';
  wrap.style.flexShrink = '0';

  const preview = document.createElement('img');
  preview.className = 'pending-image-preview';
  preview.alt = 'Immagine pronta da inviare';
  preview.style.width = '34px';
  preview.style.height = '34px';
  preview.style.borderRadius = '10px';
  preview.style.objectFit = 'cover';
  preview.style.border = '1px solid rgba(255,255,255,0.08)';

  const label = document.createElement('span');
  label.className = 'pending-image-label';
  label.textContent = '';
  label.hidden = true;
  label.style.fontSize = '12px';
  label.style.color = 'rgba(255,255,255,0.72)';
  label.style.whiteSpace = 'nowrap';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'pending-image-remove';
  removeBtn.textContent = '×';
  removeBtn.setAttribute('aria-label', 'Rimuovi immagine');
  removeBtn.style.width = '26px';
  removeBtn.style.height = '26px';
  removeBtn.style.border = 'none';
  removeBtn.style.borderRadius = '999px';
  removeBtn.style.cursor = 'pointer';
  removeBtn.style.background = 'rgba(255,255,255,0.08)';
  removeBtn.style.color = 'white';
  removeBtn.style.fontSize = '16px';
  removeBtn.style.lineHeight = '1';
  removeBtn.style.display = 'grid';
  removeBtn.style.placeItems = 'center';

  const recognitionIndicator = document.createElement('span');
  recognitionIndicator.className = 'pending-image-recognition-dot';
  recognitionIndicator.hidden = true;
  recognitionIndicator.setAttribute('role', 'status');
  recognitionIndicator.setAttribute('aria-label', '');

  removeBtn.addEventListener('click', () => {
    clearPendingImage();
    dom.userInput?.focus();
  });

  wrap.appendChild(preview);
  wrap.appendChild(label);
  wrap.appendChild(recognitionIndicator);
  wrap.appendChild(removeBtn);
  composerCenter.insertBefore(wrap, dom.userInput);

  pendingImageUI = {
    wrap,
    preview,
    label,
    recognitionIndicator,
    removeBtn
  };

  return pendingImageUI;
}

function updatePendingImageUI() {
  const ui = ensurePendingImageUI();
  if (!ui) return;

  if (pendingImageFile && pendingImagePreviewUrl) {
    ui.preview.src = pendingImagePreviewUrl;
    ui.label.textContent = '';
    ui.wrap.style.display = 'inline-flex';
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceLowConfidenceAlertedAnalysisId = 0;
    updatePendingImageRecognitionIndicator('');
    pendingFaceAnalysisPromise = analyzePendingImageFaces(pendingImagePreviewUrl).catch(err => {
      console.error('Errore preview face detection:', err);
    });
  } else {
    ui.preview.removeAttribute('src');
    ui.label.textContent = '';
    ui.wrap.style.display = 'none';
    pendingFaceAnalysisPromise = null;
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceLowConfidenceAlertedAnalysisId = 0;
    updatePendingImageRecognitionIndicator('');
    clearFacePreviewUI();
  }
}

async function createSafeImagePreviewUrl(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    return {
      url: file ? URL.createObjectURL(file) : '',
      generated: false
    };
  }

  try {
    const drawable = await loadDrawableImageFromFile(file);
    const longestSide = Math.max(drawable.width, drawable.height);
    const maxPreviewDimension = getFacePreviewMaxDimension();
    const scale = longestSide > maxPreviewDimension ? maxPreviewDimension / longestSide : 1;
    const targetWidth = Math.max(1, Math.round(drawable.width * scale));
    const targetHeight = Math.max(1, Math.round(drawable.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      drawable.close?.();
      return { url: URL.createObjectURL(file), generated: false };
    }

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(drawable.source, 0, 0, targetWidth, targetHeight);
    drawable.close?.();

    if (isCanvasLikelyBlank(canvas)) {
      console.warn('Preview normalizzata sospetta: canvas quasi vuota, uso originale.');
      return { url: URL.createObjectURL(file), generated: false };
    }

    return {
      url: canvas.toDataURL('image/jpeg', 0.86),
      generated: true
    };
  } catch (err) {
    console.warn('Preview normalizzata non disponibile, uso originale:', err);
    return {
      url: URL.createObjectURL(file),
      generated: false
    };
  }
}

async function setPendingImage(file) {
  if (!file) return;

  if (pendingImagePreviewUrl && !pendingImagePreviewGenerated) {
    URL.revokeObjectURL(pendingImagePreviewUrl);
  }

  resetAudioComposerState();
  const preview = await createSafeImagePreviewUrl(file);
  pendingImageFile = file;
  pendingImagePreviewUrl = preview.url;
  pendingImagePreviewGenerated = preview.generated;
  pendingImageNaturalWidth = 0;
  pendingImageNaturalHeight = 0;
  updatePendingImageUI();
  updateSendButtonState();
}

function loadImageElementFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Impossibile leggere l’immagine'));
    };

    image.src = url;
  });
}

function dataURLToFile(dataUrl, filename = 'immagine.jpg') {
  const [header, base64] = String(dataUrl || '').split(',');
  const mime = header?.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new File([bytes], filename, { type: mime, lastModified: Date.now() });
}

async function loadDrawableImageFromFile(file) {
  if (window.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image'
      });

      if (bitmap?.width && bitmap?.height) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close?.()
        };
      }
    } catch (err) {
      console.warn('createImageBitmap non disponibile per questa immagine, provo fallback:', err);
    }
  }

  const image = await loadImageElementFromBlob(file);
  const width = Number(image.naturalWidth || image.width || 0);
  const height = Number(image.naturalHeight || image.height || 0);

  return {
    source: image,
    width,
    height,
    close: () => {}
  };
}

function getCanvasSampleStats(canvas) {
  const width = Number(canvas?.width || 0);
  const height = Number(canvas?.height || 0);
  if (!width || !height) return null;

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 24;
  sampleCanvas.height = 24;

  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sampleCtx) return null;

  sampleCtx.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);

  let data;
  try {
    data = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
  } catch {
    return null;
  }

  let darkPixels = 0;
  let brightPixels = 0;
  let visiblePixels = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 8) continue;

    visiblePixels += 1;
    const luminance = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    luminanceSum += luminance;
    luminanceSqSum += luminance * luminance;
    if (luminance < 8) darkPixels += 1;
    if (luminance > 247) brightPixels += 1;
  }

  if (!visiblePixels) return null;

  const average = luminanceSum / visiblePixels;
  const variance = luminanceSqSum / visiblePixels - average * average;

  return {
    average,
    variance: Math.max(0, variance),
    darkRatio: darkPixels / visiblePixels,
    brightRatio: brightPixels / visiblePixels
  };
}

function isCanvasLikelyBlank(canvas) {
  const stats = getCanvasSampleStats(canvas);
  if (!stats) return true;

  return (
    stats.darkRatio > 0.985 ||
    stats.brightRatio > 0.985 ||
    (stats.variance < 2 && (stats.average < 12 || stats.average > 243))
  );
}

async function compressImageForSend(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return file;
  if (String(file.type || '').toLowerCase() === 'image/gif') return file;

  let drawable = null;

  try {
    drawable = await loadDrawableImageFromFile(file);
    const width = Number(drawable.width || 0);
    const height = Number(drawable.height || 0);

    if (!width || !height) return file;

    const longestSide = Math.max(width, height);
    if (longestSide <= IMAGE_SEND_MAX_DIMENSION && file.size < 1_200_000) {
      return file;
    }

    const scale = Math.min(1, IMAGE_SEND_MAX_DIMENSION / longestSide);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return file;

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(drawable.source, 0, 0, targetWidth, targetHeight);

    if (isCanvasLikelyBlank(canvas)) {
      console.warn('Compressione immagine sospetta: canvas quasi vuota, uso originale.');
      return file;
    }

    const blob = await new Promise(resolve => {
      if (canvas.toBlob) {
        canvas.toBlob(resolve, 'image/jpeg', IMAGE_SEND_JPEG_QUALITY);
        return;
      }

      try {
        resolve(dataURLToFile(canvas.toDataURL('image/jpeg', IMAGE_SEND_JPEG_QUALITY), 'immagine.jpg'));
      } catch {
        resolve(null);
      }
    });

    if (!blob) return file;
    if (blob.size < 1024 && file.size > 1024) return file;

    return new File(
      [blob],
      String(file.name || 'immagine').replace(/\.[^.]+$/, '') + '.jpg',
      { type: 'image/jpeg', lastModified: Date.now() }
    );
  } catch (err) {
    console.warn('Compressione immagine fallita, uso originale:', err);
    return file;
  } finally {
    drawable?.close?.();
  }
}

function clearPendingImage() {
  if (pendingImagePreviewUrl && !pendingImagePreviewGenerated) {
    URL.revokeObjectURL(pendingImagePreviewUrl);
  }

  pendingImageFile = null;
  pendingImagePreviewUrl = '';
  pendingImagePreviewGenerated = false;
  pendingImageNaturalWidth = 0;
  pendingImageNaturalHeight = 0;
  pendingFaceAnalysisPromise = null;
  pendingFaceLowConfidenceBlocked = false;
  pendingFaceLowConfidenceAlertedAnalysisId = 0;
  pendingFaceAnalysisFailed = false;
  setParticlesScanning(false);
  clearFacePreviewUI();
  updatePendingImageUI();
  updateSendButtonState();
}

async function buildImagePrompt(file, userText = '') {

  const HIGH_THRESHOLD = Number(
    (await loadKnownFacesData())?.thresholds?.known || KNOWN_FACE_MIN_SCORE
  );

  const recognizedFaces = (pendingFaceMatches || [])
    .map((m, i) => {
      const det = pendingFaceDetections[i];
      return {
        label: m.label,
        score: m.score,
        status: m.status,
        box: det?.box
      };
    })
    .filter(f =>
      f.label &&
      f.label !== 'Sconosciuto' &&
      f.status === 'known' &&
      passesRecognitionThreshold(f, HIGH_THRESHOLD)
    );

  // Explicitly set active identity when Lipu is detected
  const isSelfPresent = recognizedFaces.some(f => {
    return isLipuSelfLabel(f.label);
  });

  // 🔥 2. COSTRUZIONE CONTESTO PERSONE
  const peopleContext = recognizedFaces.length
    ? recognizedFaces
        .map(f => {
          const x = Math.round(f.box?.xMin || 0);
          const y = Math.round(f.box?.yMin || 0);
          return `${f.label} (posizione: ${x}, ${y})`;
        })
        .join(', ')
    : '';

  // 🔥 3. GEMINI FALLBACK (come già hai)
  const rawExtractedImageText = await extractTextFromImageWithGemini(file);
  const extractedText = normalizeExtractedImageText(rawExtractedImageText);

  const imageContext = await extractImageContextWithGemini(file);

  return `

L'utente ha inviato un'immagine${userText ? ' accompagnata da un messaggio' : ''}.

${peopleContext ? `Persone riconosciute (alta confidenza): ${peopleContext}` : ''}


Messaggio dell'utente:
${userText || 'nessun testo scritto'}


Testo estratto dall'immagine:
${extractedText || 'nessun testo rilevante'}

Contesto visivo dell'immagine:
- scena: ${imageContext?.scene || 'non definita'}
- tipo/contesto: ${imageContext?.context || 'non definito'}
- tono visivo: ${imageContext?.mood || 'non definito'}
- testo visibile sintetico: ${imageContext?.visibleText || 'nessuno'}


Regole:

- se sono presenti nomi, usali per descrivere le persone"
- NON inventare identità
- se non ci sono persone affidabili, ignora completamente i nomi
- descrivi cosa stanno facendo e il contesto
- Le informazioni sui nomi NON derivano dall'immagine ma da contesto già noto e fornito.
Non devi fare riconoscimento facciale.
- Non dichiarare mai limiti tecnici o impossibilità di identificare persone.
`.trim();
}

function trimMemory() {
  state.workingMemory = state.workingMemory
    .filter(msg => msg.type === 'text' && msg.content)
    .slice(-20);

  saveWorkingMemory();
}

function trimConversationHistory() {
  state.conversationHistory = state.conversationHistory
    .filter(msg => msg.type === 'text' && msg.content)
    .slice(-MAX_CONVERSATION_HISTORY_MESSAGES);

  saveConversationHistory();
}

function extractDefaultUserName(text = '') {
  const raw = normalizeString(text).trim();
  if (!raw) return '';

  const match = raw.match(
    /(?:mi chiamo|io mi chiamo|sono|io sono|il mio nome (?:è|e')|chiamami)\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ' -]{1,38})/i
  );

  if (!match) return '';

  const candidate = String(match[1] || '')
    .split(/[,.!?;:\n]/)[0]
    .replace(/\s+/g, ' ')
    .trim();

  if (!candidate || candidate.length < 2 || candidate.length > 40) return '';

  const lower = candidate.toLowerCase();
  const blocked = new Set([
    'qui',
    'qua',
    'felice',
    'triste',
    'stanco',
    'stanca',
    'arrabbiato',
    'arrabbiata',
    'al mare',
    'a casa',
    'in macchina'
  ]);

  if (blocked.has(lower)) return '';

  return candidate
    .split(' ')
    .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : '')
    .join(' ');
}

function rememberDefaultUserNameFromMessage(role, content) {
  if (normalizeRole(role) !== 'user') return;
  if (state.activeUserProfileId !== 'none') return;

  const name = extractDefaultUserName(content);
  if (!name) return;

  try {
    const existingName = String(localStorage.getItem(STORAGE_KEYS.defaultUserName) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (existingName && existingName.toLowerCase() === name.toLowerCase()) return;

    localStorage.setItem(STORAGE_KEYS.defaultUserName, name);
    console.warn('[PROFILE] nome utente default salvato:', name);
  } catch (err) {
    console.warn('Salvataggio nome utente default fallito:', err);
  }
}

function saveTextToMemory(role, content) {
  const safeContent = normalizeString(content).trim();
  if (!safeContent) return;

  rememberDefaultUserNameFromMessage(role, safeContent);

  const message = {
    role: normalizeRole(role),
    content: safeContent,
    type: 'text',
    timestamp: Date.now()
  };

  state.conversationHistory.push(message);
  trimConversationHistory();

  state.workingMemory.push(message);
  trimMemory();
}

function disableComposer(disabled) {
  if (disabled) closeComposerActions();

  dom.sendBtn.disabled = disabled;
  dom.recordBtn.disabled = disabled;
  dom.userInput.disabled = disabled;
  if (dom.composerActionsBtn) dom.composerActionsBtn.disabled = disabled;
  dom.imageBtn.disabled = disabled;
  if (dom.cameraBtn) dom.cameraBtn.disabled = disabled;

  if (pendingImageUI?.removeBtn) {
    pendingImageUI.removeBtn.disabled = disabled;
  }
}

function updateSendButtonState() {
  const canSend = Boolean(
    dom.userInput.value.trim() ||
    pendingImageFile ||
    state.lastAudioBlob
  );

  dom.sendBtn.classList.toggle('has-text', canSend);
}

function animateSendButton() {
  dom.sendBtn.classList.remove('is-sending');
  void dom.sendBtn.offsetWidth;
  dom.sendBtn.classList.add('is-sending');
  window.setTimeout(() => {
    dom.sendBtn.classList.remove('is-sending');
  }, 420);
}

function pulseParticles(type = 'send') {
  window.lipuParticles?.pulse?.(type);
}

function setParticlesThinking(active) {
  window.lipuParticles?.setThinking?.(active);
}

function setParticlesScanning(active) {
  window.lipuParticles?.setScanning?.(active);
}

export function showAudioHint(text) {
  const existing = document.querySelector('.audio-hint');

  if (existing) {
    existing.textContent = text;
    existing.classList.add('show');

    clearTimeout(existing._hideTimer);
    existing._hideTimer = setTimeout(() => {
      existing.classList.remove('show');
    }, 2500);

    return;
  }

  const hint = document.createElement('div');
  hint.className = 'audio-hint show';
  hint.textContent = text;
  document.body.appendChild(hint);

  hint._hideTimer = setTimeout(() => {
    hint.classList.remove('show');
  }, 2500);
}

async function transcribeWithWebSpeechAPI() {
  return new Promise((resolve, reject) => {
    if (!SpeechRecognition) {
      reject(new Error('Web Speech API non supportata'));
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'it-IT';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let finalTranscript = '';

    recognition.onresult = event => {
      finalTranscript = Array.from(event.results)
        .map(result => result[0]?.transcript || '')
        .join(' ')
        .trim();
    };

    recognition.onerror = event => {
      reject(new Error(event.error || 'Errore Web Speech API'));
    };

    recognition.onend = () => {
      if (finalTranscript) {
        resolve(finalTranscript);
      } else {
        reject(new Error('Trascrizione vuota'));
      }
    };

    recognition.start();
  });
}

async function transcribeAudioWithFallback(audioBlob) {
  const geminiTranscript = await transcribeAudioWithGemini(audioBlob);
  if (geminiTranscript) return geminiTranscript;

  try {
    if (SpeechRecognition) {
      showAudioHint('Trascrizione cloud non disponibile. Ripeti il messaggio.');
      return await transcribeWithWebSpeechAPI();
    }
  } catch (err) {
    console.warn('Fallback Web Speech fallito:', err);
  }

  return '';
}

async function speakAndRenderLIPU(text) {
  const safeText = normalizeString(text).trim();
  if (!safeText) return;

  if (state.lipuReplyMode === 'text') {
    removeLIPULoadingMessage();
    renderMessage('lipu', safeText);
    saveTextToMemory('lipu', safeText);
    return;
  }

  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/elevenlabs-tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: safeText
      })
    });

    const contentType = response.headers.get('content-type') || '';
    const audioBlob = await response.blob();

    console.log('ElevenLabs content-type:', contentType);
    console.log('ElevenLabs blob:', audioBlob.type, audioBlob.size);

    if (!response.ok) {
      const errText = await audioBlob.text().catch(() => '');
      throw new Error(errText || `HTTP ${response.status}`);
    }

    if (audioBlob.size === 0) {
      throw new Error('Blob audio vuoto');
    }

    const audioUrl = URL.createObjectURL(audioBlob);

    removeLIPULoadingMessage();
    setParticlesThinking(false);
    pulseParticles('reply');
    renderAudioMessage('lipu', audioUrl);
    saveTextToMemory('lipu', safeText);

    const lastAudio = dom.chatBox.querySelector('.message-row.lipu:last-child audio');

    if (!lastAudio) {
      throw new Error('Elemento audio non trovato');
    }

    lastAudio.addEventListener(
      'error',
      () => {
        console.error('Errore audio element:', lastAudio.error);
        showAudioHint('Formato audio non supportato');
      },
      { once: true }
    );

    requestAnimationFrame(() => {
      lastAudio.play().catch(playErr => {
        console.warn('Autoplay bloccato o sorgente invalida:', playErr);
        showAudioHint('Tocca play per ascoltare la risposta di LIPU');
      });
    });
  } catch (err) {
    removeLIPULoadingMessage();
    setParticlesThinking(false);
    console.error('Errore Audio LIPU:', err);
    showAudioHint(err?.message || 'Errore audio LIPU');
  }
}

async function deliverLIPUResponse(aiText) {
  const safeText = normalizeString(aiText).trim();
  if (!safeText) {
    setParticlesThinking(false);
    return;
  }

  if (state.lipuReplyMode === 'text') {
    removeLIPULoadingMessage();
    setParticlesThinking(false);
    pulseParticles('reply');
    renderMessage('lipu', safeText);
    saveTextToMemory('lipu', safeText);
    return;
  }

  await speakAndRenderLIPU(safeText);
}

function getReadableError(err) {
  if (!err) return 'Errore sconosciuto';

  if (typeof err === 'string') return err;

  if (err instanceof Error) {
    return err.message || err.name || 'Errore generico';
  }

  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return 'Oggetto errore non serializzabile';
    }
  }

  return String(err);
}

function updateSummariesIfNeeded() {
  state.summaryUpdateCounter = (state.summaryUpdateCounter || 0) + 1;

  if (state.summaryUpdateCounter === 12) {
    generatePinnedSummaryIfNeeded().catch(err => {
      console.warn('Pinned summary fallito:', err?.message || String(err));
    });
  }

  if (state.summaryUpdateCounter % 25 === 0) {
    generateSessionSummary().catch(err => {
      console.warn('Session summary fallito:', err?.message || String(err));
    });
  }

  if (state.summaryUpdateCounter % 80 === 0) {
    generateIntermediateSummary().catch(err => {
      console.warn('Intermediate summary fallito:', err?.message || String(err));
    });
  }
}

export async function handleTextMessage() {
  const text = dom.userInput.value.trim();
  const imageFile = pendingImageFile;

  if (!text && !imageFile) return;

  closeVirtualKeyboard();
  animateSendButton();
  pulseParticles('send');
  disableComposer(true);

  try {
    if (imageFile) {
      const faceAnalysisCompleted = await waitForFaceMatches(FACE_ANALYSIS_TIMEOUT_MS);

      if (!faceAnalysisCompleted) {
        pendingFaceAnalysisId += 1;
        pendingFaceAnalysisPromise = null;
        pendingFaceAnalysisFailed = true;
        pendingFaceLowConfidenceBlocked = false;
        setParticlesScanning(false);
        setFaceAnalysisStatus('');
      }

      if (pendingFaceLowConfidenceBlocked || hasUncertainKnownFaces()) {
        updatePendingImageRecognitionIndicator('unrecognized');
        return;
      }
    }

    const sendImageFile = imageFile ? await compressImageForSend(imageFile) : null;

    if (sendImageFile) {
      const imageDataUrl = await blobToDataURL(sendImageFile);
      renderImageTextMessage('user', imageDataUrl, text);
    } else if (text) {
      renderMessage('user', text);
    }

    dom.userInput.value = '';
    autoResizeUserInput();
    updateSendButtonState();

    renderLIPULoadingMessage(
      state.lipuReplyMode === 'text'
        ? 'Lipu sta scrivendo...'
        : 'Lipu sta registrando...'
    );
    setParticlesThinking(true);

    saveTextToMemory('user', text || 'Immagine inviata');

    let aiText = '';

    if (sendImageFile) {
      const HIGH_THRESHOLD = Number(
        (await loadKnownFacesData())?.thresholds?.known || KNOWN_FACE_MIN_SCORE
      );

      const recognized = (pendingFaceMatches || [])
        .map((m, i) => {
          const det = pendingFaceDetections[i];
          return {
            label: m.label,
            score: m.score,
            status: m.status,
            box: det?.box
          };
        })
        .filter(f =>
          f.label &&
          f.label !== 'Sconosciuto' &&
          f.status === 'known' &&
          passesRecognitionThreshold(f, HIGH_THRESHOLD)
        )
        .map(f => {
          const { preview } = getImagePreviewElements();
          const imgWidth = Number(pendingImageNaturalWidth || preview?.naturalWidth || 0);
          const imgHeight = Number(pendingImageNaturalHeight || preview?.naturalHeight || 0);

          const box = f.box || {};
          const x = Number(box.xMin || 0);
          const y = Number(box.yMin || 0);
          const width = Number(box.width || 0);
          const height = Number(box.height || 0);

          // 🧠 fallback se dimensioni non disponibili
          if (!imgWidth || !imgHeight) {
            return `${f.label}`;
          }

          // 🔥 posizione orizzontale (relativa)
          let horiz = '';
          const xCenter = x + width / 2;

          if (xCenter < imgWidth * 0.33) horiz = 'a sinistra';
          else if (xCenter < imgWidth * 0.66) horiz = 'al centro';
          else horiz = 'a destra';

          // 🔥 posizione verticale
          let vert = '';
          const yCenter = y + height / 2;

          if (yCenter < imgHeight * 0.33) vert = 'in alto';
          else if (yCenter < imgHeight * 0.66) vert = '';
          else vert = 'in basso';

          // 🔥 profondità (basata sulla dimensione del volto)
          let depth = '';
          const sizeRatio = width / imgWidth;

          if (sizeRatio > 0.35) depth = 'in primo piano';
          else if (sizeRatio > 0.18) depth = 'in secondo piano';
          else depth = 'sullo sfondo';

          // 🔥 composizione finale
          const parts = [depth, horiz, vert].filter(Boolean);
          const position = parts.join(' ');

          return `${f.label} (${position})`;
        });

      aiText = await analyzeImageWithAI(sendImageFile, recognized, text);
    } else {
      aiText = await getLIPUResponse(text);
    }

    await deliverLIPUResponse(aiText);
    updateSummariesIfNeeded();
    clearPendingImage();
  } catch (err) {
    removeLIPULoadingMessage();
    setParticlesThinking(false);
    console.error('Errore handleTextMessage:', err);
    showAudioHint(err?.message || 'Errore risposta testuale');
  } finally {
    disableComposer(false);
    updateSendButtonState();
    if (!isMobileViewport()) {
      dom.userInput.focus();
    } else {
      dom.userInput.blur();
    }
  }
}

export async function handleAudioMessage() {
  if (!state.lastAudioBlob) {
    showAudioHint('Nessun audio pronto da inviare');
    return;
  }

  disableComposer(true);
  pulseParticles('audio');

  try {
    const audioDataUrl = await blobToDataURL(state.lastAudioBlob);
    renderAudioMessage('user', audioDataUrl);

    dom.recordingStatus.textContent = 'Elaborazione...';

    const transcript = await transcribeAudioWithFallback(state.lastAudioBlob);

    if (!transcript || !transcript.trim()) {
      showAudioHint('Non ho capito, ripeti');
      return;
    }

    saveTextToMemory('user', transcript);

    renderLIPULoadingMessage(
      state.lipuReplyMode === 'text'
        ? 'Lipu sta scrivendo...'
        : 'Lipu sta registrando...'
    );
    setParticlesThinking(true);

    const aiText = await getLIPUResponse(transcript);

    if (!aiText || !aiText.trim()) {
      throw new Error('Risposta AI vuota');
    }

    await deliverLIPUResponse(aiText);
    updateSummariesIfNeeded();
    resetAudioComposerState();
  } catch (err) {
    removeLIPULoadingMessage();
    setParticlesThinking(false);
    console.error('Errore handleAudioMessage:', err);
    showAudioHint(err?.message || 'Errore invio audio');
  } finally {
    disableComposer(false);
  }
}

export async function handleImageMessage(file) {
  if (!file) return;

  try {
    console.log('[handleImageMessage] File ricevuto:', {
      name: file.name,
      type: file.type,
      size: file.size
    });

    await setPendingImage(file);
    showAudioHint('Immagine pronta. Ora puoi scrivere un messaggio e inviare tutto insieme.');
    if (!isMobileViewport()) {
      dom.userInput.focus();
    }
  } catch (err) {
    const readableError = getReadableError(err);
    console.error('[handleImageMessage] errore completo:', err);
    console.error('[handleImageMessage] errore leggibile:', readableError);
    showAudioHint(readableError || 'Errore selezione immagine');
  }
}

export function bindEvents() {
  updatePendingImageUI();
  clearFacePreviewUI();
  updateSendButtonState();
  syncMobileKeyboardMode();
  updateVirtualKeyboardLayout();
  updateVirtualKeyboardCase();

  window.addEventListener('resize', syncMobileKeyboardMode);
  window.addEventListener('orientationchange', syncMobileKeyboardMode);

  dom.composerActionsBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (dom.composerActionsBtn?.getAttribute('aria-expanded') !== 'true') {
      closeVirtualKeyboard();
    }
    toggleComposerActions();
  });

  document.addEventListener('click', e => {
    if (!dom.composerActions?.contains(e.target)) {
      closeComposerActions();
    }

    if (
      isVirtualKeyboardAvailable() &&
      !dom.virtualKeyboard.contains(e.target) &&
      !dom.userInput?.contains(e.target) &&
      !dom.composerCenter?.contains(e.target)
    ) {
      closeVirtualKeyboard();
    }

    if (!e.target.closest('.vk-accent-popover')) {
      closeVirtualKeyboardAccents();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeComposerActions();
    }
  });

  dom.recordBtn.addEventListener('click', async () => {
    closeComposerActions();
    if (!state.isRecording) {
      await startRecording();
    } else {
      await stopRecording();
    }
  });

  dom.sendBtn.addEventListener('click', async () => {
    if (state.isRecording) {
      await stopRecording();
      await handleAudioMessage();
    } else if (pendingImageFile || dom.userInput.value.trim()) {
      await handleTextMessage();
    } else if (state.lastAudioBlob) {
      await handleAudioMessage();
    } else {
      await handleTextMessage();
    }
  });

  dom.userInput.addEventListener('keydown', async e => {
    if (isVirtualKeyboardAvailable()) {
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      await handleTextMessage();
    }
  });

  dom.userInput.addEventListener('pointerdown', e => {
    if (!isVirtualKeyboardAvailable()) return;
    openVirtualKeyboard();
  });

  dom.userInput.addEventListener('click', () => {
    if (!isVirtualKeyboardAvailable()) return;
    syncVirtualKeyboardAutoShift();
  });

  dom.userInput.addEventListener('select', () => {
    if (!isVirtualKeyboardAvailable()) return;
    syncVirtualKeyboardAutoShift();
  });

  dom.composerCenter?.addEventListener('click', e => {
    if (!isVirtualKeyboardAvailable()) return;
    if (e.target.closest('button')) return;
    openVirtualKeyboard();
  });

  dom.userInput.addEventListener('focus', () => {
    if (!isVirtualKeyboardAvailable()) return;
    openVirtualKeyboard();
  });

  dom.userInput.addEventListener('input', updateSendButtonState);
  dom.userInput.addEventListener('input', autoResizeUserInput);

  dom.virtualKeyboard?.addEventListener('pointerdown', e => {
    e.preventDefault();
    startVirtualKeyboardDrag(e);
    const button = e.target.closest('button');
    if (button) {
      registerVirtualKeyboardTap(e);
      pulseVirtualKeyboardButton(button);
      beginVirtualKeyboardAccent(button);
    }
  });

  dom.virtualKeyboard?.addEventListener('pointermove', e => {
    moveVirtualKeyboardDrag(e);
  });

  dom.virtualKeyboard?.addEventListener('pointerup', e => {
    cancelVirtualKeyboardAccentTimer();
    endVirtualKeyboardDrag(e);
  });

  dom.virtualKeyboard?.addEventListener('pointercancel', e => {
    cancelVirtualKeyboardAccentTimer();
    endVirtualKeyboardDrag(e);
  });

  dom.virtualKeyboard?.addEventListener('click', async e => {
    const button = e.target.closest('button');
    if (!button) return;
    if (wasVirtualKeyboardTapDragged(e)) return;

    if (virtualKeyboardSuppressClick) {
      virtualKeyboardSuppressClick = false;
      return;
    }

    const action = button.dataset.action || '';
    const key = button.dataset.key || '';

    if (action) {
      await handleVirtualKeyboardAction(action);
      return;
    }

    if (key) {
      appendToInput(virtualKeyboardShift ? key.toUpperCase() : key.toLowerCase());
      if (virtualKeyboardShift) {
        virtualKeyboardShift = false;
        dom.virtualKeyboard?.classList.remove('has-shift');
        updateVirtualKeyboardCase();
      }
    }
  });

  dom.imageBtn?.addEventListener('click', () => {
    closeComposerActions();
    openFilePicker(dom.imageInput, { capture: false });
  });

  dom.imageInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    await handleImageMessage(file);
    dom.imageInput.value = '';
  });

  dom.cameraBtn?.addEventListener('click', e => {
    e.preventDefault();
    closeComposerActions();
    openFilePicker(dom.cameraInput, { capture: isMobileViewport() });
  });

  // 📷 Camera capture → same pipeline as image
  dom.cameraInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    await handleImageMessage(file);

    // reset per riutilizzo
    dom.cameraInput.value = '';
  });
}
