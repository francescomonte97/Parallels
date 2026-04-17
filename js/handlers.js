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
  MAX_CONVERSATION_HISTORY_MESSAGES
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
  renderImageMessage,
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
let pendingImageUI = null;

let pendingFaceDetections = [];
let pendingFaceAnalysisId = 0;

const KNOWN_FACES_JSON_PATH = './js/known-faces.json';
const FACE_API_MODELS_PATH = './models';
const LIPU_SELF_MIN_SCORE = 0.96;
const KNOWN_FACE_MIN_SCORE = 0.94;
const IMAGE_SEND_MAX_DIMENSION = 1600;
const IMAGE_SEND_JPEG_QUALITY = 0.82;
const FACE_ANALYSIS_TIMEOUT_MS = 2800;

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

function getFaceDetectorInputSize() {
  return isMobileViewport() ? 320 : 512;
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



function ensureKnownFacesShape(data) {
  if (!data || typeof data !== 'object') {
    return {
      version: 2,
      engine: 'face-api.js',
      descriptorLength: 128,
      metric: 'cosine',
      thresholds: {
        known: KNOWN_FACE_MIN_SCORE,
        uncertain: 0.32,
        minMarginKnown: 0.03,
        minMarginUncertain: 0.015
      },
      people: []
    };
  }

  return {
    version: Number(data.version) || 2,
    engine: String(data.engine || 'face-api.js'),
    descriptorLength: Number(data.descriptorLength) || 128,
    metric: String(data.metric || 'cosine'),
    thresholds: {
      known: Number(data?.thresholds?.known) || KNOWN_FACE_MIN_SCORE,
      uncertain: Number(data?.thresholds?.uncertain) || 0.32,
      minMarginKnown: Number(data?.thresholds?.minMarginKnown) || 0.03,
      minMarginUncertain: Number(data?.thresholds?.minMarginUncertain) || 0.015
    },
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


async function generateEmbeddingFromCanvas(faceCanvas) {
  const faceapi = window.faceapi;
  if (!faceapi) {
    throw new Error('face-api.js non disponibile nel browser');
  }

  await ensureFaceApiModels();

  const result = await faceapi
    .detectSingleFace(
      faceCanvas,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 224,
        scoreThreshold: 0.3
      })
    )
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!result?.descriptor) {
    return [];
  }

  return normalizeEmbeddingVector(Array.from(result.descriptor));
}


function classifyMatch(score, thresholds, margin = 0) {
  const knownThreshold = Number(thresholds?.known) || KNOWN_FACE_MIN_SCORE;
  const uncertainThreshold = Number(thresholds?.uncertain) || 0.32;
  const minMarginKnown = Number(thresholds?.minMarginKnown) || 0.03;
  const minMarginUncertain = Number(thresholds?.minMarginUncertain) || 0.015;

  if (score >= knownThreshold && margin >= minMarginKnown) return 'known';
  if (score >= uncertainThreshold && margin >= minMarginUncertain) return 'uncertain';
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
  const status = best ? classifyMatch(best.score, thresholds, margin) : 'unknown';

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
  setParticlesScanning(false);

  if (preview) {
    preview.removeAttribute('src');
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

async function analyzePendingImageFaces(previewUrl) {
  const analysisId = ++pendingFaceAnalysisId;
  const { container, preview, badge, crops } = getImagePreviewElements();
  if (!container || !preview || !badge || !crops || !previewUrl) return;

  container.classList.remove('hidden');
  preview.src = previewUrl;
  setFaceAnalysisStatus('Analisi volto...');
  setParticlesScanning(true);
  crops.innerHTML = '';
  pendingFaceAnalysisFailed = false;

  try {
    if (!isCurrentPendingPreview(previewUrl)) return;

    if (!preview.complete) {
      await preview.decode().catch(() => undefined);
    }

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    const faceapi = window.faceapi;
    if (!faceapi) {
      throw new Error('face-api.js non disponibile nel browser');
    }

    await ensureFaceApiModels();

    const results = await faceapi
      .detectAllFaces(
        preview,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: getFaceDetectorInputSize(),
          scoreThreshold: 0.25
        })
      )
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = (Array.isArray(results) ? results : [])
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
      });

      console.warn('[DEBUG] face-detect-count:', pendingFaceDetections.length);

