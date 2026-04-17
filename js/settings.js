import { dom } from './dom.js';
import { STORAGE_KEYS } from './config.js';
import {
  state,
  setActiveProfile,
  setReplyMode,
  exportConversationData,
  importConversationDataFromRawText
} from './state.js';
import { LIPU_USER_PROFILES } from './profiles.js';

const KNOWN_FACES_JSON_PATH = './js/known-faces.json';
const KNOWN_FACES_OVERRIDE_KEY = 'lipu_known_faces_override';
const KNOWN_FACES_DIRTY_KEY = 'lipu_known_faces_dirty';

let knownFacesCache = null;
let faceApiModelsReadyPromise = null;
let pendingKnownFacesExport = null;
let settingsCloseTimer = null;
let synapseCloseTimer = null;
let selectedParticleTheme = null;
let particleThemeControlsBound = false;

const FACE_API_MODELS_PATH = './models';
const DEFAULT_PARTICLE_THEME_ID = 'default';
const DEFAULT_PARTICLE_BG = ['#070b14', '#090d18', '#101626'];
const PARTICLE_THEME_PRESETS = [
  {
    id: DEFAULT_PARTICLE_THEME_ID,
    name: 'Default',
    particle: [246, 247, 251],
    line: [226, 232, 240],
    accent: [140, 231, 212],
    reply: [154, 174, 255],
    audio: [255, 196, 122]
  },
  {
    id: 'fire',
    name: 'Fire',
    particle: [255, 245, 218],
    line: [255, 78, 34],
    accent: [255, 36, 12],
    reply: [255, 142, 28],
    audio: [255, 224, 82]
  },
  {
    id: 'love',
    name: 'Love',
    particle: [255, 241, 250],
    line: [255, 107, 190],
    accent: [255, 54, 156],
    reply: [255, 146, 207],
    audio: [255, 205, 226]
  },
  {
    id: 'blood',
    name: 'Blood',
    particle: [255, 240, 246],
    line: [255, 52, 98],
    accent: [255, 20, 76],
    reply: [88, 232, 255],
    audio: [255, 184, 80]
  },
  {
    id: 'ocean',
    name: 'Ocean',
    particle: [226, 252, 255],
    line: [73, 220, 232],
    accent: [50, 202, 222],
    reply: [96, 136, 255],
    audio: [143, 255, 212]
  },
  {
    id: 'ghost',
    name: 'Ghost',
    particle: [245, 241, 255],
    line: [172, 152, 255],
    accent: [148, 116, 255],
    reply: [116, 231, 255],
    audio: [255, 205, 246]
  },
  {
    id: 'gold',
    name: 'Gold',
    particle: [255, 248, 226],
    line: [255, 205, 96],
    accent: [255, 181, 46],
    reply: [134, 216, 255],
    audio: [255, 236, 160]
  }
];

export function syncUserProfileInputs() {
  dom.userProfileInputs.forEach(input => {
    input.checked = input.value === state.activeUserProfileId;
  });
}

