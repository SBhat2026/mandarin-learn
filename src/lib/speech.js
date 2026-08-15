// Speech helpers. Priority order for OUTPUT:
//   1. imported native audio (real recordings from decks)
//   2. server neural TTS (/api/tts — Edge zh-CN voices, cached mp3s)
//   3. browser speechSynthesis (offline last resort)
import { mediaUrl, isDemo, authHeaders } from './api.js';
import { recordUtterance, classifyTones, pitchSupported } from './pitch.js';

let _audio;
function playUrl(url, { slow = false, onFail, onEnd } = {}) {
  try {
    if (_audio) { _audio.pause(); }
    _audio = new Audio(url);
    _audio.playbackRate = slow ? 0.75 : 1;
    _audio.onended = () => onEnd?.();
    _audio.onerror = () => onFail?.();
    _audio.play().catch(() => onFail?.());
  } catch { onFail?.(); }
}

// Cut the teacher off mid-sentence. Barge-in: in a hands-free conversation the
// learner must be able to start talking before the teacher has finished, the way they
// can with a person. Without this, voice mode is a series of lectures you wait out.
export function stopSpeaking() {
  try { if (_audio) { _audio.onended = null; _audio.pause(); _audio = null; } } catch {}
  try { window.speechSynthesis?.cancel(); } catch {}
}

// speak(), but you can await the end of it. This is what lets the microphone arm at
// exactly the moment the teacher stops — a fixed timer either clips the last word or
// leaves an awkward gap, and both make the learner talk over the teacher.
// Always resolves (never rejects): a failure to speak must not stall the turn loop.
export function speakAwait(text) {
  if (!text) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    // Belt and braces: if the audio element never fires `ended` (a stalled stream, a
    // tab throttled in the background), the conversation must still move on.
    const guard = setTimeout(done, 15000);
    const finish = () => { clearTimeout(guard); done(); };
    const browser = () => speakBrowser(text, { rate: 0.85, onEnd: finish });
    if (isDemo) return browser();
    neuralUrl(text, false)
      .then(u => playUrl(u, { onEnd: finish, onFail: browser }))
      .catch(browser);
  });
}

// Neural TTS via the backend; memoized per text+speed. Rejects → caller falls back.
const _ttsCache = new Map();
async function neuralUrl(text, slow) {
  const key = (slow ? 's|' : 'n|') + text;
  if (_ttsCache.has(key)) return _ttsCache.get(key);
  const p = fetch(`/api/tts?text=${encodeURIComponent(text)}${slow ? '&slow=1' : ''}`,
    { headers: authHeaders() })
    .then(r => { if (!r.ok) throw new Error('tts ' + r.status); return r.json(); })
    .then(d => d.url);
  p.catch(() => _ttsCache.delete(key));
  _ttsCache.set(key, p);
  return p;
}

// Play imported native audio if present, else neural TTS, else browser TTS.
export function playAudio({ audio_path, hanzi }, { slow = false } = {}) {
  const url = mediaUrl(audio_path);
  if (url) return playUrl(url, { slow, onFail: () => speakNeural(hanzi, slow) });
  speakNeural(hanzi, slow);
}

function speakNeural(text, slow = false) {
  if (!text) return;
  const browser = () => speakBrowser(text, { rate: slow ? 0.55 : 0.85 });
  if (isDemo) return browser();
  neuralUrl(text, slow).then(u => playUrl(u, { onFail: browser })).catch(browser);
}

// Rank Mandarin voices: prefer natural/enhanced/cloud voices over the default
// robotic one. macOS "Tingting"/"Meijia", Google "普通话", Microsoft "Xiaoxiao"
// are markedly clearer than the fallback compact voice.
const VOICE_RANK = [
  /google.*(?:普通话|mandarin|zh)/i,
  /xiaoxiao|yunxi|yunyang|xiaoyi/i,     // Microsoft neural
  /tingting|ting-ting|meijia|sinji/i,   // Apple enhanced zh
  /zh[-_]cn/i,
  /zh/i,
];
let zhVoice = null;
function allZh() {
  return (window.speechSynthesis?.getVoices?.() || []).filter(v => /zh|mandarin|chinese/i.test(v.lang + ' ' + v.name));
}
function pickVoice() {
  if (zhVoice) return zhVoice;
  const voices = allZh();
  for (const rx of VOICE_RANK) {
    const hit = voices.find(v => rx.test(v.name) || rx.test(v.lang));
    if (hit) { zhVoice = hit; return hit; }
  }
  zhVoice = voices[0] || null;
  return zhVoice;
}

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// Public speak(): neural first, browser fallback. Kept as the app-wide entry so
// every existing speak() call upgrades to the neural voice automatically.
export function speak(text) { speakNeural(text, false); }

// Browser speechSynthesis (fallback path). Slightly slow (0.85) for clarity.
export function speakBrowser(text, { rate = 0.85, pitch = 1, onEnd } = {}) {
  if (!ttsSupported() || !text) { onEnd?.(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = rate;
  u.pitch = pitch;
  const v = pickVoice();
  if (v) u.voice = v;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// Deliberately slow replay for tone drilling: neural slow rate, browser fallback.
export function speakSlow(text) {
  if (isDemo) return speakBrowser(text, { rate: 0.55 });
  neuralUrl(text, true)
    .then(u => playUrl(u, { onFail: () => speakBrowser(text, { rate: 0.55 }) }))
    .catch(() => speakBrowser(text, { rate: 0.55 }));
}

if (ttsSupported()) {
  window.speechSynthesis.onvoiceschanged = () => { zhVoice = null; pickVoice(); };
}

// SpeechRecognition wrapper. Resolves { transcript } or rejects with a reason.
export function recognitionSupported() {
  return typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function listenOnce({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return reject(new Error('unsupported'));
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; try { rec.stop(); } catch {} fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), timeoutMs);
    rec.onresult = (e) => {
      clearTimeout(timer);
      const alts = Array.from(e.results[0]).map(a => a.transcript);
      finish(resolve, { transcript: alts[0], alternatives: alts });
    };
    rec.onerror = (e) => { clearTimeout(timer); finish(reject, new Error(e.error || 'error')); };
    rec.onend = () => { clearTimeout(timer); if (!done) finish(reject, new Error('no-speech')); };
    try { rec.start(); } catch (e) { clearTimeout(timer); finish(reject, e); }
  });
}

// Normalize hanzi for comparison (strip spaces/punctuation).
export function normalizeHanzi(text = '') {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, '');
}