console.warn(
  '[DEBUG] face-detect-descriptors:',
  pendingFaceDetections.map((d, i) => ({
    index: i,
    hasDescriptor: Array.isArray(d?.descriptor) && d.descriptor.length > 0,
    descriptorLength: Array.isArray(d?.descriptor) ? d.descriptor.length : 0
  }))
);

    const matches = [];

    for (const detection of pendingFaceDetections) {
      let embedding = normalizeEmbeddingVector(detection?.descriptor || []);

console.warn('[DEBUG] before-match', {
  embeddingLength: embedding.length,
  hasDescriptor: Array.isArray(detection?.descriptor) && detection.descriptor.length > 0
});

      if (!embedding.length) {
        const faceCanvas = cropFaceDetectionToCanvas(preview, detection);
        if (faceCanvas) {
          embedding = await generateEmbeddingFromCanvas(faceCanvas);
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

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceMatches = matches;
    pendingFaceLowConfidenceBlocked = hasUncertainKnownFaces();
    pendingFaceAnalysisFailed = false;
    updateFaceCountBadge(pendingFaceDetections.length);
    renderFaceCrops(preview, pendingFaceDetections, matches);

    if (
      pendingFaceLowConfidenceBlocked &&
      pendingFaceLowConfidenceAlertedAnalysisId !== analysisId
    ) {
      pendingFaceLowConfidenceAlertedAnalysisId = analysisId;
      window.alert('Foto non inviata: volto non confermato.');
    }
  } catch (err) {
    console.error('Errore analyzePendingImageFaces:', err);

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = [];
    pendingFaceMatches = [];
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceAnalysisFailed = true;
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
  wrap.style.gap = '8px';
  wrap.style.paddingRight = '10px';
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
  label.textContent = 'Immagine';
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

  removeBtn.addEventListener('click', () => {
    clearPendingImage();
    dom.userInput?.focus();
  });

  wrap.appendChild(preview);
  wrap.appendChild(label);
  wrap.appendChild(removeBtn);
  composerCenter.insertBefore(wrap, dom.userInput);

  pendingImageUI = {
    wrap,
    preview,
    label,
    removeBtn
  };

  return pendingImageUI;
}

function updatePendingImageUI() {
  const ui = ensurePendingImageUI();
  if (!ui) return;

  if (pendingImageFile && pendingImagePreviewUrl) {
    ui.preview.src = pendingImagePreviewUrl;
    ui.label.textContent = pendingImageFile.name || 'Immagine';
    ui.wrap.style.display = 'inline-flex';
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceLowConfidenceAlertedAnalysisId = 0;
    pendingFaceAnalysisPromise = analyzePendingImageFaces(pendingImagePreviewUrl).catch(err => {
      console.error('Errore preview face detection:', err);
    });
  } else {
    ui.preview.removeAttribute('src');
    ui.label.textContent = 'Immagine';
    ui.wrap.style.display = 'none';
    pendingFaceAnalysisPromise = null;
    pendingFaceLowConfidenceBlocked = false;
    pendingFaceLowConfidenceAlertedAnalysisId = 0;
    clearFacePreviewUI();
  }
}

function setPendingImage(file) {
  if (!file) return;

  if (pendingImagePreviewUrl) {
    URL.revokeObjectURL(pendingImagePreviewUrl);
  }

  pendingImageFile = file;
  pendingImagePreviewUrl = URL.createObjectURL(file);
  updatePendingImageUI();
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

async function compressImageForSend(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return file;
  if (String(file.type || '').toLowerCase() === 'image/gif') return file;

  try {
    const image = await loadImageElementFromBlob(file);
    const width = Number(image.naturalWidth || image.width || 0);
    const height = Number(image.naturalHeight || image.height || 0);

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

    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', IMAGE_SEND_JPEG_QUALITY);
    });

    if (!blob) return file;

    return new File(
      [blob],
      String(file.name || 'immagine').replace(/\.[^.]+$/, '') + '.jpg',
      { type: 'image/jpeg', lastModified: Date.now() }
    );
  } catch (err) {
    console.warn('Compressione immagine fallita, uso originale:', err);
    return file;
  }
}

function clearPendingImage() {
  if (pendingImagePreviewUrl) {
    URL.revokeObjectURL(pendingImagePreviewUrl);
  }

  pendingImageFile = null;
  pendingImagePreviewUrl = '';
  pendingFaceAnalysisPromise = null;
  pendingFaceLowConfidenceBlocked = false;
  pendingFaceLowConfidenceAlertedAnalysisId = 0;
  pendingFaceAnalysisFailed = false;
  setParticlesScanning(false);
  clearFacePreviewUI();
  updatePendingImageUI();
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

function saveTextToMemory(role, content) {
  const safeContent = normalizeString(content).trim();
  if (!safeContent) return;

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
  dom.sendBtn.disabled = disabled;
  dom.recordBtn.disabled = disabled;
  dom.userInput.disabled = disabled;
  dom.imageBtn.disabled = disabled;
  if (dom.cameraBtn) dom.cameraBtn.disabled = disabled;

  if (pendingImageUI?.removeBtn) {
    pendingImageUI.removeBtn.disabled = disabled;
  }
}

function updateSendButtonState() {
  const hasText = Boolean(dom.userInput.value.trim());
  dom.sendBtn.classList.toggle('has-text', hasText);
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

  animateSendButton();
  pulseParticles(imageFile ? 'audio' : 'send');
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
        if (!pendingFaceLowConfidenceAlertedAnalysisId) {
          window.alert('Foto non inviata: volto non confermato.');
        }
        return;
      }
    }

    const sendImageFile = imageFile ? await compressImageForSend(imageFile) : null;

    if (text) {
      renderMessage('user', text);
    }

    if (sendImageFile) {
      const imageDataUrl = await blobToDataURL(sendImageFile);
      renderImageMessage('user', imageDataUrl);
    }

    dom.userInput.value = '';
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
          const imgWidth = Number(preview?.naturalWidth || 0);
          const imgHeight = Number(preview?.naturalHeight || 0);

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
    dom.userInput.focus();
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

    setPendingImage(file);
    showAudioHint('Immagine pronta. Ora puoi scrivere un messaggio e inviare tutto insieme.');
    dom.userInput.focus();
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

  dom.recordBtn.addEventListener('click', async () => {
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
    } else if (state.lastAudioBlob) {
      await handleAudioMessage();
    } else {
      await handleTextMessage();
    }
  });

  dom.userInput.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await handleTextMessage();
    }
  });

  dom.userInput.addEventListener('input', updateSendButtonState);

  dom.imageBtn?.addEventListener('click', () => {
    dom.imageInput.click();
  });

  dom.imageInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    await handleImageMessage(file);
    dom.imageInput.value = '';
  });

dom.cameraBtn?.addEventListener('click', (e) => {
  e.preventDefault();

  if (dom.cameraInput) {
    if (isMobileViewport()) {
      dom.cameraInput.setAttribute('capture', 'environment');
    } else {
      dom.cameraInput.removeAttribute('capture');
    }
    dom.cameraInput.click();
  }
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
