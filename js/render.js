import { dom } from './dom.js';
import { formatAudioTime } from './utils.js';

export function appendToChat(node) {
  dom.chatBox.appendChild(node);
  dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}

export function createAvatar() {
  const avatar = document.createElement('img');
  avatar.src = './lipu-profile.png';
  avatar.alt = 'LIPU';
  avatar.className = 'message-avatar';
  return avatar;
}

export function renderMessage(role, text) {
  const safeRole = role === 'user' ? 'user' : 'lipu';

  const row = document.createElement('div');
  row.className = `message-row ${safeRole} message-enter`;

  if (safeRole === 'lipu') {
    row.appendChild(createAvatar());
  }

  const msg = document.createElement('div');
  msg.className = `message ${safeRole === 'user' ? 'user-msg' : 'lipu-msg'}`;
  msg.textContent = text;

  row.appendChild(msg);
  appendToChat(row);
}

export function renderImageMessage(role, imageSource) {
  const safeRole = role === 'user' ? 'user' : 'lipu';

  const row = document.createElement('div');
  row.className = `message-row ${safeRole} message-enter`;

  if (safeRole === 'lipu') {
    row.appendChild(createAvatar());
  }

  const bubble = document.createElement('div');
  bubble.className = `message ${safeRole === 'user' ? 'user-msg' : 'lipu-msg'}`;

  const img = document.createElement('img');
  img.src = imageSource;
  img.alt = 'Immagine inviata';
  img.className = 'chat-image';
  img.loading = 'lazy';

  bubble.appendChild(img);
  row.appendChild(bubble);
  appendToChat(row);
}

function createPlayIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5Z"></path>
    </svg>
  `;
}

function createPauseIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z"></path>
    </svg>
  `;
}

function createShareIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M8 8l4-4 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 14v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;
}

function stopAllOtherPlayers(currentAudio, currentPlayer) {
  document.querySelectorAll('.audio-player audio').forEach(other => {
    if (other !== currentAudio) {
      other.pause();
    }
  });

  document.querySelectorAll('.audio-player').forEach(player => {
    if (player !== currentPlayer) {
      player.classList.remove('playing');
      const btn = player.querySelector('.audio-play-btn');
      if (btn) {
        btn.innerHTML = createPlayIcon();
      }
    }
  });
}

async function shareAudioFile(audioSource) {
  try {
    const response = await fetch(audioSource);
    const blob = await response.blob();

    const extension = blob.type.includes('mpeg')
      ? 'mp3'
      : blob.type.includes('ogg')
      ? 'ogg'
      : blob.type.includes('wav')
      ? 'wav'
      : 'webm';

    const file = new File([blob], `lipu-audio.${extension}`, {
      type: blob.type || 'audio/webm'
    });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'Audio LIPU',
        text: 'Condivido un messaggio audio'
      });
      return;
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    console.error('Errore condivisione audio:', err);
  }
}

