// Voice entry for the in-world VR panel: a defensive wrapper over the Web Speech
// API (webkitSpeechRecognition / SpeechRecognition), which the Quest browser may
// not expose. Contract: never throw, always tell the caller whether it worked.
//
//   - isVoiceSupported()   -> boolean capability check (safe to call anywhere).
//   - startVoiceDictation({ onInterim, onFinal, onError, onEnd }) -> a session
//     handle with stop(), or null if unsupported. Callbacks are all optional.
//
// No rendering and no knowledge of load functions; the panel owns all UI.

import { t } from "./i18n.js";

function getRecognitionCtor() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// Capability check — used by the panel to grey out the mic cell. Must not throw
// and must not construct anything (some engines log noise on construction).
function isVoiceSupported() {
  return getRecognitionCtor() !== null;
}

// Start a single dictation session. Returns a handle { stop } or null when the
// API is unavailable. All callbacks are optional and are wrapped so a throwing
// consumer callback cannot bubble into the SpeechRecognition event loop.
function startVoiceDictation({ onInterim, onFinal, onError, onEnd } = {}) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    // Defensive: capability was supposed to be checked first, but degrade anyway.
    safeCall(onError, t("voice.err.notAvailable"));
    safeCall(onEnd);
    return null;
  }

  let recognition;
  try {
    recognition = new Ctor();
  } catch (err) {
    safeCall(onError, describeError(err) || t("voice.err.startInput"));
    safeCall(onEnd);
    return null;
  }

  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  try {
    // Best-effort locale hint; harmless if the engine ignores it.
    recognition.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  } catch {
    // Some engines make lang read-only; ignore.
  }

  let finished = false;
  const finishOnce = () => {
    if (finished) {
      return;
    }
    finished = true;
    safeCall(onEnd);
  };

  recognition.onresult = (event) => {
    let interim = "";
    let finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";
      if (result.isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    if (interim) {
      safeCall(onInterim, interim.trim());
    }
    if (finalText) {
      safeCall(onFinal, finalText.trim());
    }
  };

  recognition.onerror = (event) => {
    // event.error is a short code ("not-allowed", "no-speech", "network", ...).
    safeCall(onError, humanizeErrorCode(event?.error));
  };

  recognition.onend = () => {
    finishOnce();
  };

  try {
    recognition.start();
  } catch (err) {
    // start() throws if already started or if the mic can't be acquired.
    safeCall(onError, describeError(err) || t("voice.err.startInput"));
    finishOnce();
    return null;
  }

  return {
    stop() {
      try {
        recognition.stop();
      } catch {
        // Already stopped / never started; force the end callback.
        finishOnce();
      }
    }
  };
}

// Server-relayed STT, the Quest path. Quest lacks SpeechRecognition but has
// getUserMedia + Web Audio, so when the server reports stt.enabled we record 16 kHz
// mono WAV PCM and POST it to /api/stt. The final transcript goes back to the caller.

const STT_SAMPLE_RATE = 16_000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

// Cached server STT capability (undefined = not yet probed). Refreshed lazily
// on first request; the panel can also force a re-probe after a settings save.
let sttCapability;
let sttPermissionPrewarmed = false;

function mediaRecordingSupported() {
  return (
    typeof navigator !== "undefined"
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === "function"
    && typeof window !== "undefined"
    && typeof (window.AudioContext || window.webkitAudioContext) === "function"
  );
}

// Probe /api/health for stt.enabled. Never throws; a failed/absent health check
// resolves to false so the entry chain falls through to the keyboard.
async function isServerSttEnabled({ refresh = false } = {}) {
  if (!refresh && typeof sttCapability === "boolean") {
    return sttCapability;
  }
  if (!mediaRecordingSupported()) {
    sttCapability = false;
    return false;
  }
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    sttCapability = Boolean(payload?.stt?.enabled);
  } catch {
    sttCapability = false;
  }
  return sttCapability;
}

async function prewarmServerSttPermission() {
  if (sttPermissionPrewarmed || !mediaRecordingSupported()) {
    return sttPermissionPrewarmed;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stopTracks(stream);
    sttPermissionPrewarmed = true;
  } catch {
    sttPermissionPrewarmed = false;
  }
  return sttPermissionPrewarmed;
}

