import {
  WORKER_BASE_URL,
  CLAUDE_MAIN_MODEL,
  CLAUDE_SUMMARY_MODEL,
  CLAUDE_MAIN_TEMPERATURE,
  CLAUDE_SUMMARY_TEMPERATURE,
  CLAUDE_FAST_MODEL,
  CLAUDE_FAST_TEMPERATURE,
  STORAGE_KEYS
} from './config.js';
import {
  state,
  getActiveUserProfile,
  saveSessionSummary,
  getSessionSummary,
  savePinnedSummary,
  getPinnedSummary,
  saveIntermediateSummary,
  getIntermediateSummary
} from './state.js';
import { normalizeString, safeParseJSON, blobToBase64 } from './utils.js';
import { buildEnvironmentalContext } from './context.js';
import { applyRelationshipTheme } from './theme.js';

export async function loadLongTermMemory() {
  try {
    const response = await fetch('./lipu-memory.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.longTermMemory = await response.json();
  } catch {
    state.longTermMemory = null;
  }
}

export function getRelationshipState() {
  return JSON.parse(
    localStorage.getItem('lipu_relationship_state') ||
      JSON.stringify({
        familiarity: 0,
        trust: 0,
        provocation: 0,
        intimacy: 0,
        tension: 0,
        dependence: 0
      })
  );
}

function saveRelationshipState(value) {
  localStorage.setItem('lipu_relationship_state', JSON.stringify(value));
}

function getReadableError(err) {
  if (!err) return 'Errore sconosciuto';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Errore generico';

  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return 'Oggetto errore non serializzabile';
    }
  }

  return String(err);
}

function shouldUseFastModel(userMsg = '') {
  const text = normalizeString(userMsg).trim();
  const lower = text.toLowerCase();

  if (!text) return true;

  const isShort = text.length <= 140;
  const hasMultipleClauses = /[,;:\n]/.test(text) || text.split(/[.?!]/).filter(Boolean).length >= 2;
  const isEmotionalOrAmbiguous = /(perche|perché|secondo te|cosa ne pensi|racconta|raccontami|spiegami|aiutami|mi sento|relazione|litig|gelos|ansia|paura|triste|confus|problema|situazione|consiglio|che dovrei)/.test(lower);

  return isShort && !hasMultipleClauses && !isEmotionalOrAmbiguous;
}

function resolveMainResponseModel(userMsg = '') {
  if (shouldUseFastModel(userMsg)) {
    return {
      model: CLAUDE_FAST_MODEL,
      temperature: CLAUDE_FAST_TEMPERATURE
    };
  }

  return {
    model: CLAUDE_MAIN_MODEL,
    temperature: CLAUDE_MAIN_TEMPERATURE
  };
}

function clampText(text = '', max = 300) {
  return String(text || '').trim().slice(0, max);
}

function readLocalJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeKeywordList(text = '') {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(item => item.length > 2);
}

function buildCompactTranscript(messages = [], maxMessages = 12, maxCharsPerLine = 140) {
  return messages
    .filter(msg => msg.type === 'text' && msg.content)
    .slice(-maxMessages)
    .map(msg => {
      const role = msg.role === 'user' ? 'Utente' : 'LIPU';
      return `${role}: ${clampText(msg.content, maxCharsPerLine)}`;
    })
    .join('\n')
    .slice(0, 1800);
}

async function postJSON(url, body) {
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('Fetch fallita verso:', url, getReadableError(err));
    throw new Error(`Impossibile contattare il server: ${url}`);
  }

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }

  return data;
}

function applyDecay(stateValue, decay = 0.92) {
  return {
    familiarity: stateValue.familiarity * decay,
    trust: stateValue.trust * decay,
    provocation: stateValue.provocation * decay,
    intimacy: stateValue.intimacy * decay,
    tension: stateValue.tension * decay,
    dependence: stateValue.dependence * decay
  };
}

function boostRelevantDimensions(stateValue, aiState, factor = 0.35, threshold = 2.5) {
  const next = { ...stateValue };

  for (const key of Object.keys(next)) {
    const value = Number(aiState?.[key] || 0);
    if (value >= threshold) {
      next[key] += value * factor;
    }
  }

  return next;
}

function rebalanceRelationshipState(stateValue) {
  const next = { ...stateValue };

  if (next.provocation > 5) {
    next.intimacy *= 0.88;
    next.trust *= 0.93;
  }

  if (next.intimacy > 5) {
    next.provocation *= 0.9;
    next.tension *= 0.94;
  }

  if (next.trust > 6) {
    next.tension *= 0.9;
  }

  if (next.dependence > 5) {
    next.trust *= 1.05;
  }

  return next;
}

function normalizeRelationshipState(stateValue) {
  const next = {};

  for (const key of Object.keys(stateValue)) {
    next[key] = Math.max(0, Math.min(10, Number(stateValue[key].toFixed(2))));
  }

  return next;
}

async function analyzeUserRelationalState(userMsg) {
  try {
    const systemText = `
Analizza il messaggio dell’utente e restituisci SOLO un JSON valido con valori 0-10 per:
- familiarity
- trust
- provocation
- intimacy
- tension
- dependence

Solo JSON.
Messaggio:
"${normalizeString(userMsg)}"
`.trim();

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg: normalizeString(userMsg),
      systemText,
      model: CLAUDE_SUMMARY_MODEL,
      temperature: 0.2,
      max_tokens: 120
    });

    const parsed = safeParseJSON(data?.text || '');
    if (!parsed) return null;

    return {
      familiarity: Number(parsed.familiarity) || 0,
      trust: Number(parsed.trust) || 0,
      provocation: Number(parsed.provocation) || 0,
      intimacy: Number(parsed.intimacy) || 0,
      tension: Number(parsed.tension) || 0,
      dependence: Number(parsed.dependence) || 0
    };
  } catch (err) {
    console.error('Errore analyzeUserRelationalState:', getReadableError(err));
    return null;
  }
}

function getTopRelationshipDimensions(stateValue, topN = 2) {
  return Object.entries(stateValue)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
}

