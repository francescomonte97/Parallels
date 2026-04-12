import { dom } from './dom.js';
import { state } from './state.js';
import { formatTime } from './utils.js';

export function startWaveUI() {
  dom.waveform.classList.add('active');
  dom.recordBtn.classList.add('recording');
  dom.recordingUI.classList.add('active');
  dom.userInput.style.display = 'none';

  dom.recordingStatus.textContent = 'Registrazione...';
  state.recordingSeconds = 0;
  dom.recordingTime.textContent = '00:00';

  clearInterval(state.recordingInterval);
  state.recordingInterval = setInterval(() => {
    state.recordingSeconds++;
    dom.recordingTime.textContent = formatTime(state.recordingSeconds);
  }, 1000);
}

export function stopWaveUI(hasAudio = true) {
  dom.waveform.classList.remove('active');
  dom.recordBtn.classList.remove('recording');
  clearInterval(state.recordingInterval);

  if (hasAudio) {
    dom.recordingStatus.textContent = 'Audio pronto';
  } else {
    dom.recordingStatus.textContent = 'Registrazione...';
    dom.recordingTime.textContent = '00:00';
    dom.recordingUI.classList.remove('active');
    dom.userInput.style.display = 'block';
  }
}

export async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    state.audioChunks = [];
    state.lastAudioBlob = null;
    state.mediaRecorder = new MediaRecorder(stream);

    state.mediaRecorder.ondataavailable = event => {
      if (event.data.size > 0) state.audioChunks.push(event.data);
    };

    state.mediaRecorder.onstop = () => {
      state.lastAudioBlob = new Blob(state.audioChunks, {
        type: state.mediaRecorder.mimeType || 'audio/webm'
      });

      stopWaveUI(true);
      state.isRecording = false;
      stream.getTracks().forEach(track => track.stop());

      if (state.stopRecordingResolver) {
        state.stopRecordingResolver();
        state.stopRecordingResolver = null;
      }
    };

    state.mediaRecorder.start();
    state.isRecording = true;
    startWaveUI();
  } catch {
    dom.recordingStatus.textContent = 'Microfono non disponibile';
    stopWaveUI(false);
  }
}

export function stopRecording() {
  return new Promise(resolve => {
    if (!state.mediaRecorder || !state.isRecording) {
      resolve();
      return;
    }

    state.stopRecordingResolver = resolve;
    state.mediaRecorder.stop();
  });
}

export function resetAudioComposerState() {
  state.lastAudioBlob = null;
  dom.recordingUI.classList.remove('active');
  dom.userInput.style.display = 'block';
  dom.recordingTime.textContent = '00:00';
  dom.recordingStatus.textContent = 'Registrazione...';
}