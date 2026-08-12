import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { spokenCaptureSupported, captureSpoken, ttsSupported, speak } from '../lib/speech.js';

export default function Onboarding({ onDone }) {
  const [meta, setMeta] = useState(null);
  const [topics, setTopics] = useState([]);
  const [level, setLevel] = useState('exam');   // measuring beats self-reporting
  const [mic, setMic] = useState(null);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { api.meta().then(setMeta); }, []);
  if (!meta) return null;

  const toggle = (t) => setTopics(cur => cur.includes(t) ? cur.filter(x => x !== t) : cur.length < 3 ? [...cur, t] : cur);

  async function micCheck() {
    // Any capture path counts — local Whisper works where Web Speech doesn't.
    if (!spokenCaptureSupported()) { setMic('unsupported'); return; }
    setMic('listening');
    // Heard-anything counts: a transcript OR mic voice activity (the acoustic
    // path still yields tone data even when transcription comes back empty).
    try {
      const cap = await captureSpoken({ expectedSyllables: 2, timeoutMs: 5000, hint: '你好' });
      setMic(cap.transcript || cap.heardVoice ? 'ok' : 'failed');
    } catch { setMic('failed'); }
  }

  async function finish() {
    setSaving(true);
    // Interests and mic are saved either way; the STARTING POSITION is set by the
    // exam (or by skipping it), never by this form.
    await api.saveOnboarding({ interestTopics: topics, knownUnits: 0, micWorks: mic === 'ok' });
    if (level !== 'exam') await api.placementSkip().catch(() => {});
    onDone?.();
    navigate(level === 'exam' ? '/placement' : '/');
  }

  return (
    <div className="animate-rise">
      <div className="text-center mb-9">
        <div className="hanzi text-4xl text-ink mb-3">你好</div>
        <h1 className="text-3xl font-semibold tracking-tightish">Let’s set up your path</h1>
        <p className="text-ink-soft mt-2">Speak-and-read Mandarin, built from {meta.counts.words.toLocaleString()} words and {meta.counts.sentences.toLocaleString()} sentences.</p>
      </div>

      <Step n="1" title="Pick 2–3 interest topics" hint="Words in these get bumped earlier in your path.">
        <div className="flex flex-wrap gap-2">
          {meta.topics.map(t => (
            <button key={t} onClick={() => toggle(t)}
              className={`px-3.5 py-1.5 rounded-full text-[13px] capitalize border transition
                ${topics.includes(t) ? 'bg-ink text-white border-ink' : 'bg-white border-line text-ink-soft hover:border-ink/30'}`}>
              {t}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-ink-faint mt-3">{topics.length}/3 selected</p>
      </Step>

      <Step n="2" title="Mic check" hint="Speaking cards use your browser’s speech recognition (Chrome/Edge). Optional.">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={micCheck}
            className="px-4 py-2 rounded-xl bg-white border border-line text-ink-soft hover:text-ink hover:shadow-soft transition text-sm inline-flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${mic === 'listening' ? 'bg-jade-400 animate-pulse' : 'bg-stone-300'}`} />
            {mic === 'listening' ? 'Listening… say 你好' : 'Test mic'}
          </button>
          {mic === 'ok' && <span className="text-jade-600 text-sm">✓ Heard you</span>}
          {mic === 'failed' && <span className="text-amber-600 text-sm">No speech — you can still self-grade</span>}
          {mic === 'unsupported' && <span className="text-ink-faint text-sm">Not supported — listen-and-repeat mode</span>}
          {ttsSupported() && <button onClick={() => speak('你好')} className="text-sm text-jade-600 ml-auto">◍ test audio</button>}
        </div>
      </Step>

      {/* Step 3 used to ask the learner to self-report how many units they already
          knew — a question nobody can answer accurately about a language. The
          entrance exam measures it instead, in about a minute, and skipping it is a
          real option rather than a worse one. */}
      <Step n="3" title="Where do you start?" hint="Laoshi can find this out in about a minute — or just start from the beginning.">
        <div className="space-y-2.5">
          <Radio checked={level === 'exam'} onChange={() => setLevel('exam')}
            label="Find out — a quick check with Laoshi" />
          <Radio checked={level === 'beginner'} onChange={() => setLevel('beginner')}
            label="Start me at the very beginning" />
        </div>
      </Step>

      <div className="flex items-center gap-4 mt-2">
        <button onClick={finish} disabled={topics.length === 0 || saving}
          className="px-7 py-3 rounded-2xl bg-ink text-white font-medium shadow-soft hover:shadow-lift transition disabled:opacity-40">
          {saving ? 'Building your path…' : level === 'exam' ? 'Take the quick check →' : 'Start learning →'}
        </button>
        <span className="text-[12px] text-ink-faint">
          {level === 'exam' ? 'No score — it just finds your starting point.' : 'The app speeds up on its own as soon as you show you can go faster.'}
        </span>
      </div>
    </div>
  );
}

function Step({ n, title, hint, children }) {
  return (
    <section className="card-face p-6 mb-4">
      <div className="flex items-baseline gap-3 mb-1">
        <span className="grid place-items-center w-6 h-6 rounded-full bg-jade-50 text-jade-600 text-[12px] font-semibold shrink-0">{n}</span>
        <h2 className="font-medium text-ink">{title}</h2>
      </div>
      {hint && <p className="text-[13px] text-ink-faint mb-3 ml-9">{hint}</p>}
      <div className="ml-9">{children}</div>
    </section>
  );
}

function Radio({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer group">
      <span className={`grid place-items-center w-4.5 h-4.5 rounded-full border transition
        ${checked ? 'border-ink' : 'border-line group-hover:border-ink/40'}`} style={{ width: 18, height: 18 }}>
        {checked && <span className="w-2.5 h-2.5 rounded-full bg-ink" />}
      </span>
      <input type="radio" checked={checked} onChange={onChange} className="sr-only" />
      <span className="text-sm text-ink-soft">{label}</span>
    </label>
  );
}