function createCustomAudioPlayer(audioSource) {
  const player = document.createElement('div');
  player.className = 'audio-player';

  const audio = document.createElement('audio');
  audio.src = audioSource;
  audio.preload = 'auto';

  const playBtn = document.createElement('button');
  playBtn.className = 'audio-play-btn';
  playBtn.type = 'button';
  playBtn.innerHTML = createPlayIcon();
  playBtn.setAttribute('aria-label', 'Riproduci audio');

  const main = document.createElement('div');
  main.className = 'audio-player-main';

  const topRow = document.createElement('div');
  topRow.className = 'audio-top-row';

  const progressWrap = document.createElement('div');
  progressWrap.className = 'audio-progress-wrap';

  const progress = document.createElement('div');
  progress.className = 'audio-progress';
  progressWrap.appendChild(progress);

  const time = document.createElement('div');
  time.className = 'audio-time';
  time.textContent = '0:00 / 0:00';

  topRow.appendChild(progressWrap);
  topRow.appendChild(time);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'audio-bottom-row';

  const eq = document.createElement('div');
  eq.className = 'audio-eq';
  eq.innerHTML = '<span></span><span></span><span></span><span></span>';

  bottomRow.appendChild(eq);

  const shareBtn = document.createElement('button');
  shareBtn.className = 'audio-share-btn';
  shareBtn.type = 'button';
  shareBtn.setAttribute('aria-label', 'Condividi audio');
  shareBtn.innerHTML = createShareIcon();

  main.appendChild(topRow);
  main.appendChild(bottomRow);

  player.appendChild(playBtn);
  player.appendChild(main);
  player.appendChild(shareBtn);
  player.appendChild(audio);

  function updateTimeUI() {
    const current = formatAudioTime(audio.currentTime);
    const total = formatAudioTime(audio.duration);
    time.textContent = `${current} / ${total}`;

    const pct = audio.duration && Number.isFinite(audio.duration)
      ? (audio.currentTime / audio.duration) * 100
      : 0;

    progress.style.width = `${pct}%`;
  }

  function setPlayingUI(isPlaying) {
    player.classList.toggle('playing', isPlaying);
    playBtn.innerHTML = isPlaying ? createPauseIcon() : createPlayIcon();
    playBtn.setAttribute(
      'aria-label',
      isPlaying ? 'Metti in pausa audio' : 'Riproduci audio'
    );
  }

  playBtn.addEventListener('click', async () => {
    try {
      stopAllOtherPlayers(audio, player);

      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (err) {
      console.error('Errore play audio:', err);
    }
  });

  shareBtn.addEventListener('click', async () => {
    await shareAudioFile(audioSource);
  });

  audio.addEventListener('play', () => setPlayingUI(true));
  audio.addEventListener('pause', () => setPlayingUI(false));

  audio.addEventListener('ended', () => {
    setPlayingUI(false);
    audio.currentTime = 0;
    updateTimeUI();
  });

  audio.addEventListener('loadedmetadata', updateTimeUI);
  audio.addEventListener('durationchange', updateTimeUI);
  audio.addEventListener('timeupdate', updateTimeUI);
  audio.addEventListener('canplay', updateTimeUI);

  audio.addEventListener('error', () => {
    console.error('Errore elemento audio:', audio.error);
    time.textContent = '0:00 / 0:00';
    progress.style.width = '0%';
    setPlayingUI(false);
  });

  progressWrap.addEventListener('click', event => {
    const rect = progressWrap.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = pct * audio.duration;
      updateTimeUI();
    }
  });

  return player;
}

export function renderAudioMessage(role, audioSource) {
  const safeRole = role === 'user' ? 'user' : 'lipu';

  const row = document.createElement('div');
  row.className = `message-row ${safeRole} message-enter`;

  if (safeRole === 'lipu') {
    row.appendChild(createAvatar());
  }

  const bubble = document.createElement('div');
  bubble.className = `message ${safeRole === 'user' ? 'user-msg' : 'lipu-msg'} audio-bubble`;

  bubble.appendChild(createCustomAudioPlayer(audioSource));

  row.appendChild(bubble);
  appendToChat(row);
}

export function renderLIPULoadingMessage(text = 'Lipu sta registrando...') {
  removeLIPULoadingMessage();

  const row = document.createElement('div');
  row.className = 'message-row lipu message-enter';
  row.id = 'lipu-loading-row';

  const avatar = createAvatar();

  const bubble = document.createElement('div');
  bubble.className = 'message lipu-msg lipu-loading';

  const loadingText = document.createElement('div');
  loadingText.className = 'lipu-loading-text';
  loadingText.textContent = text;

  const dots = document.createElement('div');
  dots.className = 'lipu-loading-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';

  bubble.appendChild(loadingText);
  bubble.appendChild(dots);

  row.appendChild(avatar);
  row.appendChild(bubble);

  appendToChat(row);
}

export function removeLIPULoadingMessage() {
  document.getElementById('lipu-loading-row')?.remove();
}
