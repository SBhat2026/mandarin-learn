// Whisper STT. The browser records a short utterance (MediaRecorder webm/mp4),
// posts the blob here, and gets back a Mandarin transcript — far more accurate on
// learner speech than the Web Speech API.
//
// Two backends, chosen by what the host can actually do:
//   • local mlx_whisper — Apple Silicon only (my laptop). Free, offline, private.
//   • Groq whisper-large-v3-turbo — for the hosted Linux container, where MLX
//     cannot run. ~$0.04 per audio-hour, and it works in every browser including
//     Safari/iOS, which the Web Speech API does not.
// Local wins when present; Groq is the fallback; absent both, the client falls
// back to the browser's own recognition.
import 'dotenv/config';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { toSimplified, looksTraditional } from './zh.js';

// large-v3-turbo: a distillation of large-v3 that measured FASTER than medium here
// (4.67s vs 5.65s cold-process on the same clip) while being a stronger model —
// there is no trade to make. It replaced medium, which had been chosen when the
// comparison was only against small. Override with WHISPER_MODEL.
const MODEL = process.env.WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';

const GROQ_KEY = () => process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

let _bin;   // resolved mlx_whisper path, or null when unavailable
function localAvailable() {
  if (_bin !== undefined) return Boolean(_bin);
  try { _bin = execFileSync('which', ['mlx_whisper']).toString().trim() || null; }
  catch { _bin = null; }
  return Boolean(_bin);
}

export function sttAvailable() { return localAvailable() || Boolean(GROQ_KEY()); }
export function sttEngine() { return localAvailable() ? 'mlx' : GROQ_KEY() ? 'groq' : 'none'; }

// Whisper's signature failure: fed silence or breath, it emits fluent, confident
// nonsense drawn from its training data — Chinese audio is largely subtitled video, so
// it returns subtitle boilerplate. In a push-to-talk app this is a curiosity; in a
// hands-free loop, where the mic re-arms itself after every teacher turn and will
// certainly capture silence, it is the difference between a usable product and one
// that invents a learner utterance every few seconds and grades them on it.
const HALLUCINATIONS = [
  /^(字幕|中文字幕|字幕君|subtitle)/i,
  /由.{0,8}(提供|制作|翻译)/,
  /(请|請)?(不吝)?(点赞|訂閱|订阅|关注|轉發|转发|打赏|支持明鏡|明镜与点点栏目)/,
  /^(谢谢观看|感谢观看|謝謝觀看|謝謝大家|谢谢大家|下集再見|下集再见|我们下次再见)/,
  /^(嗯|啊|哦|呃|唔|噢)+[。！!？?]*$/,          // pure filler
  /^[。，、？！,.?!\s]*$/,                       // punctuation only
];

// A short clip whose transcript is long is almost always a runaway repetition loop
// ("好好好好好好…"), the other classic Whisper degeneracy.
function degenerate(text) {
  const t = String(text);
  if (t.length < 6) return false;
  const uniq = new Set([...t.replace(/[\s\p{P}]/gu, '')]).size;
  return uniq > 0 && uniq / t.length < 0.25;
}

export function isHallucination(text) {
  const t = String(text).trim();
  if (!t) return false;
  return HALLUCINATIONS.some(rx => rx.test(t)) || degenerate(t);
}

