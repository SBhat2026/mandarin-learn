import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Loading } from './Home.jsx';
import { playAudio, speak, speakSlow, normalizeHanzi, captureSpoken, spokenCaptureSupported } from '../lib/speech.js';
import { TonedHanzi, TonedPinyin, TonedSentence } from '../components/Toned.jsx';
import { TONE_COLORS } from '../lib/tones.js';

const RATING = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
const GRADES = [[1, 'Again', 'text-rose-600'], [2, 'Hard', 'text-amber-600'], [3, 'Good', 'text-emerald-600'], [4, 'Easy', 'text-sky-600']];

// Human-readable label for each exercise so the learner knows the task, never a score.
const TASK = {
  recognition: 'What does it mean?',
  reading: 'Read it aloud — pinyin & meaning',
  listening: 'Listen — what did you hear?',
  pronounce: 'Say it clearly',
  production: 'Say it in Mandarin',
  cloze: 'Fill in the missing word',
};

export default function ExerciseFlow() {
  const [lesson, setLesson] = useState(null);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState('prompt');   // 'teach' | 'prompt' | 'revealed'
  const [heard, setHeard] = useState(null);
  const [done, setDone] = useState({ count: 0, again: 0 });
  const startedAt = useRef(Date.now());
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.lesson(16).then(l => {
      setLesson(l); setIdx(0); setHeard(null);
      setPhase(l.items[0]?.teach ? 'teach' : 'prompt');
      startedAt.current = Date.now();
    });
  }, []);
  useEffect(load, [load]);

  const item = lesson?.items[idx];

  // Auto-play audio for listening tasks when the prompt appears.
  useEffect(() => {
    if (item && phase === 'prompt' && item.exercise === 'listening') {
      playAudio({ audio_path: item.audio, hanzi: item.hanzi });
    }
  }, [item, phase]);

  const advance = useCallback(() => {
    const next = idx + 1;
    if (next >= (lesson?.items.length || 0)) { setIdx(next); return; }
    setIdx(next); setHeard(null);
    setPhase(lesson.items[next]?.teach ? 'teach' : 'prompt');
    startedAt.current = Date.now();
  }, [idx, lesson]);

  const grade = useCallback((rating) => {
    if (!item) return;
    const durationMs = Date.now() - startedAt.current;
    // Spoken tasks carry the raw capture; the server derives heard-tones,
    // segmental confusion and fluency from it (invisibly).
    const spoken = heard?.spoken || null;
    api.review({ cardId: item.cardId, rating, durationMs, dimension: item.dimension,
      exercise: item.exercise, targetTone: item.tone_pattern || null, spoken }).catch(() => {});
    setDone(d => ({ count: d.count + 1, again: d.again + (rating === 1 ? 1 : 0) }));
    advance();
  }, [item, heard, advance]);

  const reveal = useCallback(() => setPhase('revealed'), []);

  // Keyboard: space/enter reveals, 1–4 grade once revealed.
  useEffect(() => {
    const onKey = (e) => {
      if (phase === 'teach' && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); setPhase('prompt'); return; }
      if (phase === 'prompt' && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); reveal(); }
      else if (phase === 'revealed' && ['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, reveal, grade]);

  if (!lesson) return <Loading />;
  if (!lesson.items.length) return <AllDone counts={lesson.counts} onReload={load} />;
  if (idx >= lesson.items.length) return <SessionComplete done={done} onReload={load} navigate={navigate} />;

  const suggested = heard?.match ? RATING.Good : null;

  return (
    <div>
      <Progress idx={idx} total={lesson.items.length} isNew={item.isNew} dimension={item.dimension} />
      {phase === 'teach'
        ? <Teach item={item} onStart={() => setPhase('prompt')} />
        : <ExerciseCard item={item} phase={phase} heard={heard} setHeard={setHeard} onReveal={reveal} />}
      {phase === 'revealed' && <Grades onGrade={grade} suggested={suggested} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Progress({ idx, total, isNew, dimension }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2 text-[12px] text-ink-faint">
        <span className="inline-flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full font-medium ${isNew ? 'bg-jade-100 text-jade-700' : 'bg-ink/5 text-ink-soft'}`}>
            {isNew ? 'New word' : 'Review'}
          </span>
        </span>
        <span>{idx + 1} / {total}</span>
      </div>
      <div className="h-1.5 bg-line rounded-full overflow-hidden">
        <div className="h-full bg-ink rounded-full transition-all duration-300" style={{ width: `${(idx / total) * 100}%` }} />
      </div>
    </div>
  );
}

// Audio buttons: normal + slow replay.
function AudioButtons({ item, big = false }) {
  return (
    <div className="flex items-center justify-center gap-2">
      <button onClick={() => playAudio({ audio_path: item.audio, hanzi: item.hanzi })}
        className={`rounded-full bg-ink text-white grid place-items-center hover:opacity-90 transition ${big ? 'w-16 h-16 text-2xl' : 'w-11 h-11 text-lg'}`} title="Play (space)">🔊</button>
      <button onClick={() => playAudio({ audio_path: item.audio, hanzi: item.hanzi }, { slow: true })}
        className="w-11 h-11 rounded-full bg-white border border-line text-ink-soft grid place-items-center hover:border-ink/30 transition text-sm" title="Slow replay">🐢</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Teach-then-test intro: character families before the first test.
function Teach({ item, onStart }) {
  const fams = item.teach?.families || [];
  return (
    <div className="text-center animate-fade">
      <div className="text-[12px] uppercase tracking-widest text-jade-600 mb-4">New · learn first</div>
      <TonedHanzi hanzi={item.hanzi} pinyin={item.pinyin} size="text-7xl" />
      <div className="mt-3"><TonedPinyin pinyin={item.pinyin} className="text-xl" /></div>
      <div className="mt-2 text-lg text-ink-soft">{item.gloss}</div>
      <div className="mt-4"><AudioButtons item={item} /></div>

      {fams.length > 0 && (
        <div className="mt-8 grid gap-3 text-left max-w-lg mx-auto">
          {fams.map((f, i) => <CharCard key={i} f={f} />)}
        </div>
      )}

      {item.example && (
        <div className="mt-6 max-w-lg mx-auto p-4 rounded-2xl bg-white border border-line text-left">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">In context</div>
          <TonedSentence hanzi={item.example.hanzi} pinyin={item.example.pinyin} size="text-2xl" />
          <div className="text-sm text-ink-soft mt-1">{item.example.english}</div>
        </div>
      )}

      <button onClick={onStart}
        className="mt-8 px-8 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">
        Got it — test me <span className="opacity-60 text-sm ml-1">space</span>
      </button>
    </div>
  );
}

function CharCard({ f }) {
  return (
    <div className="p-3 rounded-xl bg-white border border-line flex gap-3 items-start">
      <div className="hanzi text-4xl text-ink leading-none w-12 text-center">{f.char}</div>
      <div className="flex-1 text-sm">
        {f.definition && <div className="text-ink">{f.definition}</div>}
        <div className="text-ink-faint text-[12px] mt-1 space-y-0.5">
          {f.radicalMeaning && f.radicalPeers?.length ? <div>Radical <span className="hanzi text-ink-soft">{f.radical}</span> means "{f.radicalMeaning}" · <span className="hanzi text-ink-soft">{f.radicalPeers.join(' ')}</span></div> : null}
          {f.phonetic && f.phoneticPeers?.length ? <div>Sound series <span className="hanzi text-ink-soft">{f.phonetic}</span>: <span className="hanzi text-ink-soft">{f.phoneticPeers.join(' ')}</span></div> : null}
          {f.components?.length ? <div>Built from <span className="hanzi text-ink-soft">{f.components.join(' ')}</span></div> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prompt/answer body, specialized per exercise type.
function ExerciseCard({ item, phase, heard, setHeard, onReveal }) {
  const revealed = phase === 'revealed';
  const ex = item.exercise;
  const isSpoken = ex === 'pronounce' || ex === 'production';

  return (
    <div className="text-center animate-fade min-h-[300px] flex flex-col justify-center">
      <div className="text-[13px] text-ink-faint mb-6">{TASK[ex] || 'Recall'}</div>

      {/* Prompt */}
      {ex === 'listening' && <AudioButtons item={item} big />}

      {ex === 'cloze' && item.cloze && (
        <div>
          <TonedSentence hanzi={item.cloze.blanked} pinyin={revealed ? item.cloze.pinyin : ''} size="text-4xl" />
          <div className="text-sm text-ink-soft mt-3">{item.cloze.english}</div>
        </div>
      )}

      {ex === 'production' && (
        <div className="text-2xl text-ink">{item.gloss || item.english}</div>
      )}

      {(ex === 'recognition' || ex === 'pronounce') && (
        <TonedHanzi hanzi={item.hanzi} pinyin={item.pinyin} size="text-7xl" />
      )}

      {ex === 'reading' && (
        <TonedHanzi hanzi={item.hanzi} pinyin={revealed ? item.pinyin : ''} size="text-7xl" />
      )}

      {(ex === 'recognition' || ex === 'pronounce') && (
        <div className="mt-3"><TonedPinyin pinyin={item.pinyin} className="text-xl" /></div>
      )}

      {/* Spoken tasks: record button */}
      {isSpoken && !revealed && (
        <RecordControl item={item} onHeard={(h) => { setHeard(h); onReveal(); }} />
      )}

      {/* Reveal */}
      {revealed && (
        <div className="mt-6 animate-fade">
          {ex !== 'recognition' && ex !== 'pronounce' && (
            <TonedHanzi hanzi={item.hanzi} pinyin={item.pinyin} size="text-5xl" />
          )}
          <div className="mt-2"><TonedPinyin pinyin={item.pinyin} className="text-lg" /></div>
          <div className="text-lg text-ink mt-1">{item.gloss || item.english}</div>
          <div className="mt-3"><AudioButtons item={item} /></div>

          {heard && heard.transcript && (
            <div className={`mt-4 text-sm ${heard.match ? 'text-emerald-600' : 'text-amber-600'}`}>
              Heard: <span className="hanzi">{heard.transcript}</span> {heard.match ? '✓ match' : '≠ target'}
            </div>
          )}
          {heard && !heard.transcript && heard.heardVoice && (
            <div className="mt-4 text-sm text-ink-faint">Got it — listen back and compare 👂</div>
          )}

          {item.example && ex !== 'cloze' && (
            <div className="mt-5 max-w-md mx-auto p-4 rounded-2xl bg-white border border-line">
              <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Example</div>
              <TonedSentence hanzi={item.example.hanzi} pinyin={item.example.pinyin} size="text-2xl" />
              <div className="text-sm text-ink-soft mt-1">{item.example.english}</div>
              <button onClick={() => playAudio({ audio_path: item.example.audio, hanzi: item.example.hanzi })}
                className="mt-2 text-xs text-jade-600 hover:underline">▶ hear sentence</button>
            </div>
          )}
        </div>
      )}

      {/* Reveal button for non-spoken tasks */}
      {!revealed && !isSpoken && (
        <button onClick={onReveal}
          className="mt-10 px-8 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition mx-auto">
          Show answer <span className="opacity-60 text-sm ml-1">space</span>
        </button>
      )}
    </div>
  );
}

function RecordControl({ item, onHeard }) {
  const [state, setState] = useState('idle');   // idle | listening | error
  const [level, setLevel] = useState(0);
  const supported = spokenCaptureSupported();
  const canSelfGrade = !supported;
  const expectedSyllables = item.tone_pattern ? String(item.tone_pattern).split('-').length : 1;

  const record = async () => {
    if (!supported) { onHeard({ transcript: '', match: false, unsupported: true }); return; }
    setState('listening');
    try {
      const cap = await captureSpoken({ expectedSyllables, timeoutMs: 6000, onLevel: (r) => setLevel(r) });
      const match = cap.transcript ? normalizeHanzi(cap.transcript).includes(normalizeHanzi(item.hanzi)) : false;
      // Reveal even when STT heard nothing but the mic captured voice — the
      // acoustic tone signal still counts.
      onHeard({
        transcript: cap.transcript, match, spoken: cap,
        heardVoice: cap.heardVoice, noText: !cap.transcript,
      });
    } catch { setState('error'); onHeard({ transcript: '', match: false }); }
  };

  const scale = 1 + Math.min(0.6, level * 6);

  return (
    <div className="mt-8">
      <button onClick={record} disabled={state === 'listening'}
        style={state === 'listening' ? { transform: `scale(${scale})` } : undefined}
        className={`w-20 h-20 rounded-full grid place-items-center text-3xl mx-auto transition ${
          state === 'listening' ? 'bg-rose-500 text-white shadow-lg shadow-rose-200' : 'bg-ink text-white hover:opacity-90'}`}>
        🎤
      </button>
      <div className="mt-3 text-sm text-ink-faint">
        {state === 'listening' ? 'Listening…' : supported ? 'Tap and say it aloud' : 'Speak aloud, then self-grade'}
      </div>
      {canSelfGrade && (
        <button onClick={() => onHeard({ transcript: '', match: false, unsupported: true })}
          className="mt-3 text-xs text-jade-600 hover:underline">I said it — reveal</button>
      )}
    </div>
  );
}

function Grades({ onGrade, suggested }) {
  return (
    <div className="mt-10 grid grid-cols-4 gap-2 max-w-md mx-auto">
      {GRADES.map(([n, label, color]) => (
        <button key={n} onClick={() => onGrade(n)}
          className={`py-3 rounded-xl border font-medium text-sm transition ${
            suggested === n ? 'border-ink bg-ink/5' : 'border-line bg-white hover:border-ink/30'}`}>
          <div className={color}>{label}</div>
          <div className="text-[11px] text-ink-faint mt-0.5">{n}</div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AllDone({ counts, onReload }) {
  return (
    <div className="text-center py-16">
      <div className="hanzi text-6xl text-jade-500 mb-4">好</div>
      <h2 className="text-xl font-medium text-ink">Nothing due right now</h2>
      <p className="text-ink-soft mt-2 text-sm">
        {counts.newDoneToday >= counts.dailyNew
          ? "You've learned today's new words. Reviews will appear as they come due."
          : 'Come back when cards are due, or keep chatting with Laoshi.'}
      </p>
      <button onClick={onReload} className="mt-6 px-6 py-2.5 rounded-full bg-ink text-white text-sm">Check again</button>
    </div>
  );
}

function SessionComplete({ done, onReload, navigate }) {
  // Refresh the hidden model in the background when a session ends.
  useEffect(() => { api.modelBackground().catch(() => {}); }, []);
  return (
    <div className="text-center py-16 animate-fade">
      <div className="hanzi text-6xl text-jade-500 mb-4">棒</div>
      <h2 className="text-xl font-medium text-ink">Session complete</h2>
      <p className="text-ink-soft mt-2 text-sm">{done.count} cards · {done.again} to revisit</p>
      <div className="mt-6 flex gap-2 justify-center">
        <button onClick={onReload} className="px-6 py-2.5 rounded-full bg-ink text-white text-sm">Keep going</button>
        <button onClick={() => navigate('/converse')} className="px-6 py-2.5 rounded-full bg-white border border-line text-ink text-sm">Chat with Laoshi</button>
      </div>
    </div>
  );
}
