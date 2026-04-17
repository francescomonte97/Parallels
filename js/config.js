export const WORKER_BASE_URL = 'https://crimson-firefly-cf7f.montefortefrancesco50.workers.dev';


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
  lastProfileChange: 'lipu_last_profile_change',
  particleTheme: 'lipu_particle_theme'
};


export const DEFAULT_REPLY_MODE = 'text';
export const DEFAULT_PROFILE_ID = 'tommi';

export const CLAUDE_MAIN_MODEL = 'claude-sonnet-4-6';
export const CLAUDE_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
export const CLAUDE_MAIN_TEMPERATURE = 0.85;
export const CLAUDE_FAST_MODEL = 'claude-haiku-4-5-20251001';
export const CLAUDE_FAST_TEMPERATURE = 0.5;
export const CLAUDE_SUMMARY_TEMPERATURE = 0.2;
