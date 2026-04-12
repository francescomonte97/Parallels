export const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

export function normalizeString(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

export function normalizeRole(role) {
  return role === 'user' ? 'user' : 'lipu';
}

export function formatTime(totalSeconds) {
  const min = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const sec = String(totalSeconds % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

export function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
}

export function clamp(value, min = 0, max = 10) {
  return Math.max(min, Math.min(max, value));
}

export function safeParseJSON(text) {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Conversione base64 fallita'));
        return;
      }
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}