// Everything that happens to a raw recognizer string before anyone downstream sees it.
// Returns the empty string when what came back was not really speech — callers treat
// that as "heard nothing" rather than as a learner utterance.
export function clean(raw, { engine, confidence = null } = {}) {
  const text = String(raw || '').trim().replace(/^[「『"']|[」』"']$/g, '');
  if (!text || isHallucination(text)) {
    return { transcript: '', engine, confidence, rejected: text ? 'hallucination' : 'silence', heard: text };
  }
  const simplified = toSimplified(text);
  return {
    transcript: simplified.replace(/[。，、!！?？\s]+$/, ''),
    engine,
    confidence,
    converted: simplified !== text || looksTraditional(text),
    heard: text,
  };
}

// Transcribe an audio buffer. Returns { transcript, engine, confidence } — an empty
// transcript means nothing usable was heard. Utterances are a few seconds long.
//
// `hint` biases recognition toward the words actually in play (Whisper's initial
// prompt / Groq's `prompt`), which is the single largest accuracy lever on learner
// Mandarin: isolated, mispronounced, tone-flat words are exactly the case where the
// language model half of Whisper is doing most of the work.
export async function transcribe(buf, { hint = '', mime = '' } = {}) {
  if (!sttAvailable()) throw new Error('no STT backend (install mlx_whisper or set GROQ_API_KEY)');
  if (!buf?.length || buf.length < 1000) return { transcript: '', engine: sttEngine(), confidence: null };
  if (!localAvailable()) return transcribeGroq(buf, { hint, mime });
  return transcribeLocal(buf, { hint });
}

// Hosted path. Groq's OpenAI-compatible transcription endpoint takes multipart
// audio; `prompt` biases recognition toward the session's vocabulary exactly as
// --initial-prompt does locally.
async function transcribeGroq(buf, { hint = '', mime = '' } = {}) {
  // verbose_json is what carries per-segment avg_logprob / no_speech_prob, and those
  // are the only honest signal for "did it actually hear that". Without them a
  // hands-free loop cannot tell a clear sentence from a confident guess at a cough.
  // If the endpoint ever refuses that format, plain json still transcribes — we just
  // lose confidence and fall back to sending every transcript, which is the old
  // behaviour rather than a broken microphone.
  try {
    return await groqCall(buf, { hint, mime, format: 'verbose_json' });
  } catch (e) {
    if (!/\b(400|422)\b/.test(e.message)) throw e;
    console.warn('[stt] Groq rejected verbose_json, retrying without confidence:', e.message);
    return groqCall(buf, { hint, mime, format: 'json' });
  }
}

async function groqCall(buf, { hint = '', mime = '', format = 'verbose_json' } = {}) {
  const form = new FormData();
  const type = mime && mime.includes('/') ? mime.split(';')[0] : 'audio/webm';
  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : 'webm';
  form.append('file', new Blob([buf], { type }), `utt.${ext}`);
  form.append('model', GROQ_MODEL);
  form.append('language', 'zh');
  form.append('response_format', format);
  form.append('temperature', '0');
  if (hint) form.append('prompt', String(hint).slice(0, 220));

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${GROQ_KEY()}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const d = await r.json();
  return clean(d.text, { engine: 'groq', confidence: confidenceOf(d.segments) });
}

// Collapse Whisper's per-segment statistics into one 0–1 number.
//   avg_logprob    — mean token log-probability; > -0.5 is solid, < -1.0 is a guess
//   no_speech_prob — how sure the model is the audio was not speech at all
// Both backends expose these (mlx_whisper writes the same fields into its JSON), so
// one function serves both. Returns null when the backend gave us nothing to go on —
// callers must treat null as "unknown", never as "bad".
export function confidenceOf(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const dur = (s) => Math.max(0.1, (s.end ?? 0) - (s.start ?? 0));
  const total = segments.reduce((a, s) => a + dur(s), 0);
  const logprob = segments.reduce((a, s) => a + (s.avg_logprob ?? -1) * dur(s), 0) / total;
  const noSpeech = segments.reduce((a, s) => a + (s.no_speech_prob ?? 0) * dur(s), 0) / total;
  // Mapped to 0–1, then discounted by the probability it was not speech at all.
  // Calibrated against measurements rather than intuition: a CLEAN synthesized "這是貓"
  // scores avg_logprob −0.57, so a curve that treated −0.5 as marginal would flag
  // perfect audio as doubtful and make the confirm step fire constantly. Short Chinese
  // clips sit lower than English intuition suggests. −1.2 → 0, −0.3 → 1.
  const fromLogprob = Math.max(0, Math.min(1, (logprob + 1.2) / 0.9));
  return Math.round(fromLogprob * (1 - noSpeech) * 100) / 100;
}

// ── Resident model ──────────────────────────────────────────────────────────
// The CLI reloads the model per invocation. Measured on this machine: 4 clips through
// one process took 10.4s against 5.3s for one clip, i.e. ~3.5s of fixed startup and
// ~1.7s of real work per utterance. Keeping the model resident is therefore worth
// roughly a 3x reduction in the pause between the learner finishing a sentence and
// the teacher answering — the difference between a conversation and a walkie-talkie.
//
// Everything here degrades to the CLI path on any failure; the daemon is an
// optimisation, never a dependency.
let _daemon = null;

function startDaemon() {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, 'whisperd.py');
  if (!existsSync(script)) return null;
  const warm = join(here, 'assets', 'warm.mp3');
  const proc = spawn(process.env.PYTHON_BIN || 'python3',
    [script, MODEL, ...(existsSync(warm) ? [warm] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  const d = { proc, queue: [], buf: '', ready: null, dead: false };

  d.ready = new Promise((resolve) => {
    const onLine = (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.fatal) { d.dead = true; resolve(false); return; }
      if (msg.ready) { resolve(true); return; }
      // Results arrive strictly in request order, so the head of the queue owns this one.
      const job = d.queue.shift();
      if (job) (msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg));
    };
    proc.stdout.on('data', (c) => {
      d.buf += c;
      let i;
      while ((i = d.buf.indexOf('\n')) >= 0) { const line = d.buf.slice(0, i).trim(); d.buf = d.buf.slice(i + 1); if (line) onLine(line); }
    });
    // stderr MUST be drained. A piped stream nobody reads fills its buffer and then
    // blocks the child mid-write — the worker would appear to hang rather than fail,
    // which is the worst way for an optional component to break. Only the first lines
    // are worth keeping: that is where an import or model error appears.
    let errSeen = 0;
    proc.stderr.on('data', (c) => { if (errSeen++ < 3) console.warn('[stt worker]', String(c).trim().slice(0, 200)); });
    const die = () => {
      d.dead = true; resolve(false);
      // Anything still waiting must fail loudly rather than hang the request forever.
      while (d.queue.length) d.queue.shift().reject(new Error('whisper worker exited'));
      if (_daemon === d) _daemon = null;
    };
    proc.on('close', die);
    proc.on('error', die);
    // Warmup loads and compiles the model; on a cold cache that is a download.
    setTimeout(() => resolve(false), 180000);
  });
  return d;
}

async function daemon() {
  if (_daemon?.dead) _daemon = null;
  if (!_daemon) _daemon = startDaemon();
  if (!_daemon) return null;
  return (await _daemon.ready) ? _daemon : null;
}

function askDaemon(d, path, prompt) {
  return new Promise((resolve, reject) => {
    let timer;
    const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
    const job = { resolve: settle(resolve), reject: settle(reject) };
    timer = setTimeout(() => {
      // Drop the slot so later results do not pair with the wrong request — the
      // protocol is positional, and a silently abandoned job would shift every
      // subsequent transcript onto the previous utterance.
      const i = d.queue.indexOf(job);
      if (i >= 0) d.queue.splice(i, 1);
      reject(new Error('whisper worker timeout'));
    }, 60000);
    d.queue.push(job);
    try { d.proc.stdin.write(JSON.stringify({ path, prompt }) + '\n'); }
    catch (e) { job.reject(e); }
  });
}

// Load the model at boot rather than on the learner's first sentence. Measured: the
// first transcription through a cold worker took 5.4s against 1.6s once resident.
export function warmSTT() {
  if (!localAvailable()) return;
  daemon().then(d => console.log(d ? `[stt] whisper worker ready (${MODEL})` : '[stt] whisper worker unavailable — using CLI per utterance'))
    .catch(() => {});
}

async function transcribeLocal(buf, { hint = '' } = {}) {
  const dir = join(tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const audio = join(dir, 'utt.webm');
  writeFileSync(audio, buf);
  try {
    const d = await daemon();
    if (d) {
      try {
        const r = await askDaemon(d, audio, String(hint).slice(0, 220));
        return clean(r.text, { engine: 'mlx', confidence: confidenceOf(r.segments) });
      } catch (e) {
        console.warn('[stt] resident worker failed, falling back to CLI:', e.message);
      }
    }
    const args = [audio, '--model', MODEL, '--language', 'zh', '--task', 'transcribe',
      '--output-format', 'json', '--output-dir', dir, '--output-name', 'utt', '--verbose', 'False',
      // Greedy decoding: the temperature-fallback ladder is what lets Whisper wander
      // into invented text on marginal audio, and a learner's single quiet syllable is
      // exactly marginal audio.
      '--temperature', '0',
      // Each utterance is independent. Carrying the previous transcript forward is
      // what makes Whisper repeat itself into a loop across a hands-free session.
      '--condition-on-previous-text', 'False'];
    // A vocabulary hint (the words in play this session) measurably improves
    // recognition of isolated learner words.
    if (hint) args.push('--initial-prompt', String(hint).slice(0, 220));
    await run(_bin, args, 60000);
    const out = join(dir, 'utt.json');
    if (!existsSync(out)) return { transcript: '', engine: 'mlx', confidence: null };
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    return clean(parsed.text, { engine: 'mlx', confidence: confidenceOf(parsed.segments) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('whisper timeout')); }, timeoutMs);
    p.stderr.on('data', c => { err += c; });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(err.slice(-300) || `exit ${code}`)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}
