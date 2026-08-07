// Local Whisper STT (mlx-whisper on Apple Silicon). The browser records a short
// utterance (MediaRecorder webm/mp4), posts the blob here, and gets back a
// Mandarin transcript — far more accurate on learner speech than the Web Speech
// API, fully offline, no per-use cost. ffmpeg (via mlx_whisper) handles decode.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// medium benchmarks at ~1.55x small's warm latency (1.33s → 2.05s on a 3s clip),
// well inside the accepted budget, and is markedly better on accented/non-native
// speech — which is exactly what a learner produces. Override with WHISPER_MODEL.
const MODEL = process.env.WHISPER_MODEL || 'mlx-community/whisper-medium-mlx';

let _bin;   // resolved mlx_whisper path, or null when unavailable
export function sttAvailable() {
  if (_bin !== undefined) return Boolean(_bin);
  try { _bin = execFileSync('which', ['mlx_whisper']).toString().trim() || null; }
  catch { _bin = null; }
  return Boolean(_bin);
}

// Transcribe an audio buffer. Returns { transcript } (empty string when Whisper
// heard nothing). Serialized lightly — utterances are a few seconds long.
export async function transcribe(buf, { hint = '' } = {}) {
  if (!sttAvailable()) throw new Error('mlx_whisper not installed');
  if (!buf?.length || buf.length < 1000) return { transcript: '' };
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
    if (!existsSync(out)) return { transcript: '' };
    const d = JSON.parse(readFileSync(out, 'utf8'));
    return { transcript: String(d.text || '').trim() };
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
