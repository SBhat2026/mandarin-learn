import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { playAudio, speak, normalizeHanzi, captureSpoken, spokenCaptureSupported } from '../lib/speech.js';
import { TonedHanzi, TonedPinyin, ScriptBubble, scriptModeFromLevel } from '../components/Toned.jsx';

// Practice as a continuous concept-acquisition loop: meet a focal concept, see
// how it connects (transferable families), then USE it in a real conversation
// with Laoshi that reuses the connected vocabulary. Understanding is inferred
// from the dialogue — no grade buttons.
export default function ConversationLesson({ plan, onDone, onFallback }) {
  const [phase, setPhase] = useState('intro');   // intro | preview | talk | wrap
  const scriptMode = scriptModeFromLevel(plan.scriptLevel);

  if (phase === 'intro') return <Intro plan={plan} onNext={() => setPhase('preview')} />;
  if (phase === 'preview') return <Preview plan={plan} onNext={() => setPhase('talk')} />;
  if (phase === 'talk') return <Talk plan={plan} scriptMode={scriptMode} onFinish={() => setPhase('wrap')} onFallback={onFallback} />;
  return <Wrap plan={plan} onDone={onDone} />;
}

// ---- 1. Meet the concept (pronunciation + meaning before hanzi) -----------
function Intro({ plan, onNext }) {
  const f = plan.focal;
  useEffect(() => { const t = setTimeout(() => playAudio({ audio_path: f.audio, hanzi: f.hanzi }), 400); return () => clearTimeout(t); }, []);
  return (
    <div className="text-center animate-fade py-6">
      <div className="text-[12px] uppercase tracking-widest text-jade-600 mb-6">New concept</div>
      <div className="text-5xl font-medium"><TonedPinyin pinyin={f.pinyin} /></div>
      <div className="text-2xl text-ink mt-3">{f.gloss}</div>
      <div className="hanzi text-3xl text-ink-faint mt-4">{f.hanzi}</div>
      <div className="mt-6 flex items-center justify-center gap-2">
        <button onClick={() => playAudio({ audio_path: f.audio, hanzi: f.hanzi })} className="w-14 h-14 rounded-full bg-ink text-white grid place-items-center text-xl">🔊</button>
        <button onClick={() => playAudio({ audio_path: f.audio, hanzi: f.hanzi }, { slow: true })} className="w-12 h-12 rounded-full bg-white border border-line grid place-items-center">🐢</button>
      </div>
      <button onClick={onNext} className="mt-10 px-8 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">
        See how it connects →
      </button>
    </div>
  );
}

