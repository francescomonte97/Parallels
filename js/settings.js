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

export function syncUserProfileInputs() {
  dom.userProfileInputs.forEach(input => {
    input.checked = input.value === state.activeUserProfileId;
  });
}

export function openSettingsModal() {
  if (!dom.settingsModal) return;

  syncUserProfileInputs();

  dom.replyModeInputs.forEach(input => {
    input.checked = input.value === state.lipuReplyMode;
  });

  dom.settingsModal.classList.remove('hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'false');
  dom.settingsModal.removeAttribute('inert');
  document.body.classList.add('modal-open');
}

export function closeSettingsModal() {
  if (!dom.settingsModal) return;

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  dom.settingsModal.classList.add('hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'true');
  dom.settingsModal.setAttribute('inert', '');
  document.body.classList.remove('modal-open');

  dom.settingsTrigger?.focus();
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

async function readRawFile(file) {
  return await file.text();
}

export function bindSettingsEvents() {
  if (dom.settingsTrigger) {
    dom.settingsTrigger.addEventListener('click', openSettingsModal);

    dom.settingsTrigger.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSettingsModal();
      }
    });
  }

  dom.settingsBackdrop?.addEventListener('click', closeSettingsModal);

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
}