export function openSettingsModal() {
  if (!dom.settingsModal) return;

  window.clearTimeout(settingsCloseTimer);

  syncUserProfileInputs();

  dom.replyModeInputs.forEach(input => {
    input.checked = input.value === state.lipuReplyMode;
  });

  selectedParticleTheme = readParticleThemePreference();
  renderParticleThemePalette();

  dom.settingsModal.classList.remove('closing', 'backdrop-close');
  dom.settingsModal.classList.remove('hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'false');
  dom.settingsModal.removeAttribute('inert');
  document.body.classList.add('modal-open');
  document.body.classList.remove('modal-closing');
}

export function closeSettingsModal(reason = 'close') {
  if (!dom.settingsModal) return;
  if (dom.settingsModal.classList.contains('hidden')) return;

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  window.clearTimeout(settingsCloseTimer);
  dom.settingsModal.classList.toggle('backdrop-close', reason === 'backdrop');
  dom.settingsModal.classList.add('closing');
  dom.settingsModal.setAttribute('aria-hidden', 'true');
  dom.settingsModal.setAttribute('inert', '');
  document.body.classList.add('modal-closing');

  settingsCloseTimer = window.setTimeout(() => {
    dom.settingsModal.classList.add('hidden');
    dom.settingsModal.classList.remove('closing', 'backdrop-close');
    document.body.classList.remove('modal-open', 'modal-closing');

    dom.settingsTrigger?.focus();

    // 🔥 Reset face enrollment UI on close
    try {
      clearEnrollFacePreview();
      setEnrollFaceStatus('');

      if (dom.enrollFaceInput) {
        dom.enrollFaceInput.value = '';
      }

      if (dom.enrollFaceGenerateBtn) {
        dom.enrollFaceGenerateBtn.disabled = false;
      }

      if (dom.enrollFaceExportBtn) {
        dom.enrollFaceExportBtn.disabled = !hasKnownFacesDirtyFlag();
      }
    } catch (err) {
      console.warn('Reset UI enrollment fallito:', err);
    }
  }, 280);
}

function openSynapseModal() {
  if (!dom.synapseModal) return;

  window.clearTimeout(synapseCloseTimer);
  dom.synapseModal.classList.remove('closing', 'backdrop-close');
  dom.synapseModal.classList.remove('hidden');
  dom.synapseModal.setAttribute('aria-hidden', 'false');
  dom.synapseModal.removeAttribute('inert');
  document.body.classList.add('modal-open');
  document.body.classList.remove('modal-closing');
}

function closeSynapseModal(reason = 'close') {
  if (!dom.synapseModal) return;
  if (dom.synapseModal.classList.contains('hidden')) return;

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  window.clearTimeout(synapseCloseTimer);
  dom.synapseModal.classList.toggle('backdrop-close', reason === 'backdrop');
  dom.synapseModal.classList.add('closing');
  dom.synapseModal.setAttribute('aria-hidden', 'true');
  dom.synapseModal.setAttribute('inert', '');
  document.body.classList.add('modal-closing');

  synapseCloseTimer = window.setTimeout(() => {
    dom.synapseModal.classList.add('hidden');
    dom.synapseModal.classList.remove('closing', 'backdrop-close');
    document.body.classList.remove('modal-open', 'modal-closing');
    dom.synapseTrigger?.focus();
  }, 280);
}

function confirmProfileChange() {
  return new Promise(resolve => {
    const modal = dom.confirmProfileModal;
    const backdrop = dom.confirmProfileBackdrop;
    const cancelBtn = dom.confirmProfileCancel;
    const confirmBtn = dom.confirmProfileConfirm;

    if (!modal || !cancelBtn || !confirmBtn) {
      resolve(
        window.confirm(
          'Cambiare profilo cancellerà memoria, relazione e stato attuale. Vuoi continuare?'
        )
      );
      return;
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    const cleanup = () => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      backdrop?.removeEventListener('click', onCancel);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    backdrop?.addEventListener('click', onCancel);
  });
}

function clearProfileDependentState() {
  localStorage.removeItem(STORAGE_KEYS.relationshipState);
  localStorage.removeItem(STORAGE_KEYS.relationshipTheme);
  localStorage.removeItem(STORAGE_KEYS.workingMemory);
  localStorage.removeItem(STORAGE_KEYS.conversationHistory);
  localStorage.removeItem(STORAGE_KEYS.sessionSummary);
  localStorage.removeItem(STORAGE_KEYS.pinnedSummary);
  localStorage.removeItem(STORAGE_KEYS.intermediateSummary);
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

function clampColorChannel(value, fallback = 255) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function normalizeRgb(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    clampColorChannel(value[0], fallback[0]),
    clampColorChannel(value[1], fallback[1]),
    clampColorChannel(value[2], fallback[2])
  ];
}

function normalizeParticleTheme(value = {}) {
  const fallback = PARTICLE_THEME_PRESETS[0];
  const source = value && typeof value === 'object' ? value : {};

  return {
    id: String(source.id || fallback.id).trim() || fallback.id,
    name: String(source.name || fallback.name).trim() || fallback.name,
    bg: [...DEFAULT_PARTICLE_BG],
    particle: normalizeRgb(source.particle, fallback.particle),
    line: normalizeRgb(source.line, fallback.line),
    accent: normalizeRgb(source.accent, fallback.accent),
    reply: normalizeRgb(source.reply, fallback.reply),
    audio: normalizeRgb(source.audio, fallback.audio)
  };
}

function readParticleThemePreference() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.particleTheme);
    const theme = raw ? normalizeParticleTheme(JSON.parse(raw)) : normalizeParticleTheme(PARTICLE_THEME_PRESETS[0]);
    const presetMatch = PARTICLE_THEME_PRESETS.find(preset =>
      preset.id === theme.id || preset.name.toLowerCase() === theme.name.toLowerCase()
    );
    return presetMatch ? normalizeParticleTheme(presetMatch) : theme;
  } catch (err) {
    console.warn('Preset particles non valido, uso default:', err);
    return normalizeParticleTheme(PARTICLE_THEME_PRESETS[0]);
  }
}

function writeParticleThemePreference(theme) {
  const safeTheme = normalizeParticleTheme(theme);
  localStorage.setItem(STORAGE_KEYS.particleTheme, JSON.stringify(safeTheme));
  return safeTheme;
}

function applyParticleTheme(theme, persist = true) {
  const safeTheme = persist ? writeParticleThemePreference(theme) : normalizeParticleTheme(theme);
  selectedParticleTheme = safeTheme;
  window.lipuParticles?.setTheme?.(safeTheme);
  renderParticleThemePalette();
  return safeTheme;
}

function getParticleThemeOptions() {
  const stored = readParticleThemePreference();
  const presets = PARTICLE_THEME_PRESETS.map(normalizeParticleTheme);
  const storedName = stored.name.toLowerCase();
  const exists = presets.some(preset =>
    preset.id === stored.id || preset.name.toLowerCase() === storedName
  );
  return exists ? presets : [stored, ...presets];
}