// ---- 2. Instructional families (transferable patterns) --------------------
function Preview({ plan, onNext }) {
  const related = [...(plan.exposeRelated || []), ...(plan.reinforce || [])];
  return (
    <div className="animate-fade py-2">
      <h2 className="text-center text-lg font-medium text-ink mb-1">How <span className="hanzi">{plan.focal.hanzi}</span> connects</h2>
      <p className="text-center text-sm text-ink-faint mb-6">Patterns that unlock many characters at once.</p>

      <div className="space-y-3 max-w-xl mx-auto">
        {(plan.patterns || []).map((p, i) => <PatternCard key={i} p={p} />)}
        {!plan.patterns?.length && <p className="text-center text-sm text-ink-faint">This one you'll pick up through conversation.</p>}
      </div>

      {related.length > 0 && (
        <div className="mt-6 max-w-xl mx-auto">
          <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-2 text-center">You'll also use</div>
          <div className="flex flex-wrap justify-center gap-2">
            {related.map((w) => (
              <button key={w.wordId} onClick={() => speak(w.hanzi)}
                className="px-3 py-1.5 rounded-full bg-white border border-line text-sm hover:border-ink/30">
                <span className="hanzi">{w.hanzi}</span> <span className="text-ink-faint">{w.pinyin}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="text-center">
        <button onClick={onNext} className="mt-8 px-8 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">
          Talk with Laoshi →
        </button>
      </div>
    </div>
  );
}

function PatternCard({ p }) {
  return (
    <div className="p-4 rounded-2xl bg-white border border-line">
      <div className="flex items-center gap-3 mb-2">
        <span className="hanzi text-3xl text-ink">{p.char}</span>
        <span className="text-sm text-ink-soft">{p.pinyin} · {p.definition}</span>
      </div>
      <div className="space-y-1.5 text-sm">
        {p.semantic && <FamilyRow tag="meaning" color="text-emerald-700 bg-emerald-50" lesson={p.semantic.lesson} peers={p.semantic.peers} />}
        {p.phonetic && <FamilyRow tag="sound" color="text-sky-700 bg-sky-50" lesson={p.phonetic.lesson} peers={p.phonetic.peers} />}
        {p.visual && <FamilyRow tag="look-alike" color="text-amber-700 bg-amber-50" lesson={p.visual.lesson} peers={p.visual.peers} />}
      </div>
    </div>
  );
}

function FamilyRow({ tag, color, lesson, peers }) {
  return (
    <div className="flex gap-2 items-baseline">
      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${color}`}>{tag}</span>
      <div className="flex-1">
        <span className="text-ink-soft">{lesson}</span>
        {peers?.length > 0 && (
          <span className="inline-flex flex-wrap gap-1.5 ml-1 align-middle">
            {peers.slice(0, 4).map((x, i) => (
              <button key={i} onClick={() => speak(x.char)} className="hover:text-jade-600" title={x.definition || ''}>
                <span className="hanzi text-ink">{x.char}</span>{x.pinyin && <span className="text-ink-faint text-[12px] ml-0.5">{x.pinyin}</span>}
              </button>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- 3. Conversation with Laoshi -----------------------------------------
function Talk({ plan, scriptMode, onFinish, onFallback }) {
  const [turns, setTurns] = useState([]);   // {role, hanzi, pinyin, english, note}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(new Set());
  const [learnerCount, setLearnerCount] = useState(0);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const scroller = useRef(null);
  const opened = useRef(false);
  const pendingSpoken = useRef(null);       // {transcript, spoken} awaiting confirm/send
  const target = plan.targetVocab || [];
  const canSpeak = spokenCaptureSupported();

  useEffect(() => { if (opened.current) return; opened.current = true; turn('', true); }, []);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [turns, busy]);

  function markUsed(ids = []) { if (ids.length) setUsed(u => new Set([...u, ...ids])); }

  async function turn(text, opening = false, spoken = null) {
    if (busy) return;
    const history = turns.map(t => ({ role: t.role, content: t.role === 'user' ? t.hanzi : (t.hanzi + ' ' + (t.english || '')) }));
    let next = turns;
    if (!opening) {
      const mine = { role: 'user', hanzi: text };
      next = [...turns, mine];
      setTurns(next);
      setLearnerCount(c => c + 1);
      // client-side detection of learner usage for live chips
      markUsed(target.filter(v => normalizeHanzi(text).includes(normalizeHanzi(v.hanzi))).map(v => v.wordId));
      // Invisible pronunciation observation of the spoken reply (fire-and-forget).
      if (spoken) api.pronObserve({ spoken: { ...spoken, transcript: text }, targetVocab: target }).catch(() => {});
    }
    setInput(''); pendingSpoken.current = null; setBusy(true);
    try {
      const reply = await api.lessonTurn({ plan, history, userText: text });
      if (!reply.hanzi && reply.english?.includes('backend')) { onFallback?.(); return; }
      setTurns(t => [...t, { role: 'assistant', ...reply }]);
      markUsed(reply.used || []);
      if (reply.hanzi) speak(reply.hanzi);
    } catch { onFallback?.(); } finally { setBusy(false); }
  }

  // Speak-first: capture voice, drop the transcript into the box for a quick
  // confirm/edit (so STT slips are fixable), and keep the acoustic capture to
  // send alongside for hidden pronunciation analysis.
  async function mic() {
    if (!canSpeak || listening || busy) return;
    setListening(true); setLevel(0);
    try {
      const cap = await captureSpoken({ expectedSyllables: 2, timeoutMs: 6000, onLevel: setLevel });
      const spoken = { transcript: cap.transcript, alternatives: cap.alternatives, heardTones: null, timing: cap.timing };
      if (cap.transcript) { setInput(cap.transcript); pendingSpoken.current = spoken; }
    } catch {} finally { setListening(false); }
  }

  function submitTyped() {
    const text = input.trim();
    if (!text) return;
    const spoken = pendingSpoken.current && pendingSpoken.current.transcript === text ? pendingSpoken.current : null;
    turn(text, false, spoken);
  }

  const transcript = turns;
  window.__lessonTranscript = transcript;   // handed to Wrap via plan closure
  const micScale = 1 + Math.min(0.5, level * 5);

  return (
    <div className="flex flex-col h-[calc(100vh-11rem)] animate-fade">
      {/* target vocabulary — chips light up as they're used in the dialogue */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {target.map(v => (
          <span key={v.wordId} className={`px-2.5 py-1 rounded-full text-[13px] border transition ${
            used.has(v.wordId) ? 'bg-jade-500 text-white border-jade-500' : 'bg-white text-ink-soft border-line'}`}>
            <span className="hanzi">{v.hanzi}</span> {used.has(v.wordId) && '✓'}
          </span>
        ))}
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {turns.map((t, i) => t.role === 'user'
          ? <div key={i} className="flex justify-end"><div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-ink text-white"><span className="hanzi text-lg">{t.hanzi}</span></div></div>
          : <div key={i} className="flex justify-start"><div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-line">
              <div onClick={() => speak(t.hanzi)} className="cursor-pointer"><ScriptBubble hanzi={t.hanzi} pinyin={t.pinyin} english={t.english} mode={scriptMode} /></div>
              {t.note && <div className="text-[12px] text-jade-600 mt-2 border-t border-line pt-2">💡 {t.note}</div>}
            </div></div>
        )}
        {busy && <div className="text-ink-faint text-sm px-2">老师…</div>}
      </div>

      {/* Speak-first input: a prominent mic, with typing as an always-available
          fallback. Recognized speech lands in the box to confirm or fix. */}
      <div className="mt-3">
        {listening && <div className="text-center text-sm text-rose-500 mb-2 animate-pulse">Listening… speak now</div>}
        <div className="flex items-center gap-2">
          {canSpeak && (
            <button type="button" onClick={mic} disabled={busy}
              style={listening ? { transform: `scale(${micScale})` } : undefined}
              className={`w-14 h-14 shrink-0 rounded-full grid place-items-center text-2xl transition ${
                listening ? 'bg-rose-500 text-white shadow-lg shadow-rose-200' : 'bg-ink text-white hover:opacity-90'}`}
              title="Speak">🎤</button>
          )}
          <form onSubmit={(e) => { e.preventDefault(); submitTyped(); }} className="flex-1 flex items-center gap-2">
            <input value={input} onChange={(e) => { setInput(e.target.value); pendingSpoken.current = null; }}
              placeholder={canSpeak ? 'Tap 🎤 to speak, or type…' : 'Reply in Chinese or English…'}
              className="flex-1 px-4 py-3 rounded-full border border-line bg-white focus:outline-none focus:border-ink/40 hanzi" />
            <button type="submit" disabled={busy || !input.trim()} className="w-12 h-12 shrink-0 rounded-full bg-ink text-white grid place-items-center disabled:opacity-40">↑</button>
          </form>
        </div>
      </div>
      <button onClick={onFinish} disabled={learnerCount < 1}
        className="mt-2 text-sm text-ink-soft hover:text-ink disabled:opacity-40 self-center">
        {learnerCount < 1 ? 'Reply to Laoshi to continue' : 'Finish lesson →'}
      </button>
    </div>
  );
}

// ---- 4. Connections formed (never scores) --------------------------------
function Wrap({ plan, onDone }) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    const transcript = window.__lessonTranscript || [];
    api.lessonComplete({ plan, transcript }).then(setResult).catch(() => setResult({ outcomes: [], examples: 0 }));
  }, []);

  if (!result) return <div className="text-center py-16 text-ink-faint">Reflecting on the conversation…</div>;
  const used = result.outcomes.filter(o => o.produced);
  const met = result.outcomes.filter(o => !o.produced && o.exposed);
  const families = (plan.patterns || []).flatMap(p => [
    p.semantic && `${p.semantic.radical} (${p.semantic.meaning})`,
    p.phonetic && `${p.phonetic.component} sound-family`,
  ].filter(Boolean));

  return (
    <div className="text-center py-10 animate-fade max-w-lg mx-auto">
      <div className="hanzi text-6xl text-jade-500 mb-3">连</div>
      <h2 className="text-xl font-medium text-ink">Connections formed</h2>

      <div className="mt-6 space-y-3 text-left">
        {used.length > 0 && (
          <Row label="You used in conversation">
            {used.map(o => <Chip key={o.wordId} hanzi={o.hanzi} on />)}
          </Row>
        )}
        {met.length > 0 && (
          <Row label="You met">
            {met.map(o => <Chip key={o.wordId} hanzi={o.hanzi} />)}
          </Row>
        )}
        {families.length > 0 && (
          <Row label="Patterns reinforced">
            {families.map((f, i) => <span key={i} className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-sm">{f}</span>)}
          </Row>
        )}
        {result.examples > 0 && (
          <p className="text-sm text-ink-faint pt-1">{result.examples} example{result.examples > 1 ? 's' : ''} from your conversation saved for future review.</p>
        )}
      </div>

      <button onClick={onDone} className="mt-8 px-8 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">
        Next lesson →
      </button>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="p-4 rounded-2xl bg-white border border-line">
      <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
function Chip({ hanzi, on }) {
  return <span className={`px-2.5 py-1 rounded-full text-sm ${on ? 'bg-jade-500 text-white' : 'bg-ink/5 text-ink-soft'}`}><span className="hanzi">{hanzi}</span></span>;
}
