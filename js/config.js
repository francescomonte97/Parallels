export const WORKER_BASE_URL = 'https://crimson-firefly-cf7f.montefortefrancesco50.workers.dev';

export const ELEVENLABS_API_KEY = "sk_55b4a8f4877874db16e8e4812fdc141cf00a7e4aadaab79d";
export const VOICE_ID = "3nl8Zsm1cUwx1jH59GZo";

export const MAX_CONVERSATION_HISTORY_MESSAGES = 500;

export const STORAGE_KEYS = {
  workingMemory: 'lipu_working_memory',
  relationshipState: 'lipu_relationship_state',
  relationshipTheme: 'lipu_relationship_theme',
  replyMode: 'lipu_reply_mode',
  activeProfile: 'lipu_active_user_profile',
  sessionSummary: 'lipu_session_summary',
  intermediateSummary: 'lipu_intermediate_summary',
  pinnedSummary: 'lipu_pinned_summary',
  conversationHistory: 'lipu_conversation_history',
  lastLipuImageAt: 'lipu_last_image_at'
};

export const DEFAULT_REPLY_MODE = 'audio';
export const DEFAULT_PROFILE_ID = 'tommi';

export const LIPU_FACE_REFERENCE_URL = './assets/lipu-face-reference.jpg';
export const LIPU_IMAGE_REPLY_ENABLED = true;
export const LIPU_IMAGE_REPLY_CHANCE = 1;
export const LIPU_IMAGE_REPLY_MIN_TURNS = 0;
export const LIPU_IMAGE_REPLY_MIN_INTERVAL_MS = 0