function rgbToCss(rgb, alpha = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function renderParticleThemePalette() {
  if (!dom.particleThemePalette) return;

  const current = selectedParticleTheme || readParticleThemePreference();
  const options = getParticleThemeOptions();
  dom.particleThemePalette.innerHTML = '';

  options.forEach(theme => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'particle-theme-card';
    item.classList.toggle('active', theme.id === current.id);
    item.dataset.themeId = theme.id;
    item.style.setProperty('--pt-bg-1', theme.bg[0]);
    item.style.setProperty('--pt-bg-2', theme.bg[1]);
    item.style.setProperty('--pt-line', rgbToCss(theme.line, 0.72));
    item.style.setProperty('--pt-dot', rgbToCss(theme.particle, 0.96));
    item.style.setProperty('--pt-accent', rgbToCss(theme.accent, 0.9));
    item.setAttribute('aria-label', `Seleziona preset particles ${theme.name}`);

    const preview = document.createElement('span');
    preview.className = 'particle-preview';
    preview.setAttribute('aria-hidden', 'true');

    ['particle-line line-a', 'particle-line line-b', 'particle-dot dot-a', 'particle-dot dot-b', 'particle-dot dot-c']
      .forEach(className => {
        const node = document.createElement('span');
        node.className = className;
        preview.appendChild(node);
      });

    const name = document.createElement('span');
    name.className = 'particle-theme-name';
    name.textContent = theme.name;

    item.appendChild(preview);
    item.appendChild(name);

    item.addEventListener('click', () => {
      applyParticleTheme(theme, true);
    });

    dom.particleThemePalette.appendChild(item);
  });
}

function setupParticleThemeControls() {
  selectedParticleTheme = readParticleThemePreference();
  window.lipuParticles?.setTheme?.(selectedParticleTheme);
  renderParticleThemePalette();

  if (particleThemeControlsBound) return;
  particleThemeControlsBound = true;

  dom.particleThemeSaveBtn?.addEventListener('click', () => {
    const saved = applyParticleTheme(selectedParticleTheme || readParticleThemePreference(), true);
    dom.particleThemeSaveBtn.textContent = 'Salvato';
    window.setTimeout(() => {
      if (dom.particleThemeSaveBtn) dom.particleThemeSaveBtn.textContent = 'Salva';
    }, 1100);
    return saved;
  });

  dom.particleThemeExportBtn?.addEventListener('click', () => {
    const theme = selectedParticleTheme || readParticleThemePreference();
    downloadJSON(`lipu-particles-${theme.id}.json`, {
      type: 'lipu-particle-theme',
      version: 1,
      theme
    });
  });

  dom.particleThemeImportBtn?.addEventListener('click', () => {
    dom.particleThemeImportInput?.click();
  });

  dom.particleThemeImportInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const json = JSON.parse(await file.text());
      const theme = normalizeParticleTheme(json.theme || json);
      theme.id = theme.id === DEFAULT_PARTICLE_THEME_ID ? `custom-${Date.now()}` : theme.id;
      theme.name = theme.name || 'Custom';
      applyParticleTheme(theme, true);
    } catch (err) {
      console.error('Errore import preset particles:', err);
      alert(err?.message || 'Preset particles non valido.');
    } finally {
      e.target.value = '';
    }
  });
}

function buildUnsignedKnownFacesPayload(database) {
  const activeDb = ensureKnownFacesShape(database);

  return {
    version: activeDb.version,
    engine: activeDb.engine,
    descriptorLength: activeDb.descriptorLength,
    metric: activeDb.metric,
    thresholds: activeDb.thresholds,
    people: activeDb.people
  };
}

async function signKnownFacesPayload(database) {
  const unsignedPayload = buildUnsignedKnownFacesPayload(database);
  const sha256 = await sha256Hex(stableStringify(unsignedPayload));

  return {
    sha256,
    ...unsignedPayload
  };
}

function stripKnownFacesHash(payload) {
  const { sha256, ...unsignedPayload } = payload || {};
  return unsignedPayload;
}

async function verifyKnownFacesPayloadHash(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('File embeddings non valido');
  }

  const expectedHash =
    typeof payload.sha256 === 'string'
      ? payload.sha256.trim().toLowerCase()
      : '';

  if (!expectedHash) {
    throw new Error('Integrità embeddings non valida');
  }

  const unsignedPayload = stripKnownFacesHash(payload);
  const actualHash = await sha256Hex(stableStringify(unsignedPayload));

  if (actualHash !== expectedHash) {
    throw new Error('Integrità embeddings non valida');
  }
}

async function exportKnownFacePerson(person, database) {
  const safePerson = {
    id: String(person?.id || '').trim(),
    label: String(person?.label || person?.id || '').trim(),
    embeddings: Array.isArray(person?.embeddings) ? person.embeddings : []
  };

  if (!safePerson.id || !safePerson.embeddings.length) {
    throw new Error('Nessun embedding disponibile per questa persona.');
  }

  const activeDb = ensureKnownFacesShape(database || knownFacesCache || pendingKnownFacesExport);
  const payload = await signKnownFacesPayload({
    version: activeDb.version,
    engine: activeDb.engine,
    descriptorLength: activeDb.descriptorLength,
    metric: activeDb.metric,
    thresholds: activeDb.thresholds,
    people: [safePerson]
  });
  const filename = `known-face-${safePerson.id}.json`;
  downloadJSON(filename, payload);
}

async function readRawFile(file) {
  return await file.text();
}

function getEnrollDom() {
  return {
    nameInput:
      dom.enrollFaceNameInput || document.getElementById('enroll-face-name-input'),
    peopleList:
      dom.enrollFacePeopleList || document.getElementById('enroll-face-people-list'),
    progressWrap:
      dom.enrollFaceProgressWrap || document.getElementById('enroll-face-progress-wrap'),
    progressBar:
      dom.enrollFaceProgressBar || document.getElementById('enroll-face-progress-bar'),
    progressText:
      dom.enrollFaceProgressText || document.getElementById('enroll-face-progress-text'),
    deleteBtn:
      dom.enrollFaceDeleteBtn || document.getElementById('enroll-face-delete-btn')
  };
}