// Start a press-to-record STT session. Returns a handle { stop } immediately
// (mic acquisition is async and reported via onError if it fails), or null when
// recording is unsupported. Callbacks:
//   onRecording()      → mic is live (panel shows "● recording").
//   onTranscribing()   → recording stopped, POST in flight.
//   onFinal(text)      → transcript ready; caller routes it.
//   onError(message)   → human-readable failure; never throws.
//   onEnd()            → session fully settled (success or failure).
// Nothing here throws into the caller.
function startServerStt({ onRecording, onTranscribing, onFinal, onError, onEnd } = {}) {
  if (!mediaRecordingSupported()) {
    safeCall(onError, t("voice.err.recNotAvailable"));
    safeCall(onEnd);
    return null;
  }

  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let monitorGainNode = null;
  let stopped = false;
  let ended = false;
  const chunks = [];

  const endOnce = () => {
    if (ended) {
      return;
    }
    ended = true;
    disconnectAudioGraph();
    stopTracks(stream);
    stream = null;
    safeCall(onEnd);
  };

  const fail = (message) => {
    safeCall(onError, message);
    endOnce();
  };

  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((acquired) => {
      if (stopped) {
        // Caller cancelled before the mic was granted.
        stopTracks(acquired);
        endOnce();
        return;
      }
      stream = acquired;
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextCtor();
        sourceNode = audioContext.createMediaStreamSource(stream);
        processorNode = audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
        monitorGainNode = audioContext.createGain();
        monitorGainNode.gain.value = 0;
        processorNode.onaudioprocess = (event) => {
          if (stopped) {
            return;
          }
          const input = event.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(input));
        };
        sourceNode.connect(processorNode);
        processorNode.connect(monitorGainNode);
        monitorGainNode.connect(audioContext.destination);
      } catch (err) {
        fail(describeError(err) || t("voice.err.startRecording"));
        return;
      }
      safeCall(onRecording);
    })
    .catch((err) => {
      fail(humanizeGetUserMediaError(err));
    });

  async function transcribeAndFinish() {
    disconnectAudioGraph();
    const sampleRate = audioContext?.sampleRate || STT_SAMPLE_RATE;
    closeAudioContext(audioContext);
    audioContext = null;
    const audio = encodeWav16kMono(chunks, sampleRate);
    const blob = new Blob([audio], { type: "audio/wav" });
    if (blob.size === 0) {
      fail(t("voice.err.noAudio"));
      return;
    }
    safeCall(onTranscribing);
    try {
      const response = await fetch("/api/stt", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: blob
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        fail(payload?.error || `Transcription failed (HTTP ${response.status})`);
        return;
      }
      const text = String(payload?.text || "").trim();
      if (!text) {
        fail(t("voice.err.noSpeech"));
        return;
      }
      safeCall(onFinal, text);
      endOnce();
    } catch (err) {
      fail(describeError(err) || t("voice.err.network"));
    }
  }

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (!stream) {
        // Mic not yet acquired: the getUserMedia handler will end the session.
        return;
      }
      if (chunks.length === 0) {
        fail(t("voice.err.noAudio"));
        return;
      }
      void transcribeAndFinish();
    }
  };

  function disconnectAudioGraph() {
    if (processorNode) {
      processorNode.onaudioprocess = null;
      try {
        processorNode.disconnect();
      } catch {
        // Already disconnected.
      }
      processorNode = null;
    }
    if (monitorGainNode) {
      try {
        monitorGainNode.disconnect();
      } catch {
        // Already disconnected.
      }
      monitorGainNode = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
      sourceNode = null;
    }
  }
}

function encodeWav16kMono(chunks, inputSampleRate) {
  const source = flattenFloatChunks(chunks);
  const samples = downsampleMono(source, inputSampleRate, STT_SAMPLE_RATE);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, STT_SAMPLE_RATE, true);
  view.setUint32(28, STT_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function flattenFloatChunks(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downsampleMono(samples, inputRate, outputRate) {
  if (!samples.length || inputRate <= 0 || inputRate === outputRate) {
    return samples;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    const count = Math.max(1, end - start);
    for (let j = start; j < end; j += 1) {
      sum += samples[j];
    }
    out[i] = sum / count;
  }
  return out;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function closeAudioContext(context) {
  if (!context || typeof context.close !== "function") {
    return;
  }
  try {
    void context.close();
  } catch {
    // Best-effort cleanup.
  }
}

function stopTracks(stream) {
  if (!stream) {
    return;
  }
  try {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  } catch {
    // Best-effort cleanup.
  }
}

function humanizeGetUserMediaError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("voice.err.permission");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("voice.err.noMic");
  }
  return describeError(err) || t("voice.err.accessMic");
}

function safeCall(fn, arg) {
  if (typeof fn !== "function") {
    return;
  }
  try {
    fn(arg);
  } catch {
    // A throwing consumer callback must never break the recognition loop.
  }
}

function describeError(err) {
  if (!err) {
    return "";
  }
  return err instanceof Error ? err.message : String(err);
}

function humanizeErrorCode(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return t("voice.err.permission");
    case "no-speech":
      return t("voice.err.noSpeech");
    case "audio-capture":
      return t("voice.err.noMic");
    case "network":
      return t("voice.err.voiceNetwork");
    case "aborted":
      return t("voice.err.cancelled");
    default:
      return code ? t("voice.err.code", { code }) : t("vr.voice.error");
  }
}

export {
  isVoiceSupported,
  startVoiceDictation,
  isServerSttEnabled,
  prewarmServerSttPermission,
  startServerStt,
  mediaRecordingSupported
};
