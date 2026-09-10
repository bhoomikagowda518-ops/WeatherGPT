export const STT_PROVIDERS = { BROWSER: 'browser', OPENAI: 'openai' };

export const LANG_TO_WHISPER = {
  'en-IN': 'en',
  'hi-IN': 'hi',
  'kn-IN': 'kn'
};

function getEnv() {
  if (typeof import.meta === 'undefined' || !import.meta.env) return {};
  return import.meta.env || {};
}

export function getSTTSetup() {
  const env = getEnv();
  const hasSpeech = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);
  const openaiKey = env.VITE_OPENAI_API_KEY ? String(env.VITE_OPENAI_API_KEY) : '';

  const providers = [];
  if (openaiKey) providers.push({ id: STT_PROVIDERS.OPENAI, label: 'OpenAI Whisper' });
  if (hasSpeech) providers.push({ id: STT_PROVIDERS.BROWSER, label: 'Browser speech' });

  return { providers, active: providers[0] || null, openaiKey };
}

export function createSTTSession({ lang, onInterim, onFinal, onEnd, onError }) {
  const setup = getSTTSetup();
  if (!setup.active) return null;
  if (setup.active.id === STT_PROVIDERS.OPENAI) {
    return createOpenAISession({ lang, onInterim, onFinal, onEnd, onError });
  }
  return createBrowserSession({ lang, onInterim, onFinal, onEnd, onError });
}

function mapBrowserError(code) {
  switch (code) {
    case 'no-speech': return 'no-speech';
    case 'not-allowed':
    case 'service-not-allowed': return 'not-allowed';
    case 'audio-capture': return 'audio-capture';
    case 'network': return 'network';
    case 'aborted': return 'aborted';
    default: return 'error';
  }
}

function createBrowserSession({ lang, onInterim, onFinal, onEnd, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = lang || 'en-IN';
  let ended = false;
  let cancelled = false;

  rec.onresult = (event) => {
    if (cancelled) return;
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim && onInterim) onInterim(interim);
    if (final && onFinal) onFinal(final.trim());
  };

  rec.onend = () => {
    if (ended) return;
    ended = true;
    if (onEnd) onEnd();
  };

  rec.onerror = (e) => {
    if (cancelled) return;
    if (onError) onError(mapBrowserError(e.error));
  };

  return {
    id: STT_PROVIDERS.BROWSER,
    streaming: true,
    start() {
      try {
        rec.start();
      } catch {
        if (onError) onError('start-failed');
      }
    },
    stop(opts) {
      ended = true;
      if (opts && opts.cancel) cancelled = true;
      try {
        rec.stop();
      } catch { /* ignore */ }
    },
    setLang(l) {
      rec.lang = l || 'en-IN';
    }
  };
}

function getRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  try {
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  } catch { /* ignore */ }
  return 'audio/webm';
}

function createOpenAISession({ lang, onInterim, onFinal, onEnd, onError }) {
  const env = getEnv();
  const apiKey = String(env.VITE_OPENAI_API_KEY || '');
  const model = String(env.VITE_OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
  const whisperLang = lang === 'auto' ? null : (LANG_TO_WHISPER[lang] || null);

  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let rmsTimer = null;
  let silenceHits = 0;
  let hasAudio = false;
  let stopped = false;
  let cancelled = false;
  let busy = false;

  async function start() {
    stopped = false;
    cancelled = false;
    hasAudio = false;
    silenceHits = 0;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const code = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
        ? 'not-allowed' : 'audio-capture';
      if (onError) onError(code);
      if (onEnd) onEnd();
      return;
    }
    if (stopped) { stopTracks(); return; }

    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: getRecorderMime() });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => transcribe();

    if (onInterim) onInterim('Recording…');
    mediaRecorder.start(250);
    setupSilenceDetector();
  }

  function setupSilenceDetector() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);

      rmsTimer = setInterval(() => {
        if (!analyser || !dataArray) return;
        analyser.getByteTimeDomainData(dataArray);
        let max = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = Math.abs(dataArray[i] - 128);
          if (v > max) max = v;
        }
        const level = max / 128;
        if (level > 0.04) {
          hasAudio = true;
          silenceHits = 0;
        } else if (hasAudio) {
          silenceHits += 1;
          if (silenceHits >= 7) stop(); // ~1.75s of silence after speech
        }
      }, 250);
    } catch { /* silence auto-stop disabled */ }
  }

  function cleanup() {
    if (rmsTimer) { clearInterval(rmsTimer); rmsTimer = null; }
    if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
    analyser = null;
    dataArray = null;
  }

  function stopTracks() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    mediaRecorder = null;
  }

  function stop(opts) {
    stopped = true;
    if (opts && opts.cancel) cancelled = true;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    } else {
      cleanup();
      stopTracks();
      if (onEnd) onEnd();
    }
  }

  async function transcribe() {
    cleanup();
    if (stopped && cancelled) {
      busy = false;
      stopTracks();
      if (onEnd) onEnd();
      return;
    }
    if (busy) return;
    busy = true;

    if (!hasAudio || chunks.length === 0) {
      busy = false;
      stopTracks();
      if (onError) onError('no-speech');
      if (onEnd) onEnd();
      return;
    }

    const blob = new Blob(chunks, { type: getRecorderMime() });
    stopTracks();

    try {
      if (onInterim) onInterim('Transcribing…');
      const text = await sendToWhisper(blob, whisperLang, apiKey, model);
      if (!cancelled && onFinal) onFinal((text || '').trim());
    } catch (err) {
      if (!cancelled && onError) onError((err && err.httpError) ? 'network' : 'error');
    } finally {
      busy = false;
      if (onEnd) onEnd();
    }
  }

  async function sendToWhisper(blob, langCode, key, modelName) {
    const form = new FormData();
    form.append('file', blob, 'voice.webm');
    form.append('model', modelName);
    if (langCode) form.append('language', langCode);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form
    });
    if (!res.ok) {
      const err = new Error('stt-http');
      err.httpError = true;
      throw err;
    }
    const data = await res.json();
    return data.text || '';
  }

  return {
    id: STT_PROVIDERS.OPENAI,
    streaming: false,
    autoLanguage: true,
    model,
    start,
    stop,
    setLang() { /* language is fixed for the recording session */ }
  };
}