// Web Speech API helpers with graceful fallbacks.
import { mediaUrl } from './api.js';
import { recordUtterance, classifyTones, pitchSupported } from './pitch.js';

let _audio;
// Play imported native audio if present, else fall back to speechSynthesis TTS.
// `slow` slows native playback and uses the slow TTS rate.
export function playAudio({ audio_path, hanzi }, { slow = false } = {}) {
  const url = mediaUrl(audio_path);
  if (url) {
    try {
      if (_audio) { _audio.pause(); }
      _audio = new Audio(url);
      _audio.playbackRate = slow ? 0.7 : 1;
      _audio.play().catch(() => (slow ? speakSlow(hanzi) : speak(hanzi)));
      return;
    } catch { /* fall through */ }
  }
  slow ? speakSlow(hanzi) : speak(hanzi);
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

// Slightly slow default (0.85) so beginners hear each syllable + tone clearly.
export function speak(text, { rate = 0.85, pitch = 1 } = {}) {
  if (!ttsSupported() || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = rate;
  u.pitch = pitch;
  const v = pickVoice();
  if (v) u.voice = v;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// Deliberately slow, syllable-by-syllable replay for tone drilling.
export function speakSlow(text) { speak(text, { rate: 0.55 }); }

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

// True if we can capture *any* spoken signal (transcript OR acoustic pitch).
export function spokenCaptureSupported() {
  return !!recognitionSupported() || pitchSupported();
}

// Capture one spoken attempt for pronunciation analysis. Runs STT and acoustic
// pitch tracking together on the same utterance, then classifies the tone contour
// into per-syllable tones. Everything stays on-device. Returns a payload the
// server folds into the hidden pronunciation model — never a visible score.
//   { transcript, alternatives, heardTones, timing, onLevel-driven UI hook }
export async function captureSpoken({ expectedSyllables = 1, timeoutMs = 6000, onLevel } = {}) {
  // STT (best-effort — may be unsupported or hear nothing).
  const sttP = recognitionSupported()
    ? listenOnce({ timeoutMs }).catch(() => ({ transcript: '', alternatives: [] }))
    : Promise.resolve({ transcript: '', alternatives: [] });

  // Acoustic pitch (best-effort — runs in parallel on a second mic consumer).
  const pitchP = pitchSupported()
    ? recordUtterance({ maxMs: Math.min(timeoutMs, 5000), onLevel }).catch(() => null)
    : Promise.resolve(null);

  const [stt, pitch] = await Promise.all([sttP, pitchP]);
  const heardTones = pitch?.contour?.length ? classifyTones(pitch.contour, expectedSyllables) : null;

  return {
    transcript: stt.transcript || '',
    alternatives: stt.alternatives || [],
    heardTones,
    timing: pitch ? { latencyMs: pitch.latencyMs, speechMs: pitch.speechMs, totalMs: pitch.totalMs } : {},
    heardVoice: !!(pitch?.contour?.length),
    sttSupported: !!recognitionSupported(),
  };
}
