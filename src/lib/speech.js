// Web Speech API helpers with graceful fallbacks.
import { mediaUrl } from './api.js';

let _audio;
// Play imported native audio if present, else fall back to speechSynthesis TTS.
export function playAudio({ audio_path, hanzi }) {
  const url = mediaUrl(audio_path);
  if (url) {
    try {
      if (_audio) { _audio.pause(); }
      _audio = new Audio(url);
      _audio.play().catch(() => speak(hanzi));
      return;
    } catch { /* fall through */ }
  }
  speak(hanzi);
}

let zhVoice = null;
function pickVoice() {
  if (zhVoice) return zhVoice;
  const voices = window.speechSynthesis?.getVoices?.() || [];
  zhVoice = voices.find(v => /zh[-_]CN/i.test(v.lang)) || voices.find(v => /zh/i.test(v.lang)) || null;
  return zhVoice;
}

export function ttsSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speak(text, { rate = 0.9 } = {}) {
  if (!ttsSupported() || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = rate;
  const v = pickVoice();
  if (v) u.voice = v;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
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
