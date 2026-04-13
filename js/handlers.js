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

let faceDetectors = {
  short: null,
  full: null
};
let faceDetectorPromises = {
  short: null,
  full: null
};
let pendingFaceDetections = [];
let pendingFaceAnalysisId = 0;

function getImagePreviewElements() {
  return {
    container: document.getElementById('image-preview-container'),
    preview: document.getElementById('image-preview'),
    badge: document.getElementById('face-count-badge'),
    crops: document.getElementById('face-crops')
  };
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

async function ensureFaceDetector(modelType = 'full') {
  const safeModelType = modelType === 'short' ? 'short' : 'full';

  if (faceDetectors[safeModelType]) {
    return faceDetectors[safeModelType];
  }

  if (faceDetectorPromises[safeModelType]) {
    return faceDetectorPromises[safeModelType];
  }

  const faceDetectionLib = window.faceDetection;
  const tfLib = window.tf;

  if (!faceDetectionLib || !tfLib) {
    throw new Error('Face Detection non disponibile');
  }

  faceDetectorPromises[safeModelType] = faceDetectionLib
    .createDetector(faceDetectionLib.SupportedModels.MediaPipeFaceDetector, {
      runtime: 'tfjs',
      maxFaces: 10,
      modelType: safeModelType
    })
    .then(detector => {
      faceDetectors[safeModelType] = detector;
      return detector;
    })
    .catch(err => {
      faceDetectors[safeModelType] = null;
      throw err;
    })
    .finally(() => {
      faceDetectorPromises[safeModelType] = null;
    });

  return faceDetectorPromises[safeModelType];
}

function clearFacePreviewUI() {
  const { container, preview, badge, crops } = getImagePreviewElements();

  pendingFaceDetections = [];
  pendingFaceAnalysisId += 1;

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

function updateFaceCountBadge(count) {
  const { badge } = getImagePreviewElements();
  if (!badge) return;

  if (!count) {
    badge.textContent = '';
    badge.classList.add('hidden');
    return;
  }

  badge.textContent = count === 1 ? '1 volto' : `${count} volti`;
  badge.classList.remove('hidden');
}


function buildDetectionCanvasFromImage(imageElement) {
  if (!imageElement || !imageElement.naturalWidth || !imageElement.naturalHeight) {
    return null;
  }

  const maxSide = 960;
  const naturalWidth = imageElement.naturalWidth;
  const naturalHeight = imageElement.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(naturalWidth, naturalHeight));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);

  return {
    canvas,
    scaleX: naturalWidth / canvas.width,
    scaleY: naturalHeight / canvas.height
  };
}

function normalizeDetectionBox(detection, scaleX = 1, scaleY = 1) {
  const box = detection?.box || detection?.boundingBox;
  if (!box) return null;

  const xMin = Number(box.xMin ?? 0) * scaleX;
  const yMin = Number(box.yMin ?? 0) * scaleY;
  const width = Number(box.width ?? 0) * scaleX;
  const height = Number(box.height ?? 0) * scaleY;

  if (![xMin, yMin, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width < 28 || height < 28) return null;

  const aspectRatio = width / height;
  if (aspectRatio < 0.55 || aspectRatio > 1.8) return null;

  return {
    ...detection,
    box: {
      xMin,
      yMin,
      width,
      height
    }
  };
}

async function detectFacesWithFallback(source) {
  const fullDetector = await ensureFaceDetector('full');
  let detections = await fullDetector.estimateFaces(source, { flipHorizontal: false });

  if (!Array.isArray(detections)) {
    detections = [];
  }

  if (!detections.length) {
    const shortDetector = await ensureFaceDetector('short');
    const fallbackDetections = await shortDetector.estimateFaces(source, { flipHorizontal: false });
    detections = Array.isArray(fallbackDetections) ? fallbackDetections : [];
  }

  return detections;
}

function renderFaceCrops(sourceImage, detections = []) {
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

    const label = document.createElement('span');
    label.className = 'face-crop-label';
    label.textContent = `#${index + 1}`;
    label.style.fontSize = '11px';
    label.style.color = 'rgba(255,255,255,0.68)';

    cropWrap.appendChild(cropImg);
    cropWrap.appendChild(label);
    crops.appendChild(cropWrap);
  });
}

