import { restoreActiveUserProfile } from './state.js';
import { restoreRelationshipTheme, applyRelationshipTheme } from './theme.js';
import { bindSettingsEvents, syncUserProfileInputs } from './settings.js';
import { bindEvents } from './handlers.js';
import { loadLongTermMemory, getRelationshipState } from './services.js';

async function init() {
  restoreActiveUserProfile();
  syncUserProfileInputs();
  restoreRelationshipTheme();

  await loadLongTermMemory();

  bindEvents();
  bindSettingsEvents();

  applyRelationshipTheme(getRelationshipState());
}

init();