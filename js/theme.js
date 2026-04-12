import { STORAGE_KEYS } from './config.js';

export function getRelationshipTheme(state) {
  const trust = state?.trust || 0;
  const intimacy = state?.intimacy || 0;
  const tension = state?.tension || 0;
  const provocation = state?.provocation || 0;
  const familiarity = state?.familiarity || 0;

  if (tension >= 6 || provocation >= 6) {
    return {
      id: 'tense',
      topGlow: 'rgba(90, 28, 36, 0.22)',
      bottomGlow: 'rgba(55, 18, 26, 0.14)'
    };
  }

  if (intimacy >= 6 || trust >= 6) {
    return {
      id: 'intimate',
      topGlow: 'rgba(52, 34, 88, 0.22)',
      bottomGlow: 'rgba(28, 22, 60, 0.14)'
    };
  }

  if (familiarity >= 5) {
    return {
      id: 'familiar',
      topGlow: 'rgba(30, 52, 98, 0.20)',
      bottomGlow: 'rgba(18, 34, 70, 0.12)'
    };
  }

  return {
    id: 'neutral',
    topGlow: 'rgba(22, 44, 92, 0.16)',
    bottomGlow: 'rgba(14, 28, 56, 0.10)'
  };
}

export function applyRelationshipTheme(relationshipState) {
  const theme = getRelationshipTheme(relationshipState);
  localStorage.setItem(STORAGE_KEYS.relationshipTheme, JSON.stringify(theme));
  document.documentElement.style.setProperty('--rel-top-glow', theme.topGlow);
  document.documentElement.style.setProperty('--rel-bottom-glow', theme.bottomGlow);
}

export function restoreRelationshipTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.relationshipTheme) || 'null');
    if (!saved) return;
    document.documentElement.style.setProperty('--rel-top-glow', saved.topGlow);
    document.documentElement.style.setProperty('--rel-bottom-glow', saved.bottomGlow);
  } catch {}
}