async function analyzePendingImageFaces(previewUrl) {
  const analysisId = ++pendingFaceAnalysisId;
  const { container, preview, badge, crops } = getImagePreviewElements();
  if (!container || !preview || !badge || !crops || !previewUrl) return;

  container.classList.remove('hidden');
  preview.src = previewUrl;
  badge.textContent = 'analisi...';
  badge.classList.remove('hidden');
  crops.innerHTML = '';

  try {
    if (!isCurrentPendingPreview(previewUrl)) return;

    if (!preview.complete) {
      await preview.decode().catch(() => undefined);
    }

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    const detectionSource = buildDetectionCanvasFromImage(preview);
    if (!detectionSource?.canvas) {
      throw new Error('Immagine preview non pronta per face detection');
    }

    const rawDetections = await detectFacesWithFallback(detectionSource.canvas);

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = rawDetections
      .map(detection => normalizeDetectionBox(detection, detectionSource.scaleX, detectionSource.scaleY))
      .filter(Boolean)
      .sort((a, b) => {
        const areaA = (a?.box?.width || 0) * (a?.box?.height || 0);
        const areaB = (b?.box?.width || 0) * (b?.box?.height || 0);
        return areaB - areaA;
      });

    updateFaceCountBadge(pendingFaceDetections.length);
    renderFaceCrops(preview, pendingFaceDetections);
  } catch (err) {
    console.error('Errore analyzePendingImageFaces:', err);

    if (!isCurrentPendingPreview(previewUrl) || analysisId !== pendingFaceAnalysisId) return;

    pendingFaceDetections = [];
    badge.textContent = '';
    badge.classList.add('hidden');
    crops.innerHTML = '';
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
    analyzePendingImageFaces(pendingImagePreviewUrl).catch(err => {
      console.error('Errore preview face detection:', err);
    });
  } else {
    ui.preview.removeAttribute('src');
    ui.label.textContent = 'Immagine';
    ui.wrap.style.display = 'none';
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

function clearPendingImage() {
  if (pendingImagePreviewUrl) {
    URL.revokeObjectURL(pendingImagePreviewUrl);
  }

  pendingImageFile = null;
  pendingImagePreviewUrl = '';
  clearFacePreviewUI();
  updatePendingImageUI();
}

async function buildImagePrompt(file, userText = '') {
  const rawExtractedText = await extractTextFromImageWithGemini(file);
  const extractedText = normalizeExtractedImageText(rawExtractedText);
  console.log('[buildImagePrompt] extractedText:', extractedText);

  const imageContext = await extractImageContextWithGemini(file);
  console.log('[buildImagePrompt] imageContext:', imageContext);

  return `
L'utente ha inviato un'immagine${userText ? ' accompagnata da un messaggio' : ''}.

Messaggio dell'utente:
${userText || 'nessun testo scritto'}

Testo estratto dall'immagine:
${extractedText || 'nessun testo rilevante'}

Contesto visivo dell'immagine:
- scena: ${imageContext?.scene || 'non definita'}
- tipo/contesto: ${imageContext?.context || 'non definito'}
- tono visivo: ${imageContext?.mood || 'non definito'}
- testo visibile sintetico: ${imageContext?.visibleText || 'nessuno'}
- volti rilevati in preview: ${pendingFaceDetections.length || 0}

Regole:
- considera sia il testo visibile sia il contenuto visivo generale
- se non c'è testo, reagisci comunque all'immagine
- non inventare dettagli troppo specifici
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

  if (pendingImageUI?.removeBtn) {
    pendingImageUI.removeBtn.disabled = disabled;
  }
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

    try {
      await lastAudio.play();
    } catch (playErr) {
      console.warn('Autoplay bloccato o sorgente invalida:', playErr);
      showAudioHint('Tocca play per ascoltare la risposta di LIPU');
    }
  } catch (err) {
    removeLIPULoadingMessage();
    console.error('Errore Audio LIPU:', err);
    showAudioHint(err?.message || 'Errore audio LIPU');
  }
}

async function deliverLIPUResponse(aiText) {
  const safeText = normalizeString(aiText).trim();
  if (!safeText) return;

  removeLIPULoadingMessage();

  if (state.lipuReplyMode === 'text') {
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

  disableComposer(true);

  try {
    if (text) {
      renderMessage('user', text);
    }

    if (imageFile) {
      const imageDataUrl = await blobToDataURL(imageFile);
      renderImageMessage('user', imageDataUrl);
    }

    dom.userInput.value = '';

    renderLIPULoadingMessage(
      state.lipuReplyMode === 'text'
        ? 'Lipu sta scrivendo...'
        : 'Lipu sta registrando...'
    );

    let userPrompt = text;

    if (imageFile) {
      userPrompt = await buildImagePrompt(imageFile, text);
    }

    saveTextToMemory('user', text || 'Immagine inviata');

    const aiText = await getLIPUResponse(userPrompt || text);
    await deliverLIPUResponse(aiText);
    updateSummariesIfNeeded();
    clearPendingImage();
  } catch (err) {
    removeLIPULoadingMessage();
    console.error('Errore handleTextMessage:', err);
    showAudioHint(err?.message || 'Errore risposta testuale');
  } finally {
    disableComposer(false);
    dom.userInput.focus();
  }
}

export async function handleAudioMessage() {
  if (!state.lastAudioBlob) {
    showAudioHint('Nessun audio pronto da inviare');
    return;
  }

  disableComposer(true);

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

    const aiText = await getLIPUResponse(transcript);

    if (!aiText || !aiText.trim()) {
      throw new Error('Risposta AI vuota');
    }

    await deliverLIPUResponse(aiText);
    updateSummariesIfNeeded();
    resetAudioComposerState();
  } catch (err) {
    removeLIPULoadingMessage();
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

  dom.imageBtn?.addEventListener('click', () => {
    dom.imageInput.click();
  });

  dom.imageInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    await handleImageMessage(file);
    dom.imageInput.value = '';
  });
}