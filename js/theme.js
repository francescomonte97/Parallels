import { STORAGE_KEYS } from './config.js';

const STABLE_THEME = {
  id: 'premium-network',
  topGlow: 'rgba(54, 89, 116, 0.16)',
  bottomGlow: 'rgba(65, 46, 72, 0.12)'
};

export function getRelationshipTheme() {
  return STABLE_THEME;
}

export function applyRelationshipTheme(relationshipState) {
  const theme = getRelationshipTheme();
  localStorage.setItem(STORAGE_KEYS.relationshipTheme, JSON.stringify(theme));
  document.documentElement.style.setProperty('--rel-top-glow', theme.topGlow);
  document.documentElement.style.setProperty('--rel-bottom-glow', theme.bottomGlow);
}

export function restoreRelationshipTheme() {
  applyRelationshipTheme();
}
