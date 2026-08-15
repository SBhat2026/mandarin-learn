// Local acoustic analysis. Web Speech STT only returns recognized *characters* —
// never pitch — so tone, fluency, hesitation and confidence can't be inferred
// from it alone. This records the microphone with the Web Audio API, tracks the
// fundamental frequency (f0) contour, and classifies each syllable's tone shape.
// Nothing leaves the device. Works even where SpeechRecognition doesn't (Safari),
// so pronunciation feedback isn't gated on Chrome/Edge.

// Time-domain autocorrelation pitch detector. Returns { f0, rms }; f0 = -1 if
// unvoiced/too quiet. Classic ACF with parabolic interpolation.
function autoCorrelate(buf, sampleRate) {
  let size = buf.length;
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return { f0: -1, rms };

  // Trim near-silence at the edges of the frame.
  let r1 = 0, r2 = size - 1;
  const thres = 0.2;
  for (let i = 0; i < size / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < size / 2; i++) if (Math.abs(buf[size - i]) < thres) { r2 = size - i; break; }
  const b = buf.slice(r1, r2);
  size = b.length;
  if (size < 2) return { f0: -1, rms };

  const c = new Float32Array(size);
  for (let i = 0; i < size; i++) for (let j = 0; j < size - i; j++) c[i] += b[j] * b[j + i];

  let d = 0;
  while (d < size - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < size; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  if (T0 <= 0) return { f0: -1, rms };

  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);
  return { f0: sampleRate / T0, rms };
}

export function pitchSupported() {
  return typeof window !== 'undefined'
    && !!(navigator.mediaDevices?.getUserMedia)
    && !!(window.AudioContext || window.webkitAudioContext);
}

// Record until the learner stops speaking (or maxMs). Resolves a summary of the
// utterance: the voiced f0 contour, speech onset latency and duration.
// `noSpeechMs` ends the recording early when the learner never started talking at all.
// The hands-free loop re-arms the microphone after every teacher turn, so most
// recordings that capture nothing are simply the learner thinking — holding the mic
// open for the full timeout makes the app feel stuck and hands Whisper a long stretch
// of silence, which is precisely what it hallucinates on.
export async function recordUtterance({ maxMs = 4000, silenceMs = 700, noSpeechMs = 0, onLevel } = {}) {
  if (!pitchSupported()) return null;
  let stream, ac;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const frames = [];
    const t0 = performance.now();
    let speechStart = null, lastVoice = null;

    return await new Promise((resolve) => {
      const cleanup = () => {
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        try { ac.close(); } catch {}
      };
      const tick = () => {
        const el = performance.now() - t0;
        an.getFloatTimeDomainData(buf);
        const { f0, rms } = autoCorrelate(buf, ac.sampleRate);
        const voiced = f0 > 60 && f0 < 450 && rms > 0.012;
        frames.push({ t: el, f0: voiced ? f0 : null, rms });
        onLevel?.(rms);
        if (voiced) { if (speechStart == null) speechStart = el; lastVoice = el; }
        const ended = speechStart != null && lastVoice != null && (el - lastVoice) > silenceMs;
        const neverSpoke = noSpeechMs > 0 && speechStart == null && el >= noSpeechMs;
        if (el >= maxMs || ended || neverSpoke) { cleanup(); resolve(summarize(frames, speechStart, lastVoice, el)); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } catch {
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { ac?.close(); } catch {}
    return null;
  }
}

function summarize(frames, speechStart, speechEnd, totalMs) {
  const contour = frames.filter(f => f.f0 != null);
  return {
    contour,
    latencyMs: speechStart == null ? null : Math.round(speechStart),
    speechMs: (speechStart != null && speechEnd != null) ? Math.round(speechEnd - speechStart) : null,
    totalMs: Math.round(totalMs),
  };
}

// Classify the tone of each of `n` syllables from the voiced contour. Returns an
// array of tone numbers (1 high-level, 2 rising, 3 dipping, 4 falling, 5 neutral;
// 0 = uncertain). Normalizes to the speaker's own range so it's pitch-independent.
export function classifyTones(contour, n = 1) {
  if (!contour?.length || n < 1) return null;
  // Convert to semitones relative to the utterance median → speaker-normalized.
  const f0s = contour.map(c => c.f0);
  const ref = median(f0s) || f0s[0];
  const st = contour.map(c => ({ t: c.t, v: 12 * Math.log2(c.f0 / ref) }));

  // Split the voiced region into n contiguous segments by frame count.
  const per = Math.floor(st.length / n) || 1;
  const tones = [];
  for (let i = 0; i < n; i++) {
    const seg = st.slice(i * per, i === n - 1 ? st.length : (i + 1) * per);
    tones.push(classifySegment(seg));
  }
  return tones;
}

function classifySegment(seg) {
  if (seg.length < 3) return 0;                     // too little signal
  const vals = seg.map(s => s.v);
  const q = (arr, a, b) => arr.slice(Math.floor(arr.length * a), Math.ceil(arr.length * b));
  const mean = avg(vals);
  const start = avg(q(vals, 0, 0.34));
  const end = avg(q(vals, 0.66, 1));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const slope = end - start;
  const range = max - min;
  const durMs = seg[seg.length - 1].t - seg[0].t;

  // Neutral: short and flat and unremarkable pitch.
  if (durMs < 130 && range < 2 && Math.abs(mean) < 1.2) return 5;
  // A V-shape whose lowest point sits in the MIDDLE (not at an edge) and dips
  // clearly below both ends is unambiguously the 3rd tone.
  const minFrac = vals.indexOf(min) / (vals.length - 1);
  const midMin = minFrac > 0.2 && minFrac < 0.85 && min < start - 1.5 && min < end - 1.5;
  if (midMin) return 3;
  // Slope-based tones take priority: a steep monotonic rise/fall is 2nd/4th even
  // when log-compression drags the mean pitch low.
  if (slope > 1.8) return 2;                         // rising (2nd)
  if (slope < -1.8) return 4;                        // falling (4th)
  // Low and flat (no strong slope, no clear dip) reads as a low 3rd tone.
  if (mean < -1.3) return 3;
  // High-level (1st): flattish and relatively high.
  if (Math.abs(slope) <= 1.8 && mean > 0.3) return 1;
  // Ambiguous fallback by dominant tendency.
  return slope > 0 ? 2 : slope < 0 ? 4 : 1;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