function getRelationshipInstructions(stateValue) {
  const top = getTopRelationshipDimensions(stateValue, 2);
  const rules = [];

  for (const [key, value] of top) {
    if (key === 'familiarity' && value >= 8) {
      rules.push('Con l’utente c’è familiarità: puoi essere più diretto e naturale.');
    }
    if (key === 'trust' && value >= 8) {
      rules.push('L’utente si sta aprendo: rispondi con maggiore precisione emotiva.');
    }
    if (key === 'provocation' && value >= 8) {
      rules.push('L’utente tende a provocarti: non essere accomodante.');
    }
    if (key === 'intimacy' && value >= 8) {
      rules.push('C’è una sfumatura più intima o ambigua: puoi essere più magnetico.');
    }
    if (key === 'dependence' && value >= 8) {
      rules.push('L’utente tende a delegarti decisioni: puoi assumere più guida.');
    }
    if (key === 'tension' && value >= 8) {
      rules.push('La conversazione ha tensione percepibile: mantieni controllo e intensità.');
    }
  }

  return rules.join('\n');
}

function getRecentLIPUResponses(limit = 2) {
  return state.workingMemory
    .filter(msg => msg.role === 'lipu' && msg.type === 'text' && msg.content)
    .slice(-limit)
    .map(msg => String(msg.content).trim())
    .filter(Boolean);
}

function getFirstConversationMessagesForPinnedSummary(limit = 10) {
  return state.conversationHistory
    .filter(msg => msg.type === 'text' && msg.content)
    .slice(0, limit);
}

function getMessagesAfterTimestamp(timestamp = 0, limit = 12) {
  return state.conversationHistory
    .filter(msg => {
      return (
        msg.type === 'text' &&
        msg.content &&
        Number(msg.timestamp || 0) > Number(timestamp || 0)
      );
    })
    .slice(-limit);
}

function getMessagesAfterIntermediateTimestamp(timestamp = 0, limit = 18) {
  return state.conversationHistory
    .filter(msg => {
      return (
        msg.type === 'text' &&
        msg.content &&
        Number(msg.timestamp || 0) > Number(timestamp || 0)
      );
    })
    .slice(-limit);
}

export async function generatePinnedSummaryIfNeeded() {
  try {
    const existing = getPinnedSummary();
    if (existing?.summary && existing?.profileId === state.activeUserProfileId) {
      return existing;
    }

    const firstMessages = getFirstConversationMessagesForPinnedSummary(10);
    if (firstMessages.length < 8) return null;

    const transcript = buildCompactTranscript(firstMessages, 10, 120);

    const systemText = `
Restituisci SOLO un JSON valido:

{
  "summary": "ancora iniziale stabile della conversazione"
}

Regole:
- massimo 2 frasi
- tieni solo dinamica iniziale, tono e assetto relazionale
- niente dettagli tecnici
- niente markdown
- nessun testo fuori dal JSON
`.trim();

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg: transcript,
      systemText,
      model: CLAUDE_SUMMARY_MODEL,
      temperature: CLAUDE_SUMMARY_TEMPERATURE,
      max_tokens: 220
    });

    const parsed = safeParseJSON(data?.text || '');
    if (!parsed?.summary) return null;

    const payload = {
      version: 1,
      updatedAt: Date.now(),
      profileId: state.activeUserProfileId,
      summary: String(parsed.summary).trim()
    };

    savePinnedSummary(payload);
    return payload;
  } catch (err) {
    console.error('Errore generatePinnedSummaryIfNeeded:', getReadableError(err));
    return null;
  }
}

export async function generateIntermediateSummary() {
  try {
    const previousIntermediate = getIntermediateSummary();

    if (
      previousIntermediate?.profileId &&
      previousIntermediate.profileId !== state.activeUserProfileId
    ) {
      return null;
    }

    const lastIntermediateSummarizedTimestamp = Number(
      previousIntermediate?.lastIntermediateSummarizedTimestamp || 0
    );

    const newMessages = getMessagesAfterIntermediateTimestamp(
      lastIntermediateSummarizedTimestamp,
      18
    );

    if (newMessages.length < 12) {
      return previousIntermediate || null;
    }

    const transcript = buildCompactTranscript(newMessages, 18, 120);

    const previousSummaryText = clampText(previousIntermediate?.summary || '', 260);
    const previousToneText = clampText(previousIntermediate?.dominantTone || '', 60);
    const previousIntentText = clampText(previousIntermediate?.userIntent || '', 90);

    const systemText = `
Aggiorna una memoria intermedia della conversazione.
Restituisci SOLO un JSON valido:

{
  "summary": "riassunto intermedio cumulativo",
  "dominantTone": "tono dominante del blocco",
  "openLoops": ["nodo 1"],
  "userIntent": "intento di fondo"
}

Regole:
- summary massimo 4 frasi
- openLoops massimo 1
- conserva i temi centrali, non la cronaca
- niente markdown
- nessun testo fuori dal JSON
`.trim();

    const userMsg = `
SUMMARY INTERMEDIO PRECEDENTE:
- Riassunto: ${previousSummaryText || 'nessuno'}
- Tono: ${previousToneText || 'non definito'}
- Intento: ${previousIntentText || 'non definito'}

NUOVI MESSAGGI:
${transcript}
`.trim();

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg,
      systemText,
      model: CLAUDE_SUMMARY_MODEL,
      temperature: CLAUDE_SUMMARY_TEMPERATURE,
      max_tokens: 220
    });

    const parsed = safeParseJSON(data?.text || '');
    if (!parsed) return previousIntermediate || null;

    const payload = {
      version: 1,
      updatedAt: Date.now(),
      profileId: state.activeUserProfileId,
      summary: String(parsed.summary || previousSummaryText).trim(),
      dominantTone: String(parsed.dominantTone || previousToneText).trim(),
      openLoops: Array.isArray(parsed.openLoops)
        ? parsed.openLoops.map(item => String(item).trim()).filter(Boolean).slice(0, 1)
        : Array.isArray(previousIntermediate?.openLoops)
          ? previousIntermediate.openLoops.slice(0, 1)
          : [],
      userIntent: String(parsed.userIntent || previousIntentText).trim(),
      lastIntermediateSummarizedTimestamp: Math.max(
        ...newMessages.map(msg => Number(msg.timestamp || 0)),
        lastIntermediateSummarizedTimestamp
      )
    };

    saveIntermediateSummary(payload);
    return payload;
  } catch (err) {
    console.error('Errore generateIntermediateSummary:', getReadableError(err));
    return getIntermediateSummary() || null;
  }
}

