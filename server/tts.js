// Neural TTS (Microsoft Edge voices) with a local mp3 cache. Free, near-native
// zh-CN voices; every utterance is synthesized once and cached under
// data/media/tts/, so repeated words/sentences cost nothing and work offline
// after first play. The client falls back to browser speechSynthesis when this
// endpoint fails (offline, service change).
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR } from './db.js';

const VOICE = process.env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural';
const TTS_DIR = join(MEDIA_DIR, 'tts');
mkdirSync(TTS_DIR, { recursive: true });

let _tts = null, _fmt = null;
async function engine() {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  _fmt = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
  const t = new MsEdgeTTS();
  await t.setMetadata(VOICE, _fmt);
  return t;
}

const inflight = new Map();   // hash → Promise, so concurrent requests synthesize once

// Synthesize (or fetch cached) mp3 for a Mandarin string. `slow` stretches the
// rate for learner repetition. Returns the media-relative filename.
export async function synthesize(text, { slow = false } = {}) {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) throw new Error('empty text');
  const key = createHash('sha1').update(`${VOICE}|${slow ? 'slow' : 'norm'}|${clean}`).digest('hex');
  const file = `tts/${key}.mp3`;
  const abs = join(TTS_DIR, `${key}.mp3`);
  if (existsSync(abs)) return file;
  if (inflight.has(key)) { await inflight.get(key); return file; }

  const job = (async () => {
    const tts = await engine();
    const { audioStream } = await tts.toStream(clean, slow ? { rate: '-35%' } : undefined);
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', c => chunks.push(c));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    if (buf.length < 500) throw new Error('empty audio');
    writeFileSync(abs, buf);
  })();
  inflight.set(key, job);
  try { await job; } finally { inflight.delete(key); }
  return file;
}
