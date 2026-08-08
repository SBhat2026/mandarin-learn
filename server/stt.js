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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// medium benchmarks at ~1.55x small's warm latency (1.33s → 2.05s on a 3s clip),
// well inside the accepted budget, and is markedly better on accented/non-native
// speech — which is exactly what a learner produces. Override with WHISPER_MODEL.
const MODEL = process.env.WHISPER_MODEL || 'mlx-community/whisper-medium-mlx';

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

// Transcribe an audio buffer. Returns { transcript, engine } (empty transcript
// when Whisper heard nothing). Utterances are a few seconds long.
export async function transcribe(buf, { hint = '', mime = '' } = {}) {
  if (!sttAvailable()) throw new Error('no STT backend (install mlx_whisper or set GROQ_API_KEY)');
  if (!buf?.length || buf.length < 1000) return { transcript: '', engine: sttEngine() };
  if (!localAvailable()) return transcribeGroq(buf, { hint, mime });
  return transcribeLocal(buf, { hint });
}

// Hosted path. Groq's OpenAI-compatible transcription endpoint takes multipart
// audio; `prompt` biases recognition toward the session's vocabulary exactly as
// --initial-prompt does locally.
async function transcribeGroq(buf, { hint = '', mime = '' } = {}) {
  const form = new FormData();
  const type = mime && mime.includes('/') ? mime.split(';')[0] : 'audio/webm';
  const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('mpeg') ? 'mp3' : 'webm';
  form.append('file', new Blob([buf], { type }), `utt.${ext}`);
  form.append('model', GROQ_MODEL);
  form.append('language', 'zh');
  form.append('response_format', 'json');
  if (hint) form.append('prompt', String(hint).slice(0, 120));

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${GROQ_KEY()}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const d = await r.json();
  return { transcript: String(d.text || '').trim(), engine: 'groq' };
}

async function transcribeLocal(buf, { hint = '' } = {}) {
  const dir = join(tmpdir(), `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const audio = join(dir, 'utt.webm');
  writeFileSync(audio, buf);
  try {
    const args = [audio, '--model', MODEL, '--language', 'zh', '--task', 'transcribe',
      '--output-format', 'json', '--output-dir', dir, '--output-name', 'utt', '--verbose', 'False'];
    // A vocabulary hint (the words in play this session) measurably improves
    // recognition of isolated learner words.
    if (hint) args.push('--initial-prompt', String(hint).slice(0, 120));
    await run(_bin, args, 60000);
    const out = join(dir, 'utt.json');
    if (!existsSync(out)) return { transcript: '', engine: 'mlx' };
    const d = JSON.parse(readFileSync(out, 'utf8'));
    return { transcript: String(d.text || '').trim(), engine: 'mlx' };
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