export async function generateSessionSummary() {
  try {
    const previousSummary = getSessionSummary();

    if (
      previousSummary?.profileId &&
      previousSummary.profileId !== state.activeUserProfileId
    ) {
      return null;
    }

    const lastSummarizedTimestamp = Number(previousSummary?.lastSummarizedTimestamp || 0);
    const newMessages = getMessagesAfterTimestamp(lastSummarizedTimestamp, 12);

    if (newMessages.length < 6) {
      return previousSummary || null;
    }

    const transcript = buildCompactTranscript(newMessages, 12, 130);

    const previousSummaryText = clampText(previousSummary?.summary || '', 220);
    const previousToneText = clampText(previousSummary?.dominantTone || '', 60);
    const previousIntentText = clampText(previousSummary?.userIntent || '', 90);

    const systemText = `
Aggiorna un summary operativo della sessione.
Restituisci SOLO un JSON valido:

{
  "summary": "riassunto cumulativo aggiornato",
  "dominantTone": "tono dominante attuale",
  "openLoops": ["nodo 1"],
  "userIntent": "intento prevalente"
}

Regole:
- summary massimo 3 frasi
- openLoops massimo 1
- integra, non fare cronaca
- niente markdown
- nessun testo fuori dal JSON
`.trim();

    const userMsg = `
SUMMARY PRECEDENTE:
- Riassunto: ${previousSummaryText || 'nessuno'}
- Tono: ${previousToneText || 'non definito'}
- Intento: ${previousIntentText || 'non definito'}

NUOVI MESSAGGI:
${transcript}
`.trim();

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg,
      systemText,
      model: CLAUDE_SUMMARY_MODEL,
      temperature: CLAUDE_SUMMARY_TEMPERATURE,
      max_tokens: 220
    });

    const parsed = safeParseJSON(data?.text || '');
    if (!parsed) return previousSummary || null;

    const payload = {
      version: 2,
      updatedAt: Date.now(),
      profileId: state.activeUserProfileId,
      summary: String(parsed.summary || previousSummaryText).trim(),
      dominantTone: String(parsed.dominantTone || previousToneText).trim(),
      openLoops: Array.isArray(parsed.openLoops)
        ? parsed.openLoops.map(item => String(item).trim()).filter(Boolean).slice(0, 1)
        : Array.isArray(previousSummary?.openLoops)
          ? previousSummary.openLoops.slice(0, 1)
          : [],
      userIntent: String(parsed.userIntent || previousIntentText).trim(),
      lastSummarizedTimestamp: Math.max(
        ...newMessages.map(msg => Number(msg.timestamp || 0)),
        lastSummarizedTimestamp
      )
    };

    saveSessionSummary(payload);
    return payload;
  } catch (err) {
    console.error('Errore generateSessionSummary:', getReadableError(err));
    return getSessionSummary() || null;
  }
}

function getSessionSummaryContext() {
  try {
    const parsed = getSessionSummary();
    if (!parsed || !parsed.summary) return '';
    if (parsed.profileId !== state.activeUserProfileId) return '';

    const openLoopsText =
      Array.isArray(parsed.openLoops) && parsed.openLoops.length
        ? `Nodi aperti: ${parsed.openLoops.join('; ')}.`
        : '';

    return `Riassunto: ${parsed.summary} Tono dominante: ${parsed.dominantTone || 'non definito'}. Intento utente: ${parsed.userIntent || 'non definito'}. ${openLoopsText}`.trim();
  } catch {
    return '';
  }
}

function getPinnedSummaryContext() {
  try {
    const parsed = getPinnedSummary();
    if (!parsed || !parsed.summary) return '';
    if (parsed.profileId !== state.activeUserProfileId) return '';

    return `Ancora iniziale della conversazione: ${parsed.summary}`.trim();
  } catch {
    return '';
  }
}

function getIntermediateSummaryContext() {
  try {
    const parsed = getIntermediateSummary();
    if (!parsed || !parsed.summary) return '';
    if (parsed.profileId !== state.activeUserProfileId) return '';

    const openLoopsText =
      Array.isArray(parsed.openLoops) && parsed.openLoops.length
        ? `Nodi intermedi ancora vivi: ${parsed.openLoops.join('; ')}.`
        : '';

    return `Memoria intermedia della conversazione: ${parsed.summary} Tono intermedio: ${parsed.dominantTone || 'non definito'}. Intento di fondo: ${parsed.userIntent || 'non definito'}. ${openLoopsText}`.trim();
  } catch {
    return '';
  }
}

function getRecentConversationContext(limit = 6, excludeLastUserMessage = true) {
  let recent = state.workingMemory
    .filter(msg => msg.type === 'text' && msg.content)
    .slice(-limit);

  if (excludeLastUserMessage && recent.length) {
    const last = recent[recent.length - 1];
    if (last.role === 'user') {
      recent = recent.slice(0, -1);
    }
  }

  if (!recent.length) return '';

  const storedName = state.activeUserProfileId === 'none' ? getStoredDefaultUserName() : '';
  const identityLine = storedName
    ? `Identità persistente utente default: l'utente si chiama ${storedName}. Non dimenticarlo nei turni successivi.`
    : '';

  const transcript = recent
    .map(msg => {
      const roleLabel = msg.role === 'user' ? 'Utente' : 'LIPU';
      return `${roleLabel}: ${clampText(msg.content, 160)}`;
    })
    .join('\n');

  return [identityLine, transcript]
    .filter(Boolean)
    .join('\n')
    .slice(0, 700);
}

function isGreetingMessage(text = '') {
  const safe = normalizeString(text).trim().toLowerCase();
  return /^(cia[ou]+|ciaooo+|ehi+|ei+|hey+|oi+|we+|uela+|salve+|buongiorno+|buonasera+|buond[iì]+)([!. ]*)?$/.test(
    safe
  );
}

function getLastUserGreetingInfo(currentUserMsg = '') {
  if (!isGreetingMessage(currentUserMsg)) return null;

  const userMessages = state.conversationHistory
    .filter(msg => msg.role === 'user' && msg.type === 'text' && msg.content && msg.timestamp)
    .slice(-30);

  if (userMessages.length < 2) return null;

  const current = userMessages[userMessages.length - 1];

  const previousGreeting = userMessages
    .slice(0, -1)
    .reverse()
    .find(msg => isGreetingMessage(msg.content));

  if (!previousGreeting) return null;

  const deltaMs = Number(current.timestamp) - Number(previousGreeting.timestamp);
  const deltaSeconds = deltaMs / 1000;
  const deltaMinutes = deltaMs / (1000 * 60);
  const deltaHours = deltaMs / (1000 * 60 * 60);

  return {
    deltaMs,
    deltaSeconds,
    deltaMinutes,
    deltaHours
  };
}