function slugifyPersonId(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

function readKnownFacesOverride() {
  try {
    const raw = localStorage.getItem(KNOWN_FACES_OVERRIDE_KEY);
    if (!raw) return null;
    return ensureKnownFacesShape(JSON.parse(raw));
  } catch (err) {
    console.warn('Override known faces non valido, ignorato:', err);
    return null;
  }
}

function saveKnownFacesOverride(database) {
  const safe = ensureKnownFacesShape(database);

  // 🔥 save to local storage
  console.warn('[FACES] saving LOCAL override', safe);
  localStorage.setItem(KNOWN_FACES_OVERRIDE_KEY, JSON.stringify(safe));
  localStorage.setItem(KNOWN_FACES_DIRTY_KEY, 'true');

  window.dispatchEvent(new Event('knownFacesUpdated'));

  // 🔥 IMPORTANT: invalidate cache so next read uses updated embeddings
  knownFacesCache = null;
  pendingKnownFacesExport = safe;

  return safe;
}

function clearKnownFacesDirtyFlag() {
  localStorage.removeItem(KNOWN_FACES_DIRTY_KEY);
}

function hasKnownFacesDirtyFlag() {
  return localStorage.getItem(KNOWN_FACES_DIRTY_KEY) === 'true';
}

function setEnrollmentProgress(current = 0, total = 0, text = '') {
  const { progressWrap, progressBar, progressText } = getEnrollDom();
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.max(0, Math.min(safeTotal || 0, Number(current) || 0));
  const percent = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * 100) : 0;

  if (progressWrap) {
    progressWrap.classList.toggle('hidden', !safeTotal && !text);
  }

  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }

  if (progressText) {
    progressText.textContent = text || (safeTotal ? `${safeCurrent}/${safeTotal} · ${percent}%` : '');
  }
}

function resetEnrollmentProgress() {
  setEnrollmentProgress(0, 0, '');
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

function averagePairwiseSimilarity(embeddings = []) {
  if (!Array.isArray(embeddings) || embeddings.length < 2) {
    return { average: 1, min: 1, pairs: 0 };
  }

  let total = 0;
  let pairs = 0;
  let min = Infinity;

  for (let i = 0; i < embeddings.length; i += 1) {
    for (let j = i + 1; j < embeddings.length; j += 1) {
      const score = cosineSimilarity(embeddings[i], embeddings[j]);
      total += score;
      pairs += 1;
      if (score < min) min = score;
    }
  }

  return {
    average: pairs ? total / pairs : 1,
    min: Number.isFinite(min) ? min : 1,
    pairs
  };
}

function computeEmbeddingStats(embeddings = []) {
  if (!Array.isArray(embeddings) || embeddings.length < 2) return null;

  const sims = [];

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const a = normalizeEmbeddingVector(embeddings[i]);
      const b = normalizeEmbeddingVector(embeddings[j]);

      if (a.length && b.length) {
        sims.push(cosineSimilarity(a, b));
      }
    }
  }

  if (!sims.length) return null;

  const avg = sims.reduce((s, v) => s + v, 0) / sims.length;
  const variance = sims.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / sims.length;
  const std = Math.sqrt(variance);

  return {
    avg,
    std,
    avgPercent: Math.round(avg * 100),
    stdPercent: Math.round(std * 100)
  };
}

function renderKnownFacesPeopleList(database = null) {
  const { peopleList, deleteBtn, nameInput } = getEnrollDom();
  if (!peopleList) return;

  const activeDb = ensureKnownFacesShape(database || knownFacesCache);
  const people = Array.isArray(activeDb.people) ? activeDb.people : [];

  peopleList.innerHTML = '';

  if (!people.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-helper-text';
    empty.textContent = 'Nessuna persona embeddata al momento.';
    peopleList.appendChild(empty);
  } else {
    people
      .slice()
      .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id, 'it'))
      .forEach(person => {
        // --- Begin new per-person UI block with inline trash icon ---
        const isUserCreated = true; // 🔥 attualmente tutte le override sono user-generated

        const item = document.createElement('div');
        item.className = 'settings-action-btn';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'space-between';
        item.dataset.personId = person.id;

        const label = document.createElement('span');
        label.className = 'face-person-label';
        const stats = computeEmbeddingStats(person.embeddings || []);
        if (stats) {
          label.textContent = `${person.label || person.id} · μ ${stats.avgPercent}% · σ ${stats.stdPercent}%`;
        } else {
          label.textContent = `${person.label || person.id} · ${Array.isArray(person.embeddings) ? person.embeddings.length : 0}`;
        }

        item.appendChild(label);

        if (isUserCreated) {
          const actions = document.createElement('div');
          actions.className = 'face-person-actions';

          const exportBtnInline = document.createElement('button');
          exportBtnInline.type = 'button';
          exportBtnInline.className = 'face-icon-btn face-export-btn';
          exportBtnInline.setAttribute('aria-label', `Esporta embeddings di ${person.label || person.id}`);
          exportBtnInline.title = 'Esporta embeddings';
          exportBtnInline.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v11m0-11 4 4m-4-4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          `;

          exportBtnInline.addEventListener('click', async (e) => {
            e.stopPropagation();

            try {
              await exportKnownFacePerson(person, activeDb);
              setEnrollFaceStatus(`Embeddings esportati per ${person.label || person.id}.`);
            } catch (err) {
              console.error(err);
              setEnrollFaceStatus(err?.message || 'Errore durante l’export della persona.');
            }
          });

          const deleteBtnInline = document.createElement('button');
          deleteBtnInline.type = 'button';
          deleteBtnInline.className = 'face-icon-btn face-delete-btn';
          deleteBtnInline.setAttribute('aria-label', `Elimina embeddings di ${person.label || person.id}`);
          deleteBtnInline.title = 'Elimina embeddings';
          deleteBtnInline.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          `;

          deleteBtnInline.addEventListener('click', (e) => {
            e.stopPropagation();

            const confirmed = window.confirm(`Eliminare ${person.label || person.id}?`);
            if (!confirmed) return;

            try {
              const saved = deleteKnownFacePerson(person.id);
              setEnrollFaceStatus('Persona eliminata.');
              renderKnownFacesPeopleList(saved);
            } catch (err) {
              console.error(err);
              setEnrollFaceStatus(err?.message || 'Errore eliminazione.');
            }
          });

          actions.appendChild(exportBtnInline);
          actions.appendChild(deleteBtnInline);
          item.appendChild(actions);
        }

        item.addEventListener('click', () => {
          if (nameInput) {
            nameInput.value = person.label || person.id;
          }
        });

        peopleList.appendChild(item);
        // --- End new per-person UI block ---
      });
  }

  if (deleteBtn) {
    deleteBtn.style.display = 'none';
  }
}

