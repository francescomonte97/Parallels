import { dom } from './dom.js';
import {
  ELEVENLABS_API_KEY,
  VOICE_ID,
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
  generateSessionSummary,
  generateIntermediateSummary,
  generatePinnedSummaryIfNeeded,
  maybeGenerateLIPUSelfie
} from './services.js';
import {
  startRecording,
  stopRecording,
  resetAudioComposerState
} from './recorder.js';

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
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: safeText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
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

async function maybeSendLIPUSelfie(sceneText, aiText) {
  try {
    const imageUrl = await maybeGenerateLIPUSelfie(sceneText, aiText);
    if (!imageUrl) return;

    renderImageMessage('lipu', imageUrl);
  } catch (err) {
    console.warn('Errore selfie LIPU:', err);
  }
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
  if (!text) return;

  renderMessage('user', text);
  saveTextToMemory('user', text);
  dom.userInput.value = '';

  disableComposer(true);

  try {
    renderLIPULoadingMessage(
      state.lipuReplyMode === 'text'
        ? 'Lipu sta scrivendo...'
        : 'Lipu sta registrando...'
    );

    const aiText = await getLIPUResponse(text);
    await deliverLIPUResponse(aiText);
    await maybeSendLIPUSelfie(text, aiText);
    updateSummariesIfNeeded();
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
    await maybeSendLIPUSelfie(transcript, aiText);
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

  disableComposer(true);

  try {
    console.log('[handleImageMessage] File ricevuto:', {
      name: file.name,
      type: file.type,
      size: file.size
    });

    const imageDataUrl = await blobToDataURL(file);
    console.log('[handleImageMessage] imageDataUrl creato');

    renderImageMessage('user', imageDataUrl);
    console.log('[handleImageMessage] immagine renderizzata');

    dom.recordingStatus.textContent = 'Analisi immagine...';

    const extractedText = await extractTextFromImageWithGemini(file);
    console.log('[handleImageMessage] extractedText:', extractedText);

    if (!extractedText || !extractedText.trim()) {
      throw new Error('Nessun testo estratto dall’immagine');
    }

    saveTextToMemory('user', extractedText);

    renderLIPULoadingMessage(
      state.lipuReplyMode === 'text'
        ? 'Lipu sta scrivendo...'
        : 'Lipu sta registrando...'
    );

    const aiText = await getLIPUResponse(extractedText);
    console.log('[handleImageMessage] aiText:', aiText);

    if (!aiText || !aiText.trim()) {
      throw new Error('Risposta AI vuota dopo analisi immagine');
    }

    await deliverLIPUResponse(aiText);
    await maybeSendLIPUSelfie(extractedText, aiText);
    updateSummariesIfNeeded();

    dom.recordingStatus.textContent = 'Registrazione...';
    dom.recordingTime.textContent = '00:00';
  } catch (err) {
    removeLIPULoadingMessage();

    const readableError = getReadableError(err);

    console.error('[handleImageMessage] errore completo:', err);
    console.error('[handleImageMessage] errore leggibile:', readableError);

    showAudioHint(readableError || 'Errore analisi immagine');
  } finally {
    disableComposer(false);
    dom.userInput.focus();
  }
}

export function bindEvents() {
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