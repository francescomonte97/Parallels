import { DEFAULT_PROFILE_ID, DEFAULT_REPLY_MODE, STORAGE_KEYS } from './config.js';
import { LIPU_USER_PROFILES } from './profiles.js';

function safeReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Errore parsing localStorage per "${key}":`, err);
    return fallback;
  }
}

function isValidProfileId(profileId) {
  return Boolean(profileId && LIPU_USER_PROFILES[profileId]);
}

function isValidReplyMode(mode) {
  return mode === 'audio' || mode === 'text';
}

function stableStringify(value) {
  return JSON.stringify(value);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function buildConversationPayloadData() {
  return {
    workingMemory: Array.isArray(state.workingMemory) ? state.workingMemory : [],
    conversationHistory: Array.isArray(state.conversationHistory) ? state.conversationHistory : [],
    relationshipState: safeReadJSON(STORAGE_KEYS.relationshipState, {}),
    relationshipTheme: safeReadJSON(STORAGE_KEYS.relationshipTheme, {}),
    sessionSummary: safeReadJSON(STORAGE_KEYS.sessionSummary, null),
    pinnedSummary: safeReadJSON(STORAGE_KEYS.pinnedSummary, null),
    intermediateSummary: safeReadJSON(STORAGE_KEYS.intermediateSummary, null),
    activeProfileId: state.activeUserProfileId,
    replyMode: state.lipuReplyMode
  };
}

function buildUnsignedExportEnvelope(payloadBase64) {
  return {
    version: 1,
    encoding: 'base64-json',
    timestamp: Date.now(),
    payload: payloadBase64
  };
}

async function verifyExportEnvelopeHash(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('File non valido');
  }

  const expectedHash =
    typeof envelope.sha256 === 'string'
      ? envelope.sha256.trim().toLowerCase()
      : '';

  if (!expectedHash) {
    throw new Error('Integrità engramma non valida');
  }

  if (envelope.encoding !== 'base64-json') {
    throw new Error('Formato engramma non supportato');
  }

  if (typeof envelope.payload !== 'string' || !envelope.payload.trim()) {
    throw new Error('Payload engramma non valido');
  }

  const unsignedEnvelope = {
    version: envelope.version,
    encoding: envelope.encoding,
    timestamp: envelope.timestamp,
    payload: envelope.payload
  };

  const actualHash = await sha256Hex(
    stableStringify(unsignedEnvelope)
  );

  if (actualHash !== expectedHash) {
    throw new Error('Integrità engramma non valida');
  }
}

function applyImportedConversationData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Struttura dati non valida');
  }

  const nextWorkingMemory = Array.isArray(data.workingMemory) ? data.workingMemory : [];
  const nextConversationHistory = Array.isArray(data.conversationHistory)
    ? data.conversationHistory
    : [];

  const nextRelationshipState =
    data.relationshipState && typeof data.relationshipState === 'object'
      ? data.relationshipState
      : {};

  const nextRelationshipTheme =
    data.relationshipTheme && typeof data.relationshipTheme === 'object'
      ? data.relationshipTheme
      : {};

  const nextSessionSummary =
    data.sessionSummary && typeof data.sessionSummary === 'object'
      ? data.sessionSummary
      : null;

  const nextPinnedSummary =
    data.pinnedSummary && typeof data.pinnedSummary === 'object'
      ? data.pinnedSummary
      : null;

  const nextIntermediateSummary =
    data.intermediateSummary && typeof data.intermediateSummary === 'object'
      ? data.intermediateSummary
      : null;

  const nextActiveProfileId = isValidProfileId(data.activeProfileId)
    ? data.activeProfileId
    : DEFAULT_PROFILE_ID;

  const nextReplyMode = isValidReplyMode(data.replyMode)
    ? data.replyMode
    : DEFAULT_REPLY_MODE;

  state.conversationHistory = nextConversationHistory;
  state.workingMemory = nextWorkingMemory;
  state.activeUserProfileId = nextActiveProfileId;
  state.lipuReplyMode = nextReplyMode;

  localStorage.setItem(
    STORAGE_KEYS.conversationHistory,
    JSON.stringify(nextConversationHistory)
  );
  localStorage.setItem(STORAGE_KEYS.workingMemory, JSON.stringify(nextWorkingMemory));
  localStorage.setItem(STORAGE_KEYS.relationshipState, JSON.stringify(nextRelationshipState));
  localStorage.setItem(STORAGE_KEYS.relationshipTheme, JSON.stringify(nextRelationshipTheme));

  if (nextSessionSummary) {
    localStorage.setItem(STORAGE_KEYS.sessionSummary, JSON.stringify(nextSessionSummary));
  } else {
    localStorage.removeItem(STORAGE_KEYS.sessionSummary);
  }

  if (nextPinnedSummary) {
    localStorage.setItem(STORAGE_KEYS.pinnedSummary, JSON.stringify(nextPinnedSummary));
  } else {
    localStorage.removeItem(STORAGE_KEYS.pinnedSummary);
  }

  if (nextIntermediateSummary) {
    localStorage.setItem(
      STORAGE_KEYS.intermediateSummary,
      JSON.stringify(nextIntermediateSummary)
    );
  } else {
    localStorage.removeItem(STORAGE_KEYS.intermediateSummary);
  }

  localStorage.setItem(STORAGE_KEYS.activeProfile, nextActiveProfileId);
  localStorage.setItem(STORAGE_KEYS.replyMode, nextReplyMode);
}

export const state = {
  workingMemory: safeReadJSON(STORAGE_KEYS.workingMemory, []),
  conversationHistory: safeReadJSON(STORAGE_KEYS.conversationHistory, []),
  longTermMemory: null,

  mediaRecorder: null,
  audioChunks: [],
  isRecording: false,
  recordingInterval: null,
  recordingSeconds: 0,
  lastAudioBlob: null,
  stopRecordingResolver: null,

  summaryUpdateCounter: 0,

  lipuReplyMode: isValidReplyMode(localStorage.getItem(STORAGE_KEYS.replyMode))
    ? localStorage.getItem(STORAGE_KEYS.replyMode)
    : DEFAULT_REPLY_MODE,

  activeUserProfileId: isValidProfileId(localStorage.getItem(STORAGE_KEYS.activeProfile))
    ? localStorage.getItem(STORAGE_KEYS.activeProfile)
    : DEFAULT_PROFILE_ID
};

export function saveWorkingMemory() {
  localStorage.setItem(STORAGE_KEYS.workingMemory, JSON.stringify(state.workingMemory));
}

export function saveConversationHistory() {
  localStorage.setItem(
    STORAGE_KEYS.conversationHistory,
    JSON.stringify(state.conversationHistory)
  );
}

export function clearConversationHistory() {
  state.conversationHistory = [];
  localStorage.removeItem(STORAGE_KEYS.conversationHistory);
}

export function clearWorkingMemory() {
  state.workingMemory = [];
  localStorage.removeItem(STORAGE_KEYS.workingMemory);
}

export function getActiveUserProfile() {
  return LIPU_USER_PROFILES[state.activeUserProfileId] || LIPU_USER_PROFILES[DEFAULT_PROFILE_ID];
}

export function restoreActiveUserProfile() {
  const saved = localStorage.getItem(STORAGE_KEYS.activeProfile);

  if (isValidProfileId(saved)) {
    state.activeUserProfileId = saved;
  } else {
    state.activeUserProfileId = DEFAULT_PROFILE_ID;
    localStorage.setItem(STORAGE_KEYS.activeProfile, state.activeUserProfileId);
  }
}

export function setReplyMode(mode) {
  if (!isValidReplyMode(mode)) return;

  state.lipuReplyMode = mode;
  localStorage.setItem(STORAGE_KEYS.replyMode, mode);
}

export function setActiveProfile(profileId) {
  if (!isValidProfileId(profileId)) return;

  state.activeUserProfileId = profileId;
  localStorage.setItem(STORAGE_KEYS.activeProfile, profileId);
}

export function resetAudioState() {
  state.mediaRecorder = null;
  state.audioChunks = [];
  state.isRecording = false;
  state.recordingSeconds = 0;
  state.lastAudioBlob = null;
  state.stopRecordingResolver = null;

  if (state.recordingInterval) {
    clearInterval(state.recordingInterval);
    state.recordingInterval = null;
  }
}

export function getSessionSummary() {
  return safeReadJSON(STORAGE_KEYS.sessionSummary, null);
}

export function saveSessionSummary(summaryPayload) {
  if (!summaryPayload || typeof summaryPayload !== 'object') {
    localStorage.removeItem(STORAGE_KEYS.sessionSummary);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.sessionSummary, JSON.stringify(summaryPayload));
}

export function clearSessionSummary() {
  localStorage.removeItem(STORAGE_KEYS.sessionSummary);
}

export function getPinnedSummary() {
  return safeReadJSON(STORAGE_KEYS.pinnedSummary, null);
}

export function savePinnedSummary(summaryPayload) {
  if (!summaryPayload || typeof summaryPayload !== 'object') {
    localStorage.removeItem(STORAGE_KEYS.pinnedSummary);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.pinnedSummary, JSON.stringify(summaryPayload));
}

export function clearPinnedSummary() {
  localStorage.removeItem(STORAGE_KEYS.pinnedSummary);
}

export function getIntermediateSummary() {
  return safeReadJSON(STORAGE_KEYS.intermediateSummary, null);
}

export function saveIntermediateSummary(summaryPayload) {
  if (!summaryPayload || typeof summaryPayload !== 'object') {
    localStorage.removeItem(STORAGE_KEYS.intermediateSummary);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.intermediateSummary, JSON.stringify(summaryPayload));
}

export function clearIntermediateSummary() {
  localStorage.removeItem(STORAGE_KEYS.intermediateSummary);
}

export async function exportConversationData() {
  const payloadData = buildConversationPayloadData();
  const payloadJson = stableStringify(payloadData);
  const payloadBase64 = utf8ToBase64(payloadJson);

  const unsignedEnvelope = buildUnsignedExportEnvelope(payloadBase64);

  const sha256 = await sha256Hex(
    stableStringify(unsignedEnvelope)
  );

  return {
    version: unsignedEnvelope.version,
    sha256,
    encoding: unsignedEnvelope.encoding,
    timestamp: unsignedEnvelope.timestamp,
    payload: unsignedEnvelope.payload
  };
}

export async function importConversationData(envelope) {
  await verifyExportEnvelopeHash(envelope);

  const payloadJson = base64ToUtf8(envelope.payload);
  const data = JSON.parse(payloadJson);

  applyImportedConversationData(data);
}

export async function importConversationDataFromRawText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('File non valido');
  }

  const envelope = JSON.parse(rawText);
  await importConversationData(envelope);
}