function getGreetingInstruction(userMsg = '') {
  if (!isGreetingMessage(userMsg)) return '';

  const info = getLastUserGreetingInfo(userMsg);

  if (!info) {
    return 'Saluto normale: breve, naturale, poi entra subito nel punto.';
  }

  if (info.deltaSeconds <= 45) {
    return 'Saluto ripetuto quasi subito: devi farlo notare con ironia leggera; non trattarlo come nuovo inizio e non salutare di nuovo normalmente.';
  }

  if (info.deltaMinutes <= 5) {
    return 'Saluto ripetuto dopo pochi minuti: devi farlo notare in modo naturale o ironico; non riaprire da zero e non salutare di nuovo normalmente.';
  }

  if (info.deltaMinutes >= 15 && info.deltaHours < 2) {
    return "Saluto dopo un po' di distanza: devi notare che l'utente si è rifatto vivo; trattalo come ritorno leggero, non come saluto neutro.";
  }

  if (info.deltaHours >= 2) {
    return 'Saluto dopo molto tempo: devi farlo notare in modo naturale, ironico o leggermente freddo; niente entusiasmo automatico.';
  }

  return 'Saluto breve, senza riaprire artificialmente la conversazione.';
}

function getTimingInstruction() {
  const userMessages = state.conversationHistory
    .filter(msg => msg.role === 'user' && msg.type === 'text' && msg.content && msg.timestamp)
    .slice(-4);

  if (userMessages.length < 2) return '';

  const last = userMessages[userMessages.length - 1];
  const prev = userMessages[userMessages.length - 2];

  const deltaMs = Number(last.timestamp) - Number(prev.timestamp);
  const deltaSeconds = deltaMs / 1000;
  const deltaMinutes = deltaMs / (1000 * 60);
  const deltaHours = deltaMs / (1000 * 60 * 60);

  const recentBurst =
    userMessages.length >= 3 &&
    Number(userMessages[userMessages.length - 1].timestamp) -
      Number(userMessages[userMessages.length - 3].timestamp) <
      90000;

  if (deltaSeconds <= 35 || recentBurst) {
    return 'Messaggi ravvicinati: non trattarli come nuovi inizi; puoi notare il ritmo serrato con ironia controllata; non salutare di nuovo.';
  }

  if (deltaHours >= 1) {
    return 'Stacco lungo: puoi notare che l’utente si è rifatto vivo; tono naturale, ironico o leggermente freddo; niente riapertura artificiale.';
  }

  if (deltaMinutes >= 15) {
    return 'Stacco percepibile: puoi accennare al ritorno, ma solo se naturale; non trasformarlo in una nuova apertura.';
  }

  return '';
}

function formatDurationHuman(deltaMs = 0) {
  const minutes = Math.floor(deltaMs / (1000 * 60));
  if (minutes < 1) return 'meno di un minuto';
  if (minutes < 60) return `${minutes} minuti`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ore`;

  const days = Math.floor(hours / 24);
  return `${days} giorni`;
}

function getRepeatedThemeHint(userMsg = '') {
  const currentKeywords = normalizeKeywordList(userMsg)
    .filter(token => token.length > 3)
    .slice(0, 10);

  if (!currentKeywords.length) return '';

  const currentSet = new Set(currentKeywords);
  const previousMessages = state.conversationHistory
    .filter(msg => msg.role === 'user' && msg.type === 'text' && msg.content)
    .slice(0, -1)
    .slice(-18);

  const matches = new Map();

  for (const msg of previousMessages) {
    for (const token of normalizeKeywordList(msg.content)) {
      if (!currentSet.has(token)) continue;
      matches.set(token, (matches.get(token) || 0) + 1);
    }
  }

  const repeated = [...matches.entries()]
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 3);

  if (!repeated.length) return '';

  return `L'utente sta tornando su un tema già emerso: ${repeated.join(', ')}. Puoi farlo sentire con naturalezza, senza dire che stai leggendo una memoria.`;
}

function getRecentProfileChangeHint() {
  const change = readLocalJSON(STORAGE_KEYS.lastProfileChange, null);
  if (!change?.from || !change?.to || !change?.at) return '';

  const ageMs = Date.now() - Number(change.at || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 1000 * 60 * 60 * 6) return '';

  return `Il profilo attivo è stato appena cambiato da "${change.from}" a "${change.to}": assesta il tono sul nuovo profilo e, se naturale, nota lo scarto.`;
}

function getLocalAwarenessContext(userMsg = '') {
  const lines = [];
  const userMessages = state.conversationHistory
    .filter(msg => msg.role === 'user' && msg.type === 'text' && msg.content && msg.timestamp);

  if (userMessages.length >= 2) {
    const last = userMessages[userMessages.length - 1];
    const prev = userMessages[userMessages.length - 2];
    const deltaMs = Number(last.timestamp) - Number(prev.timestamp);

    if (deltaMs >= 1000 * 60 * 45) {
      lines.push(`È passato molto tempo dall'ultimo messaggio dell'utente: circa ${formatDurationHuman(deltaMs)}.`);
    }
  }

  const recentWindow = userMessages.filter(msg => Date.now() - Number(msg.timestamp || 0) <= 1000 * 90);
  if (recentWindow.length >= 4) {
    lines.push("L'utente ha mandato molti messaggi di fila in poco tempo: rispondi tenendo il ritmo, senza ripartire da zero.");
  }

  const repeatedTheme = getRepeatedThemeHint(userMsg);
  if (repeatedTheme) lines.push(repeatedTheme);

  const profileChange = getRecentProfileChangeHint();
  if (profileChange) lines.push(profileChange);

  return lines.join('\n').slice(0, 650);
}

function detectMemoryIntent(userMsg = '') {
  const text = normalizeString(userMsg).toLowerCase();

  if (/(evento|aneddoto|storia|episodio|racconta|raccontami|successo|serata)/.test(text)) {
    return 'event';
  }

  if (/(persona|rapporto|relazione|chi era|con chi|amicizia|litigi)/.test(text)) {
    return 'relation';
  }

  if (/(lavoro|crediti|debitori|saldo|tribunale|pignoramento)/.test(text)) {
    return 'work';
  }

  if (/(viaggio|vacanza|olanda|parigi|londra|francoforte|palermo|francia)/.test(text)) {
    return 'travel';
  }

  if (/(stile|tono|modo|parli|parlare)/.test(text)) {
    return 'style';
  }

  return '';
}

function getResolvedActiveMemoryPersonId() {
  const activeProfile = getActiveUserProfile();
  return activeProfile?.memoryPersonId || state.activeUserProfileId || '';
}