function setEnrollFaceStatus(text = '') {
  if (!dom.enrollFaceStatus) return;
  dom.enrollFaceStatus.textContent = text;
}

function clearEnrollFacePreview() {
  if (dom.enrollFacePreview) {
    dom.enrollFacePreview.innerHTML = '';
  }

  if (dom.enrollFaceCrops) {
    dom.enrollFaceCrops.innerHTML = '';
  }

  resetEnrollmentProgress();
}

function normalizeEmbeddingVector(values = []) {
  const vector = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  if (!vector.length) return [];

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) return [];

  return vector.map(value => Number((value / norm).toFixed(8)));
}

function ensureKnownFacesShape(data) {
  if (!data || typeof data !== 'object') {
    return {
      version: 2,
      engine: 'face-api.js',
      descriptorLength: 128,
      metric: 'cosine',
      thresholds: {
        known: 0.42,
        uncertain: 0.32,
        minMarginKnown: 0.03,
        minMarginUncertain: 0.015,
        minEnrollmentPhotos: 5,
        minEnrollmentSimilarity: 0.45,
        minEnrollmentPairSimilarity: 0.3
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
      known: Number(data?.thresholds?.known) || 0.42,
      uncertain: Number(data?.thresholds?.uncertain) || 0.32,
      minMarginKnown: Number(data?.thresholds?.minMarginKnown) || 0.03,
      minMarginUncertain: Number(data?.thresholds?.minMarginUncertain) || 0.015,
      minEnrollmentPhotos: Number(data?.thresholds?.minEnrollmentPhotos) || 5,
      minEnrollmentSimilarity: Number(data?.thresholds?.minEnrollmentSimilarity) || 0.45,
      minEnrollmentPairSimilarity: Number(data?.thresholds?.minEnrollmentPairSimilarity) || 0.3
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

  const override = readKnownFacesOverride();

  // 🔥 PRIORITY: if override exists → always use it (local embeddings)
  if (override && Array.isArray(override.people) && override.people.length) {
    knownFacesCache = override;
    pendingKnownFacesExport = override;
console.warn('[FACES] using LOCAL override', override);

    // mark dirty if not already (ensures UI consistency)
    if (!hasKnownFacesDirtyFlag()) {
      localStorage.setItem(KNOWN_FACES_DIRTY_KEY, 'true');
    }

    return knownFacesCache;
  }

  try {
    const response = await fetch(`${KNOWN_FACES_JSON_PATH}?t=${Date.now()}`, {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    console.warn('[FACES] using JSON database', data);
    knownFacesCache = ensureKnownFacesShape(data);
    pendingKnownFacesExport = knownFacesCache;

    return knownFacesCache;
  } catch (err) {
    console.warn('Impossibile caricare known-faces.json, uso fallback vuoto:', err);
    knownFacesCache = ensureKnownFacesShape(null);
    pendingKnownFacesExport = knownFacesCache;
    return knownFacesCache;
  }
}

function getSelectedEnrollFacePersonId() {
  const { nameInput } = getEnrollDom();
  return slugifyPersonId(nameInput?.value || dom.enrollFaceSelect?.value || '');
}

function getPersonEntry(database, personId) {
  if (!database || !Array.isArray(database.people) || !personId) return null;
  return database.people.find(person => person.id === personId) || null;
}

function getOrCreatePersonEntry(database, personName = '') {
  const label = String(personName || '').trim();
  const id = slugifyPersonId(label);
  if (!database || !Array.isArray(database.people) || !id || !label) return null;

  let person = database.people.find(item => item.id === id) || null;
  if (!person) {
    person = {
      id,
      label,
      embeddings: []
    };
    database.people.push(person);
  } else if (!person.label) {
    person.label = label;
  }

  return person;
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

async function fileToImageElement(file) {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Impossibile leggere immagine: ${file.name}`));
    };

    img.src = url;
  });
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
        inputSize: 512,
        scoreThreshold: 0.25
      })
    )
    .withFaceLandmarks(true)
    .withFaceDescriptor();

  if (!result?.descriptor) {
    return [];
  }

  return normalizeEmbeddingVector(Array.from(result.descriptor));
}

function renderEnrollmentPreview(results = []) {
  if (!dom.enrollFacePreview || !dom.enrollFaceCrops) return;

  dom.enrollFacePreview.innerHTML = '';
  dom.enrollFaceCrops.innerHTML = '';

  results.forEach((result, index) => {
    const originalWrap = document.createElement('div');
    originalWrap.className = 'face-crop-item';
    originalWrap.style.display = 'flex';
    originalWrap.style.flexDirection = 'column';
    originalWrap.style.alignItems = 'center';
    originalWrap.style.gap = '4px';

    const originalImg = document.createElement('img');
    originalImg.src = result.previewUrl;
    originalImg.alt = `Input ${index + 1}`;
    originalImg.className = 'face-crop-image';
    originalImg.style.width = '72px';
    originalImg.style.height = '72px';
    originalImg.style.objectFit = 'cover';
    originalImg.style.borderRadius = '10px';

    const originalLabel = document.createElement('span');
    originalLabel.className = 'face-crop-label';
    originalLabel.textContent = result.fileName || `Input ${index + 1}`;
    originalLabel.style.fontSize = '11px';
    originalLabel.style.color = 'rgba(255,255,255,0.68)';

    originalWrap.appendChild(originalImg);
    originalWrap.appendChild(originalLabel);
    dom.enrollFacePreview.appendChild(originalWrap);

    const cropWrap = document.createElement('div');
    cropWrap.className = 'face-crop-item';
    cropWrap.style.display = 'flex';
    cropWrap.style.flexDirection = 'column';
    cropWrap.style.alignItems = 'center';
    cropWrap.style.gap = '4px';

    const cropImg = document.createElement('img');
    cropImg.src = result.cropUrl;
    cropImg.alt = `Crop ${index + 1}`;
    cropImg.className = 'face-crop-image';
    cropImg.style.width = '72px';
    cropImg.style.height = '72px';
    cropImg.style.objectFit = 'cover';
    cropImg.style.borderRadius = '10px';

    const cropLabel = document.createElement('span');
    cropLabel.className = 'face-crop-label';
    cropLabel.textContent = `embedding #${index + 1}`;
    cropLabel.style.fontSize = '11px';
    cropLabel.style.color = 'rgba(255,255,255,0.68)';

    cropWrap.appendChild(cropImg);
    cropWrap.appendChild(cropLabel);
    dom.enrollFaceCrops.appendChild(cropWrap);
  });
}

async function generateFaceEmbeddingsForSelectedPerson(files = []) {
  const { nameInput } = getEnrollDom();
  const personName = String(nameInput?.value || dom.enrollFaceSelect?.value || '').trim();
  const personId = slugifyPersonId(personName);

  if (!personId || !personName) {
    throw new Error('Inserisci il nome della persona.');
  }

  const inputFiles = Array.from(files).filter(Boolean);
  const database = await loadKnownFacesData();
  const thresholds = database?.thresholds || {};
  const minPhotos = Math.max(5, Number(thresholds?.minEnrollmentPhotos) || 5);
  // 🔥 stricter thresholds for higher quality embeddings
  const minSimilarity = Math.max(0.9, Number(thresholds?.minEnrollmentSimilarity) || 0.9);
  const minPairSimilarity = Math.max(0.85, Number(thresholds?.minEnrollmentPairSimilarity) || 0.85);

  if (inputFiles.length < minPhotos) {
    throw new Error(`Servono almeno ${minPhotos} foto.`);
  }

  const person = getOrCreatePersonEntry(database, personName);
  if (!person) {
    throw new Error('Impossibile creare o trovare la persona nel database');
  }

  const faceapi = window.faceapi;
  if (!faceapi) {
    throw new Error('face-api.js non disponibile nel browser');
  }

  await ensureFaceApiModels();

  const results = [];
  const newEmbeddings = [];
  const rejectedFiles = [];

  setEnrollmentProgress(0, inputFiles.length, 'Preparazione modelli...');

  for (let index = 0; index < inputFiles.length; index += 1) {
    const file = inputFiles[index];
    setEnrollmentProgress(index, inputFiles.length, `Analisi foto ${index + 1}/${inputFiles.length}...`);

    const imageElement = await fileToImageElement(file);

    const detections = await faceapi
      .detectAllFaces(
        imageElement,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: 512,
          scoreThreshold: 0.25
        })
      )
      .withFaceLandmarks(true)
      .withFaceDescriptors();

    if (!Array.isArray(detections) || detections.length !== 1) {
      rejectedFiles.push(`${file.name}: serve esattamente un solo volto per foto.`);
      continue;
    }

    const result = detections[0];
    const descriptor = Array.from(result?.descriptor || []);
    const embedding = normalizeEmbeddingVector(descriptor);

    if (!embedding.length) {
      rejectedFiles.push(`${file.name}: descriptor non valido.`);
      continue;
    }

    newEmbeddings.push(embedding);

    const box = result.detection.box;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(box.width));
    canvas.height = Math.max(1, Math.round(box.height));

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(
        imageElement,
        box.x,
        box.y,
        box.width,
        box.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }

    results.push({
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      cropUrl: canvas.toDataURL('image/png')
    });
  }

  setEnrollmentProgress(inputFiles.length, inputFiles.length, 'Validazione embeddings...');

  if (newEmbeddings.length < minPhotos) {
    throw new Error(
      `Sono valide solo ${newEmbeddings.length} foto.`
    );
  }

  const similarity = averagePairwiseSimilarity(newEmbeddings);
  if (similarity.average < minSimilarity || similarity.min < minPairSimilarity) {
    throw new Error(
      `Foto non coerenti · μ ${similarity.average.toFixed(2)} · min ${similarity.min.toFixed(2)}`
    );
  }

  person.embeddings = Array.isArray(person.embeddings) ? person.embeddings : [];
  person.embeddings.push(...newEmbeddings);

  const saved = saveKnownFacesOverride(database);
  renderEnrollmentPreview(results);
  renderKnownFacesPeopleList(saved);
  setEnrollmentProgress(inputFiles.length, inputFiles.length, 'Completato.');

  return {
    personLabel: person.label || person.id,
    added: newEmbeddings.length,
    total: person.embeddings.length,
    rejectedFiles,
    similarity
  };
}

function deleteKnownFacePerson(personId = '') {
  const safePersonId = slugifyPersonId(personId);
  if (!safePersonId) {
    throw new Error('Seleziona una persona da eliminare');
  }

  const database = ensureKnownFacesShape(knownFacesCache || pendingKnownFacesExport);
  const before = Array.isArray(database.people) ? database.people.length : 0;
  database.people = Array.isArray(database.people)
    ? database.people.filter(person => person.id !== safePersonId)
    : [];

  if (database.people.length === before) {
    throw new Error('Persona non trovata nel database locale');
  }

  const saved = saveKnownFacesOverride(database);
  // 🔥 If no people left, clear dirty flag (no pending changes)
  if (!Array.isArray(saved.people) || saved.people.length === 0) {
    clearKnownFacesDirtyFlag();
    pendingKnownFacesExport = null;
  }
  renderKnownFacesPeopleList(saved);
  return saved;
}

function bindFaceEnrollmentEvents() {
  const { nameInput, deleteBtn } = getEnrollDom();

  loadKnownFacesData()
    .then(database => {
      renderKnownFacesPeopleList(database);
        if (dom.enrollFaceExportBtn) {
          dom.enrollFaceExportBtn.disabled = false;
        }
       else {
        clearKnownFacesDirtyFlag();
        setEnrollFaceStatus('');
      }
    })
    .catch(err => {
      console.warn('Errore inizializzazione lista volti:', err);
    });

  nameInput?.addEventListener('input', () => {
    const currentId = slugifyPersonId(nameInput.value || '');
    if (deleteBtn) {
      deleteBtn.dataset.personId = currentId;
      const database = ensureKnownFacesShape(knownFacesCache || pendingKnownFacesExport);
      deleteBtn.disabled = !currentId || !database.people.some(person => person.id === currentId);
    }
  });

  dom.enrollFaceGenerateBtn?.addEventListener('click', () => {
    dom.enrollFaceInput?.click();
  });

  dom.enrollFaceInput?.addEventListener('change', async event => {
    const files = event.target.files;
    if (!files?.length) return;

    clearEnrollFacePreview();
    setEnrollFaceStatus('Generazione embeddings in corso...');
    dom.enrollFaceGenerateBtn.disabled = true;
    dom.enrollFaceExportBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;

    try {
      const result = await generateFaceEmbeddingsForSelectedPerson(files);
      setEnrollFaceStatus(
        `${result.personLabel} · +${result.added} → ${result.total} · μ ${result.similarity.average.toFixed(2)} · min ${result.similarity.min.toFixed(2)}`
      );
      dom.enrollFaceExportBtn.disabled = false;
      if (deleteBtn) {
        deleteBtn.disabled = false;
        deleteBtn.dataset.personId = slugifyPersonId(nameInput?.value || '');
      }
    } catch (err) {
      console.error('Errore enrollment volti:', err);
      setEnrollFaceStatus(err?.message || 'Errore durante la generazione degli embeddings.');
      resetEnrollmentProgress();
    } finally {
      dom.enrollFaceGenerateBtn.disabled = false;
      event.target.value = '';
    }
  });

  deleteBtn?.addEventListener('click', async () => {
    try {
      const currentId = slugifyPersonId(nameInput?.value || deleteBtn.dataset.personId || '');
      const currentLabel = String(nameInput?.value || currentId || '').trim();
      if (!currentId) {
        throw new Error('Inserisci o seleziona una persona da eliminare.');
      }

      const confirmed = window.confirm(
        `Vuoi eliminare tutti gli embeddings di ${currentLabel || currentId}? Questa modifica verrà salvata localmente e dovrai riesportare known-faces.json.`
      );
      if (!confirmed) return;

      const saved = deleteKnownFacePerson(currentId);
      if (nameInput) {
        nameInput.value = '';
      }
      clearEnrollFacePreview();
      setEnrollFaceStatus('Persona eliminata dal database locale. Esporta known-faces.json per rendere persistente la modifica nel progetto.');
      dom.enrollFaceExportBtn.disabled = false;
      deleteBtn.disabled = true;
      deleteBtn.dataset.personId = '';
      renderKnownFacesPeopleList(saved);
    } catch (err) {
      console.error('Errore eliminazione volti:', err);
      setEnrollFaceStatus(err?.message || 'Errore durante l’eliminazione della persona.');
    }
  });

  dom.enrollFaceExportBtn?.addEventListener('click', async () => {
    try {
      const database = pendingKnownFacesExport || (await loadKnownFacesData());
      const signedDatabase = await signKnownFacesPayload(database);
      downloadJSON('known-faces.json', signedDatabase);

      // 🔥 reset dirty + override (no more local changes after export)
      clearKnownFacesDirtyFlag();
      localStorage.removeItem(KNOWN_FACES_OVERRIDE_KEY);
      pendingKnownFacesExport = null;
      knownFacesCache = ensureKnownFacesShape(signedDatabase);

      setEnrollFaceStatus('');
    } catch (err) {
      console.error('Errore export known-faces:', err);
      setEnrollFaceStatus(err?.message || 'Errore durante l’esportazione di known-faces.json.');
    }
  });

  if (dom.enrollFaceExportBtn) {
    dom.enrollFaceExportBtn.disabled = !hasKnownFacesDirtyFlag();
  }

  if (deleteBtn) {
    deleteBtn.disabled = true;
  }
}


//  IMPORT KNOWN FACES
const importFacesBtn = document.getElementById('import-faces-btn');
const importFacesInput = document.getElementById('import-faces-input');

importFacesBtn?.addEventListener('click', () => {
  importFacesInput?.click();
});

importFacesInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);

    if (!json || !Array.isArray(json.people)) {
      throw new Error('Formato JSON non valido');
    }

    await verifyKnownFacesPayloadHash(json);
    const importedDatabase = ensureKnownFacesShape(json);

    const current = ensureKnownFacesShape(
      knownFacesCache || pendingKnownFacesExport
    );

    // 🔥 merge intelligente (no duplicati)
    const mergedPeople = [
      ...current.people,
      ...importedDatabase.people.filter(
        p => !current.people.some(c => c.id === p.id)
      )
    ];

    const merged = {
      ...current,
      people: mergedPeople
    };

    const saved = saveKnownFacesOverride(merged);

    renderKnownFacesPeopleList(saved);
    setEnrollFaceStatus('Import completato.');

    if (dom.enrollFaceExportBtn) {
      dom.enrollFaceExportBtn.disabled = false;
    }

  } catch (err) {
    console.error('Errore import known-faces:', err);
    setEnrollFaceStatus(
      err?.message || 'Errore durante l’import di known-faces.json.'
    );
  }

  e.target.value = '';
});