// ── Local Whisper STT (server) ──────────────────────────────────────────────
// Preferred over the Web Speech API: far better on learner Mandarin, works in
// any browser with MediaRecorder, fully local. Availability probed once.
function recorderSupported() {
  return typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
}
let _whisper = null;   // null = unprobed, else boolean
async function whisperAvailable() {
  if (_whisper !== null) return _whisper;
  if (isDemo || !recorderSupported()) return (_whisper = false);
  try {
    const r = await fetch('/api/stt/health');
    _whisper = r.ok && (await r.json()).available === true;
  } catch { _whisper = false; }
  return _whisper;
}
// Warm the probe early so the first mic tap doesn't pay for it.
if (typeof window !== 'undefined') setTimeout(() => { whisperAvailable().catch(() => {}); }, 1500);

// Record one utterance blob; stops on `stopSignal` promise or maxMs.
async function recordBlob({ maxMs = 6000, stopSignal } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(); });
  rec.start();
  const timer = setTimeout(() => { try { rec.stop(); } catch {} }, maxMs);
  if (stopSignal) stopSignal.finally(() => { clearTimeout(timer); setTimeout(() => { try { rec.stop(); } catch {} }, 250); });
  await done;
  clearTimeout(timer);
  stream.getTracks().forEach(t => t.stop());
  return new Blob(chunks, { type: mime || 'audio/webm' });
}

async function whisperTranscribe(blob, hint = '', sessionId = null) {
  const q = new URLSearchParams();
  if (hint) q.set('hint', hint);
  // Lets the server prime the recognizer with every word this session has taught —
  // the accuracy advantage a general-purpose voice assistant cannot have, because it
  // does not know what you are trying to learn.
  if (sessionId) q.set('session', sessionId);
  const r = await fetch('/api/stt' + (q.toString() ? `?${q}` : ''), {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream', ...authHeaders() },
    body: blob,
  });
  if (!r.ok) throw new Error('stt ' + r.status);
  const d = await r.json();
  return { transcript: d.transcript || '', confidence: d.confidence ?? null, rejected: d.rejected || null };
}

// True if we can capture *any* spoken signal (transcript OR acoustic pitch).
export function spokenCaptureSupported() {
  return recorderSupported() || !!recognitionSupported() || pitchSupported();
}

// Capture one spoken attempt for pronunciation analysis. Preferred path: record
// the utterance and transcribe with local Whisper, with acoustic pitch tracking
// in parallel (tones). Falls back to the Web Speech API when Whisper is absent.
// Everything stays on-device. Returns a payload the server folds into the hidden
// pronunciation model — never a visible score.
//   { transcript, alternatives, heardTones, timing, onLevel-driven UI hook }
export async function captureSpoken({
  expectedSyllables = 1, timeoutMs = 6000, onLevel, hint = '', sessionId = null,
  silenceMs = 700, noSpeechMs = 0,
} = {}) {
  const useWhisper = await whisperAvailable();

  // Acoustic pitch (best-effort). Its silence detection also ENDS the whisper
  // recording, so we stop listening when the learner stops talking.
  const pitchP = pitchSupported()
    ? recordUtterance({ maxMs: Math.min(timeoutMs, 12000), onLevel, silenceMs, noSpeechMs }).catch(() => null)
    : Promise.resolve(null);

  let stt;
  if (useWhisper) {
    try {
      const blob = await recordBlob({ maxMs: timeoutMs, stopSignal: pitchSupported() ? pitchP : undefined });
      const r = await whisperTranscribe(blob, hint, sessionId);
      const transcript = r.transcript.replace(/[。，、!！?？\s]+$/, '');
      stt = { transcript, alternatives: transcript ? [transcript] : [], confidence: r.confidence, rejected: r.rejected };
    } catch { stt = { transcript: '', alternatives: [], confidence: null, rejected: 'error' }; }
  } else {
    stt = recognitionSupported()
      ? await listenOnce({ timeoutMs }).catch(() => ({ transcript: '', alternatives: [] }))
      : { transcript: '', alternatives: [] };
  }

  const pitch = await pitchP;
  const heardTones = pitch?.contour?.length ? classifyTones(pitch.contour, expectedSyllables) : null;

  return {
    transcript: stt.transcript || '',
    alternatives: stt.alternatives || [],
    // null means "the recognizer told us nothing", which is NOT the same as low
    // confidence — callers must not treat an unknown as a bad transcript.
    confidence: stt.confidence ?? null,
    rejected: stt.rejected || null,
    heardTones,
    timing: pitch ? { latencyMs: pitch.latencyMs, speechMs: pitch.speechMs, totalMs: pitch.totalMs } : {},
    heardVoice: !!(pitch?.contour?.length),
    sttSupported: useWhisper || !!recognitionSupported(),
    engine: useWhisper ? 'whisper' : 'webspeech',
  };
}