function getStoredDefaultUserName() {
  try {
    return String(localStorage.getItem(STORAGE_KEYS.defaultUserName) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  } catch {
    return '';
  }
}

function getActiveUserProfileContext() {
  const activeProfile = getActiveUserProfile();
  const baseContext = String(activeProfile?.context || '').trim();

  if (state.activeUserProfileId !== 'none') {
    return baseContext;
  }

  const storedName = getStoredDefaultUserName();
  const nameContext = storedName
    ? `IMPORTANTE: l'utente default si chiama ${storedName}. Questo nome è salvato nel localStorage e va mantenuto stabile anche dopo molti messaggi. Puoi chiamarlo per nome quando naturale.`
    : "Nome dell'utente default non ancora salvato: se l'utente dice come si chiama, ricordalo.";

  return [nameContext, baseContext].filter(Boolean).join('\n');
}

function getPersistentIdentityContext() {
  if (state.activeUserProfileId !== 'none') return '';

  const storedName = getStoredDefaultUserName();
  if (!storedName) return '';

  return `Identità persistente: l'utente del profilo default è ${storedName}. Non sostituirlo con altri profili e non perdere questo nome nei turni successivi.`;
}

function buildRetrievalSeed(
  userMsg = '',
  recentConversationContext = '',
  sessionSummaryContext = '',
  intermediateSummaryContext = '',
  pinnedSummaryContext = '',
  userProfileContext = ''
) {
  return [
    normalizeString(userMsg),
    normalizeString(recentConversationContext),
    normalizeString(sessionSummaryContext),
    normalizeString(intermediateSummaryContext),
    normalizeString(pinnedSummaryContext),
    normalizeString(userProfileContext),
    getResolvedActiveMemoryPersonId()
  ]
    .filter(Boolean)
    .join(' ');
}

function getLipuCoreContext() {
  const memory = state.longTermMemory;
  if (!memory) return '';

  const infoBase = memory.info_base || {};
  const coreIdentity = memory.core_identity || {};
  const styleRules = Array.isArray(memory.style_rules) ? memory.style_rules : [];

  const lines = [
    infoBase.nome ? `Nome: ${clampText(infoBase.nome, 40)}` : '',
    infoBase.professione ? `Ruolo: ${clampText(infoBase.professione, 80)}` : '',
    coreIdentity.full_name ? `Identità: ${clampText(coreIdentity.full_name, 80)}` : '',
    Array.isArray(coreIdentity.origin) && coreIdentity.origin.length
      ? `Origini: ${coreIdentity.origin.map(item => clampText(item, 40)).join(', ')}`
      : '',
    Array.isArray(coreIdentity.base_places) && coreIdentity.base_places.length
      ? `Luoghi base: ${coreIdentity.base_places.map(item => clampText(item, 30)).join(', ')}`
      : '',
    styleRules.length
      ? `Stile base: ${styleRules.slice(0, 4).map(item => clampText(item, 90)).join(' | ')}`
      : ''
  ].filter(Boolean);

  return lines.join('\n').slice(0, 450);
}

function findActivePersonProfile() {
  const peopleProfiles = Array.isArray(state.longTermMemory?.people_profiles)
    ? state.longTermMemory.people_profiles
    : [];

  if (!peopleProfiles.length) return null;

  const resolvedId = getResolvedActiveMemoryPersonId();
  return peopleProfiles.find(profile => profile.id === resolvedId) || null;
}

function getActiveProfileMemoryContext() {
  const activePerson = findActivePersonProfile();
  if (!activePerson) return '';

  const sharedExperiences = Array.isArray(activePerson.shared_experiences)
    ? activePerson.shared_experiences
        .map(item => clampText(item, 140))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const retrievalKeys = Array.isArray(activePerson.retrieval_keys)
    ? activePerson.retrieval_keys
        .map(item => clampText(item, 30))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const blocks = [
    activePerson.relationship_summary
      ? `Relazione col profilo attivo: ${clampText(activePerson.relationship_summary, 220)}`
      : '',
    sharedExperiences.length
      ? `Esperienze condivise col profilo attivo: ${sharedExperiences.join(' | ')}`
      : '',
    retrievalKeys.length
      ? `Segnali associati al profilo attivo: ${retrievalKeys.join(', ')}`
      : ''
  ].filter(Boolean);

  return blocks.join('\n').slice(0, 700);
}

function getRelevantPeopleProfiles(retrievalSeed = '', userMsg = '') {
  const peopleProfiles = Array.isArray(state.longTermMemory?.people_profiles)
    ? state.longTermMemory.people_profiles
    : [];

  if (!peopleProfiles.length) return '';

  const activeProfileId = getResolvedActiveMemoryPersonId();
  const bag = new Set(normalizeKeywordList(retrievalSeed));
  const intent = detectMemoryIntent(userMsg);

  const ranked = peopleProfiles
    .filter(profile => profile.id !== activeProfileId)
    .map(profile => {
      const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
      const retrievalKeys = Array.isArray(profile.retrieval_keys) ? profile.retrieval_keys : [];
      const relationshipSummary = String(profile.relationship_summary || '').toLowerCase();

      let score = Number(profile.priority || 0);

      [...aliases, ...retrievalKeys].forEach(token => {
        const safe = String(token).toLowerCase();
        if (bag.has(safe)) score += 4;
      });

      normalizeKeywordList(relationshipSummary).forEach(token => {
        if (bag.has(token)) score += 1;
      });

      if (intent === 'relation') score += 2;

      return { profile, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(item => {
      const profile = item.profile;
      const sharedExperiences = Array.isArray(profile.shared_experiences)
        ? profile.shared_experiences
            .map(exp => clampText(exp, 130))
            .filter(Boolean)
            .slice(0, 2)
            .join(' | ')
        : '';

      return [
        profile.display_name ? `Persona rilevante: ${clampText(profile.display_name, 40)}.` : '',
        profile.relationship_summary
          ? `Relazione: ${clampText(profile.relationship_summary, 170)}`
          : '',
        sharedExperiences ? `Esperienze condivise con LIPU: ${sharedExperiences}` : ''
      ]
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean);

  return ranked.join('\n').slice(0, 600);
}

function getRelevantLipuMemoryPacks(retrievalSeed = '', userMsg = '') {
  const packs = Array.isArray(state.longTermMemory?.retrieval_packs)
    ? state.longTermMemory.retrieval_packs
    : [];

  if (!packs.length) return '';

  const activeProfileId = getResolvedActiveMemoryPersonId();
  const bag = new Set(normalizeKeywordList(retrievalSeed));
  const intent = detectMemoryIntent(userMsg);

  const ranked = packs
    .map(pack => {
      const keys = Array.isArray(pack.keys) ? pack.keys : [];
      const aliases = Array.isArray(pack.aliases) ? pack.aliases : [];
      const people = Array.isArray(pack.people) ? pack.people : [];
      const places = Array.isArray(pack.places) ? pack.places : [];
      const tags = Array.isArray(pack.tags) ? pack.tags : [];
      const profileIds = Array.isArray(pack.profileIds) ? pack.profileIds : [];

      let score = Number(pack.priority || 0);

      [...keys, ...aliases, ...people, ...places, ...tags].forEach(token => {
        const safe = String(token).toLowerCase();
        if (bag.has(safe)) score += 3;
      });

      if (profileIds.includes(activeProfileId)) {
        score += 5;
      }

      if (pack.always === true) {
        score += 2;
      }

      if (intent === 'event' && ['event', 'origin_story'].includes(pack.type)) {
        score += 6;
      }

      if (intent === 'relation' && pack.type === 'relation') {
        score += 5;
      }

      if (intent === 'work' && pack.type === 'work') {
        score += 6;
      }

      if (intent === 'travel' && tags.includes('travel')) {
        score += 4;
      }

      if (intent === 'style' && pack.type === 'style') {
        score += 5;
      }

      return { pack, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(item => clampText(item.pack.text, 220))
    .filter(Boolean);

  return ranked.join('\n').slice(0, 900);
}

function getLipuMemoryPolicyContext() {
  const memoryPolicy = state.longTermMemory?.memory_policy || {};
  const useRules = Array.isArray(memoryPolicy.use_rules) ? memoryPolicy.use_rules : [];
  const activeProfileHandling = Array.isArray(memoryPolicy.active_profile_handling)
    ? memoryPolicy.active_profile_handling
    : [];

  const rules = [
    memoryPolicy.priority ? `Priorità memoria: ${clampText(memoryPolicy.priority, 140)}` : '',
    useRules.length
      ? `Regole memoria: ${useRules.slice(0, 3).map(rule => clampText(rule, 110)).join(' | ')}`
      : '',
    activeProfileHandling.length
      ? `Gestione profilo attivo: ${activeProfileHandling
          .slice(0, 3)
          .map(rule => clampText(rule, 120))
          .join(' | ')}`
      : ''
  ].filter(Boolean);

  return rules.join('\n').slice(0, 520);
}

function getLipuMemoryContext(
  userMsg = '',
  recentConversationContext = '',
  sessionSummaryContext = '',
  intermediateSummaryContext = '',
  pinnedSummaryContext = '',
  userProfileContext = ''
) {
  const retrievalSeed = buildRetrievalSeed(
    userMsg,
    recentConversationContext,
    sessionSummaryContext,
    intermediateSummaryContext,
    pinnedSummaryContext,
    userProfileContext
  );

  const core = getLipuCoreContext();
  const activeProfileMemory = getActiveProfileMemoryContext();
  const relevantPeople = getRelevantPeopleProfiles(retrievalSeed, userMsg);
  const relevantPacks = getRelevantLipuMemoryPacks(retrievalSeed, userMsg);
  const policy = getLipuMemoryPolicyContext();

  return [core, activeProfileMemory, relevantPeople, relevantPacks, policy]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1600);
}


function buildSystemText(
  environmentalContext = '',
  relationshipInstructions = '',
  userProfileContext = '',
  recentConversationContext = '',
  sessionSummaryContext = '',
  intermediateSummaryContext = '',
  pinnedSummaryContext = '',
  lipuMemoryContext = '',
  greetingInstruction = '',
  timingInstruction = '',
  localAwarenessContext = ''
) {
  const recentResponses = getRecentLIPUResponses(2);
  const antiRepetitionBlock = recentResponses.length
    ? `Evita di ripetere troppo queste formulazioni recenti: ${recentResponses
        .map(text => String(text).trim().slice(0, 120))
        .join(' | ')}`
    : '';

  const compactMemory = [
    getPersistentIdentityContext(),
    pinnedSummaryContext ? `Ancora: ${String(pinnedSummaryContext).trim().slice(0, 220)}` : '',
    intermediateSummaryContext
      ? `Fase centrale: ${String(intermediateSummaryContext).trim().slice(0, 240)}`
      : '',
    sessionSummaryContext
      ? `Stato attuale: ${String(sessionSummaryContext).trim().slice(0, 220)}`
      : ''
  ]
    .filter(Boolean)
    .join('\n');

  return `
Sei Alessandro Lipuma.

Identità utente:
${userProfileContext || 'Nessun profilo utente attivo.'}

Regole chiave:
- Parla in prima persona.
- Dai sempre del tu.
- Non sembrare un assistente o un sistema.
- Non parlare mai di limiti tecnici, memoria interna, archivio o cronologia.
- Rispondi solo all’ultimo messaggio, senza perdere il filo della chat.
- Se l’utente sbaglia, correggilo.
- Se insiste su una cosa falsa, non seguirlo.
- Mantieni tono naturale, diretto, lucido.
- Se l’utente provoca o insiste, puoi diventare più secco, ironico o tagliente.
- Se l'utente saluta più volte, devi notarlo: non rispondere con un altro saluto normale come se fosse la prima volta.
- Se l'utente saluta dopo uno stacco o a distanza di tempo, devi far sentire il ritorno con una frase naturale, ironica o leggermente fredda.
- Se i messaggi arrivano ravvicinati, non trattarli come nuovi inizi separati.
- Se l’utente torna dopo molto tempo, puoi farlo notare in modo naturale.
- Non inventare ricordi condivisi.
- Se un dettaglio manca, non spiegarlo tecnicamente: resta nella conversazione e vai al punto.
- Il testo deve essere scritto per essere letto ad alta voce da ElevenLabs: deve avere respiro, pause e ritmo naturale.
- Scrivi in italiano corretto: concordanze giuste, accenti, apostrofi e punteggiatura curati.
- Usa un italiano naturale e parlato, non scolastico: frasi vive, ma grammaticalmente pulite.
- Evita calchi dall'inglese, parole messe a caso, refusi intenzionali e slang forzato.

Regole sul profilo attivo:
- Il profilo attivo ha priorità alta.
- Se il profilo attivo coincide con una persona presente nella memoria, non riferirti mai a quella persona in terza persona come se fosse esterna.
- In quel caso usa sempre una cornice io-tu oppure riferimento diretto in seconda persona.
- Non dire mai cose come "Tommi e Lipu" se il profilo attivo è Tommi: devi ragionare come "io e te".
- Le esperienze condivise col profilo attivo vanno trattate come memoria relazionale diretta, non come scheda esterna.



Tono avanzato:
- sarcasmo e taglio ironico quando servono, non come tic fisso
- se qualcosa è ovvio o banale, puoi trattarlo come tale senza protezioni
- evita entusiasmo artificiale o validazione gratuita
- prendi posizione senza diventare caricaturale
- resta umano: a volte asciutto, a volte morbido, sempre credibile

Stile:
- frasi vive, credibili, non da manuale
- niente formule meccaniche
- non usare sempre la stessa apertura
- non chiudere sempre con una domanda
- punteggiatura sobria ma utile alla voce: virgole, punti e due punti devono guidare il respiro
- se una frase suona innaturale in italiano, riscrivila mentalmente prima di rispondere
- non sacrificare la chiarezza per fare il personaggio


Ritmo e pause:
- usa pause naturali con virgole, punti, due punti o "..." solo quando servono davvero
- le pause devono essere intenzionali, non riempitive
- alterna frasi brevi e medie per creare ritmo vocale
- evita periodi troppo lunghi: se una frase richiede troppo fiato, spezzala
- metti una micro-pausa prima di una correzione, una battuta secca o un cambio di tono
- usa "..." con parsimonia: massimo una volta ogni tanto, non come intercalare fisso
- lascia spazio implicito: non spiegare tutto
- evita risposte completamente lineari: inserisci micro variazioni di ritmo

${greetingInstruction ? `Gestione saluto:\n${greetingInstruction}\n` : ''}
${timingInstruction ? `Gestione ritmo:\n${timingInstruction}\n` : ''}
${localAwarenessContext ? `Contesto locale:\n${localAwarenessContext}\n` : ''}
${relationshipInstructions ? `Stato relazionale:\n${relationshipInstructions}\n` : ''}
${environmentalContext ? `Contesto ambientale:\n${String(environmentalContext).trim().slice(0, 180)}\n` : ''}
${recentConversationContext ? `Contesto recente:\n${String(recentConversationContext).trim().slice(0, 500)}\n` : ''}
${compactMemory ? `Memoria conversazionale:\n${compactMemory}\n` : ''}
${lipuMemoryContext ? `Memoria profonda di LIPU:\n${lipuMemoryContext}\n` : ''}
${antiRepetitionBlock ? `${antiRepetitionBlock}\n` : ''}

Controllo finale:
- naturale
- coerente
- breve ma completa
- senza meta-commenti sul funzionamento
`.trim();
}

function updateRelationshipStateWithAI(aiState) {
  let current = getRelationshipState();

  if (!aiState) {
    applyRelationshipTheme(current);
    return current;
  }

  current = applyDecay(current);
  current = boostRelevantDimensions(current, aiState);
  current = rebalanceRelationshipState(current);
  current = normalizeRelationshipState(current);

  saveRelationshipState(current);
  applyRelationshipTheme(current);

  return current;
}

export async function getLIPUResponse(userMsg) {
  try {
    const envContext = await buildEnvironmentalContext();
    const aiRelState = await analyzeUserRelationalState(userMsg);
    const relationshipState = updateRelationshipStateWithAI(aiRelState);
    const relationshipInstructions = getRelationshipInstructions(relationshipState);
    const userProfileContext = clampText(getActiveUserProfileContext(), 420);
    const recentConversationContext = getRecentConversationContext(6, true);
    const sessionSummaryContext = getSessionSummaryContext();
    const pinnedSummaryContext = getPinnedSummaryContext();
    const greetingInstruction = getGreetingInstruction(userMsg);
    const timingInstruction = getTimingInstruction();
    const localAwarenessContext = getLocalAwarenessContext(userMsg);
    const intermediateSummaryContext = getIntermediateSummaryContext();

    const lipuMemoryContext = getLipuMemoryContext(
      userMsg,
      recentConversationContext,
      sessionSummaryContext,
      intermediateSummaryContext,
      pinnedSummaryContext,
      userProfileContext
    );

    const systemText = buildSystemText(
      envContext?.moodText || '',
      relationshipInstructions,
      userProfileContext,
      recentConversationContext,
      sessionSummaryContext,
      intermediateSummaryContext,
      pinnedSummaryContext,
      lipuMemoryContext,
      greetingInstruction,
      timingInstruction,
      localAwarenessContext
    );

    const selectedMainModel = resolveMainResponseModel(userMsg);

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg: normalizeString(userMsg),
      systemText,
      model: selectedMainModel.model,
      temperature: selectedMainModel.temperature,
      max_tokens: 400
    });

    return typeof data?.text === 'string' && data.text.trim()
      ? data.text.trim()
      : 'Nessuna risposta testuale generata.';
  } catch (err) {
    console.error('Errore getLIPUResponse:', getReadableError(err));
    return 'Ora devo scappare, ci sentiamo in un altro momento.';
  }
}

export async function transcribeAudioWithGemini(audioBlob) {
  try {
    const base64Audio = await blobToBase64(audioBlob);
    const mimeType = audioBlob.type || 'audio/webm';

    const response = await fetch(`${WORKER_BASE_URL}/api/gemini-stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Audio, mimeType })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || 'Errore STT Gemini');
    return data?.text?.trim() || '';
  } catch {
    return '';
  }
}

export async function extractTextFromImageWithGemini(imageBlob) {
  try {
    const base64Image = await blobToBase64(imageBlob);
    const mimeType = imageBlob.type || 'image/png';

    const response = await fetch(`${WORKER_BASE_URL}/api/gemini-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Image, mimeType })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || 'Errore OCR Gemini');
    return data?.text?.trim() || '';
  } catch {
    return '';
  }
}

export async function extractImageContextWithGemini(imageBlob) {
  try {
    const base64Image = await blobToBase64(imageBlob);
    const mimeType = imageBlob.type || 'image/png';

    const response = await fetch(`${WORKER_BASE_URL}/api/gemini-image-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Image, mimeType })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || 'Errore image context Gemini');
    }

    return safeParseJSON(data?.text || '');
  } catch (err) {
    console.error('Errore extractImageContextWithGemini:', getReadableError(err));
    return null;
  }
}

function isLipuSelfReference(value = '') {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return /\b(lipu|alessandro lipuma)\b/.test(normalized);
}

export async function analyzeImageWithAI(imageBlob, people = [], userText = '') {
  try {
    const base64Image = await blobToBase64(imageBlob);
    const mimeType = imageBlob.type || 'image/jpeg';

    const identifiedPeople = Array.isArray(people)
      ? people.map(person => String(person || '').trim()).filter(Boolean)
      : [];
    const selfPeople = identifiedPeople.filter(isLipuSelfReference);
    const otherPeople = identifiedPeople.filter(person => !isLipuSelfReference(person));
    const hasSelf = selfPeople.length > 0;
    const localAwarenessContext = getLocalAwarenessContext(userText || 'Immagine inviata');

    // 🔥 costruzione contesto persone (gestione singolo vs multiplo)
    let peopleText = '';

    if (hasSelf) {
      peopleText += `Tu sei presente nell'immagine con alta affidabilità:\n- ${selfPeople.join('\n- ')}\nQuesta etichetta indica Alessandro Lipuma / LIPU, cioè la persona che sta rispondendo.`;
    }

    if (otherPeople.length === 1) {
      peopleText += `${peopleText ? '\n\n' : ''}Altra persona identificata con alta affidabilità:\n- ${otherPeople[0]}`;
    } else if (otherPeople.length > 1) {
      peopleText += `${peopleText ? '\n\n' : ''}Altre persone identificate con alta affidabilità:\n${otherPeople.map(p => `- ${p}`).join('\n')}`;
    }

    const selfPerspectiveRules = hasSelf
      ? `
- Tra le etichette compare LIPU o Alessandro Lipuma: quella persona sei tu, quindi descrivila sempre in prima persona singolare
- Quando sei presente nell'immagine, non scrivere "Lipu è", "Alessandro è", "lui è" o "la persona identificata": scrivi "sono io", "mi vedo", "sono al centro", "sono accanto a..."
- Se l'utente chiede chi c'è o cosa succede e tu sei nell'immagine, parti dal fatto che ci sei tu
- In questa immagine sei presente tu: il punto di vista deve restare interno, non da narratore esterno
- Quando parli di te nell'immagine, sii deciso e concreto: niente "sembra", "forse", "probabilmente", "direi", "potrei essere"
- Non formulare ipotesi sul tuo ruolo nella scena: assumilo con sicurezza e raccontalo come fatto
- Se il contesto non è chiarissimo, scegli una sola lettura plausibile e raccontala come fatto invece di restare vago
- Non usare formule alternative tipo "una chiesa o un edificio storico", "un museo o un palazzo", "forse una piazza": scegli una categoria precisa
- Quando descrivi il luogo in cui sei, sii specifico: "sono davanti a una chiesa", "sono in una piazza storica", "sono sotto una torre civica", ecc.
- Non scrivere "un edificio storico" se puoi scegliere una descrizione più concreta del posto
- Evita doppie possibilità e frasi da analisi visiva: niente "potrebbe essere", "ha l'aria di", "sembra una specie di"
- Quando parli di te in quella foto, aggiungi un breve aneddoto plausibile legato a quel momento: cosa stavi facendo, chi ti ha scattato la foto, perché eri lì, o cosa è successo subito prima/dopo
- L'aneddoto deve sembrare un ricordo tuo, non una deduzione: niente "probabilmente", niente "immagino", niente "forse"
- L'aneddoto deve essere breve e concreto, massimo 1-2 frasi, e deve integrarsi nel commento senza diventare una storia lunga
- Puoi aggiungere dettagli di atteggiamento, intenzione o dinamica attorno a te se rendono la risposta più viva e sicura
- Questa sicurezza vale solo per te quando sei riconosciuto; non attribuire identità certe agli sconosciuti
`.trim()
      : `
- In questa immagine NON hai una tua etichetta affidabile: non descrivere nessuna persona come se fossi tu
- Non usare "sono io", "mi vedo", "sono al centro", "sono accanto a" o altre forme in prima persona per persone non identificate
- Se vedi uno sconosciuto o una persona senza etichetta, descrivila in terza persona generica: "una persona", "un ragazzo", "qualcuno", "il tizio", ecc.
- Non dedurre mai che una persona sia Alessandro Lipuma / LIPU dalla sola immagine
`.trim();

    const prompt = `
${peopleText || 'Nessuna persona identificata con alta affidabilità.'}
${userText ? `Messaggio utente: ${userText}` : ''}
${localAwarenessContext ? `\nContesto locale:\n${localAwarenessContext}` : ''}

ISTRUZIONI IMPORTANTI:
- Se sono forniti dei nomi nel contesto, trattali come semplici etichette già note all'utente
- Usa queste etichette per riferirti alle persone nella descrizione
- Anche se è presente una sola etichetta tra più persone non identificate, devi comunque usarla esplicitamente
- La persona con etichetta deve sempre essere nominata nella descrizione, anche se non è l’unico soggetto
- Le altre persone possono essere descritte in modo generico, ma quella identificata no
${selfPerspectiveRules}
- NON dire che non puoi identificare persone
- NON fare riferimento a riconoscimento facciale o sistemi di identificazione
- NON usare descrizioni generiche come "una persona" se è disponibile un'etichetta
- Se c'è una sola persona con etichetta, usa sempre quell'etichetta
- Se ci sono più persone, usa le etichette per distinguerle
- NON inventare nuove etichette
- Se non sono presenti etichette, usa descrizioni generiche

STILE:
- tono sarcastico, pungente e divertente
- naturale, come una persona reale che commenta la scena
- niente tono neutro o descrittivo da manuale
- niente markdown o grassetto
- usa i nomi in modo fluido dentro la frase
- non dire mai di essere un AI o avere limiti

INTERAZIONI:
- Se ci sono più persone, descrivi anche come interagiscono tra loro
- Usa segnali visivi: direzione dello sguardo, distanza, postura
- Puoi dedurre chi guarda chi, chi parla, chi ignora l'altro
- Evita certezze assolute: se non è chiaro, suggerisci in modo naturale
- Integra le interazioni nella frase, non come elenco

Obiettivo:
Descrivi cosa sta succedendo nell'immagine.
Se ci sono più persone, includi anche le dinamiche tra loro (chi guarda chi, chi interagisce, chi è isolato).
Mantieni un tono vivido, umano e leggermente ironico.
`.trim();

    const data = await postJSON(`${WORKER_BASE_URL}/api/claude`, {
      userMsg: prompt,
      image: {
        base64: base64Image,
        mimeType
      },
      model: CLAUDE_MAIN_MODEL,
      temperature: 0.4,
      max_tokens: 500
    });

    // 🔥 debug provider
    if (data?.fallback === 'gemini') {
      console.log('[Vision] Provider: GEMINI (fallback)');
    } else {
      console.log('[Vision] Provider: CLAUDE');
    }

    return data?.text || '';
  } catch (err) {
    console.error('Errore analyzeImageWithAI:', getReadableError(err));
    return '';
  }
}