export function bindSettingsEvents() {
  setupParticleThemeControls();

  dom.synapseTrigger?.addEventListener('click', openSynapseModal);

  dom.synapseTrigger?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openSynapseModal();
    }
  });

  dom.synapseBackdrop?.addEventListener('click', () => closeSynapseModal('backdrop'));

  dom.synapseCloseBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    closeSynapseModal();
  });

  if (dom.settingsTrigger) {
    dom.settingsTrigger.addEventListener('click', openSettingsModal);

    dom.settingsTrigger.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSettingsModal();
      }
    });
  }

  dom.settingsBackdrop?.addEventListener('click', () => closeSettingsModal('backdrop'));

  dom.settingsCloseBtn?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    closeSettingsModal();
  });

  dom.replyModeInputs.forEach(input => {
    input.addEventListener('change', e => {
      setReplyMode(e.target.value);
      closeSettingsModal();
    });
  });

  dom.userProfileInputs.forEach(input => {
    input.addEventListener('change', async e => {
      const nextProfileId = e.target.value;

      if (!LIPU_USER_PROFILES[nextProfileId]) return;
      if (nextProfileId === state.activeUserProfileId) return;

      const confirmed = await confirmProfileChange();

      if (!confirmed) {
        syncUserProfileInputs();
        return;
      }

      clearProfileDependentState();
      localStorage.setItem(
        STORAGE_KEYS.lastProfileChange,
        JSON.stringify({
          from: state.activeUserProfileId,
          to: nextProfileId,
          at: Date.now()
        })
      );
      setActiveProfile(nextProfileId);
      window.location.reload();
    });
  });

  dom.exportMemoryBtn?.addEventListener('click', async () => {
    try {
      const payload = await exportConversationData();
      const profileId = state.activeUserProfileId || 'lipu';
      const timestamp = Date.now();
      const filename = `${profileId}-${timestamp}.json`;

      downloadJSON(filename, payload);
    } catch (err) {
      console.error('Errore export:', err);
      alert(err?.message || 'Errore durante l’esportazione dei dati.');
    }
  });

  dom.importMemoryBtn?.addEventListener('click', () => {
    dom.importMemoryInput?.click();
  });

  dom.importMemoryInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const confirmed = window.confirm(
        'Importando questi dati verranno sostituiti memoria conversazionale, stato relazione, tema e profilo attuale. Vuoi continuare?'
      );

      if (!confirmed) {
        e.target.value = '';
        return;
      }

      const rawText = await file.text();
await importConversationDataFromRawText(rawText);
window.location.reload();
    } catch (err) {
      console.error('Errore import:', err);
      alert(err?.message || 'File non valido o integrità engramma non valida.');
    } finally {
      e.target.value = '';
    }
  });
  bindFaceEnrollmentEvents();
}
