import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { playAudio, speak, normalizeHanzi, captureSpoken, spokenCaptureSupported } from '../lib/speech.js';
import { TonedPinyin, ScriptBubble, scriptModeFromLevel } from '../components/Toned.jsx';

// One continuous conversation with Laoshi. The guided lesson and free chat are the
// same surface: a single thread where light reps appear inline as chat bubbles and
// heavier activities open as gently-framed excursions. No lesson announcements, no
// target-word chips, no scores — the educational plan stays entirely hidden.
export default function Converse({ onFallback }) {
  const [session, setSession] = useState(null);      // {sessionId, scriptLevel, hasThread}
  const [items, setItems] = useState([]);            // thread: {role|type, ...}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [done, setDone] = useState(false);
  const [excursion, setExcursion] = useState(null);  // active framed excursion
  const [popover, setPopover] = useState(null);      // {term, results, x, y}
  const scroller = useRef(null);
  const opened = useRef(false);
  const pendingSpoken = useRef(null);
  const sessionId = session?.sessionId;
  const scriptMode = scriptModeFromLevel(session?.scriptLevel);
  const canSpeak = spokenCaptureSupported();

  // Start the conversation: build plan + blueprint server-side, then fetch the
  // personal opening turn. Feels like resuming, not launching.
  useEffect(() => {
    if (opened.current) return; opened.current = true;
    api.conversationPlan()
      .then(s => { setSession(s); return s; })
      .then(s => turn('', true, null, s.sessionId))
      .catch(() => onFallback?.());
  }, []);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [items, busy]);

  // Dialogue history for the model = only real conversational turns (not reps).
  function historyFor() {
    return items.filter(i => i.role === 'user' || i.role === 'assistant')
      .map(i => ({ role: i.role, content: i.role === 'user' ? i.hanzi : (i.hanzi + ' ' + (i.english || '')) }));
  }

  async function turn(text, opening = false, spoken = null, sid = sessionId) {
    if (busy || !sid) return;
    const history = historyFor();
    if (!opening) {
      setItems(prev => [...prev, { role: 'user', hanzi: text }]);
      if (spoken) api.pronObserve({ spoken: { ...spoken, transcript: text }, targetVocab: [] }).catch(() => {});
    }
    setInput(''); pendingSpoken.current = null; setBusy(true);
    try {
      const reply = await api.conversationTurn({ sessionId: sid, history, userText: opening ? '' : text });
      if (!reply.hanzi && reply.english?.includes('backend')) { onFallback?.(); return; }
      setItems(prev => {
        const next = [...prev, { role: 'assistant', hanzi: reply.hanzi, pinyin: reply.pinyin, english: reply.english, note: reply.note }];
        if (reply.inlineRep) next.push({ type: 'rep', rep: reply.inlineRep });
        return next;
      });
      if (reply.hanzi) speak(reply.hanzi);
      if (reply.excursion) setExcursion(reply.excursion);
      if (reply.shouldWrap) finish(sid);
    } catch { onFallback?.(); } finally { setBusy(false); }
  }

  // A framed excursion just closed → auto-post its in-character bridge back into
  // the thread and continue, so it feels like the teacher handed you something.
  function returnFromExcursion(ex) {
    setExcursion(null);
    const b = ex.exitBridge;
    if (b?.hanzi) { setItems(prev => [...prev, { role: 'assistant', hanzi: b.hanzi, pinyin: b.pinyin, english: b.english }]); speak(b.hanzi); }
  }

  // Natural close: no score screen. Run the invisible post-hoc inference.
  function finish(sid = sessionId) {
    setDone(true);
    const transcript = items.filter(i => i.role === 'user' || i.role === 'assistant');
    api.conversationComplete({ sessionId: sid, transcript }).catch(() => {});
  }

  async function mic() {
    if (!canSpeak || listening || busy) return;
    setListening(true); setLevel(0);
    try {
      const cap = await captureSpoken({ expectedSyllables: 3, timeoutMs: 6000, onLevel: setLevel });
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

  async function lookupChar(term, e) {
    try {
      const { results } = await api.lookup(term);
      const r = e.currentTarget.getBoundingClientRect();
      setPopover({ term, results: results?.slice(0, 3) || [], x: r.left, y: r.bottom });
    } catch {}
  }

  const micScale = 1 + Math.min(0.5, level * 5);

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)] animate-fade" onClick={() => popover && setPopover(null)}>
      <div className="flex items-center gap-2 mb-3">
        <span className="hanzi text-2xl text-ink">老师</span>
        <span className="text-sm text-ink-soft">{session?.hasThread ? 'picking up where you left off' : 'Laoshi'}</span>
      </div>

      <div ref={scroller} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {items.map((it, i) => {
          if (it.type === 'rep') return <InlineRep key={i} rep={it.rep} />;
          if (it.role === 'user') return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-ink text-white"><span className="hanzi text-lg">{it.hanzi}</span></div>
            </div>
          );
          return (
            <div key={i} className="flex justify-start">
              <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-line">
                <TeacherText hanzi={it.hanzi} pinyin={it.pinyin} english={it.english} mode={scriptMode} onChar={lookupChar} onSpeak={() => speak(it.hanzi)} />
                {it.note && <div className="text-[12px] text-jade-600 mt-2 border-t border-line pt-2">💡 {it.note}</div>}
              </div>
            </div>
          );
        })}
        {busy && <div className="text-ink-faint text-sm px-2">老师…</div>}
      </div>

      {popover && <WordPopover popover={popover} />}
      {excursion && <Excursion excursion={excursion} onDone={() => returnFromExcursion(excursion)} scriptMode={scriptMode} />}

      {/* Composer — collapses into a soft close affordance when the talk winds down. */}
      {done ? (
        <div className="mt-4 text-center text-ink-soft text-sm py-4 border-t border-line">聊到这儿 · 明天见</div>
      ) : (
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
      )}
    </div>
  );
}

// Teacher text: the reading experience (ScriptBubble) plus per-character tap-to-look-up
// so beginners cope without the UI ever announcing vocabulary.
function TeacherText({ hanzi, pinyin, english, mode, onChar, onSpeak }) {
  const cjk = [...(hanzi || '')];
  return (
    <div>
      <div onClick={onSpeak} className="cursor-pointer"><ScriptBubble hanzi={hanzi} pinyin={pinyin} english={english} mode={mode} /></div>
      {hanzi && (
        <div className="hanzi text-[15px] text-ink-faint/80 mt-2 flex flex-wrap">
          {cjk.map((c, i) => /[一-鿿]/.test(c)
            ? <button key={i} onClick={(e) => { e.stopPropagation(); onChar(c, e); }} className="hover:text-jade-600 px-[1px]">{c}</button>
            : <span key={i}>{c}</span>)}
        </div>
      )}
    </div>
  );
}

function WordPopover({ popover }) {
  const { results, x, y, term } = popover;
  const top = Math.min(y + 6, (typeof window !== 'undefined' ? window.innerHeight : 800) - 160);
  return (
    <div className="fixed z-40 w-64 p-3 rounded-2xl bg-white border border-line shadow-lift text-sm" style={{ left: Math.max(8, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 400) - 264)), top }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-1">
        <span className="hanzi text-xl text-ink">{term}</span>
        <button onClick={() => speak(term)} className="text-xs text-ink-faint hover:text-ink">🔊</button>
      </div>
      {results.length ? results.map((r, i) => (
        <div key={i} className="border-t border-line pt-1.5 mt-1.5 first:border-0 first:pt-0 first:mt-0">
          <span className="text-ink-soft">{r.pinyin}</span>
          <div className="text-ink-faint text-[13px]">{(r.definitions || []).slice(0, 2).join('; ')}</div>
        </div>
      )) : <div className="text-ink-faint">No entry.</div>}
    </div>
  );
}

// Inline light rep: a recognition check rendered as a chat bubble. Answering flows
// straight back into the conversation and updates real scheduling.
function InlineRep({ rep }) {
  const [answered, setAnswered] = useState(null);
  async function answer(opt) {
    if (answered) return;
    const correct = opt === rep.gloss;
    setAnswered({ opt, correct });
    api.review({ cardId: rep.cardId, rating: correct ? 3 : 2, dimension: 'meaning', exercise: 'recognition', durationMs: 0 }).catch(() => {});
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-jade-50/60 border border-jade-100">
        <div className="flex items-center gap-2 mb-2">
          <button onClick={() => (rep.audio ? playAudio({ audio_path: rep.audio, hanzi: rep.hanzi }) : speak(rep.hanzi))} className="w-8 h-8 rounded-full bg-white border border-line grid place-items-center text-sm">🔊</button>
          <span className="hanzi text-2xl text-ink">{rep.hanzi}</span>
          <span className="text-sm text-ink-soft"><TonedPinyin pinyin={rep.pinyin} /></span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {rep.options.map((o, i) => {
            const state = answered && (o === rep.gloss ? 'right' : o === answered.opt ? 'wrong' : 'dim');
            return (
              <button key={i} onClick={() => answer(o)} disabled={!!answered}
                className={`px-3 py-1.5 rounded-full text-[13px] border transition ${
                  state === 'right' ? 'bg-jade-500 text-white border-jade-500'
                    : state === 'wrong' ? 'bg-rose-50 text-rose-600 border-rose-200'
                    : state === 'dim' ? 'bg-white text-ink-faint border-line opacity-50'
                    : 'bg-white text-ink-soft border-line hover:border-ink/30'}`}>
                {o}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Framed heavy excursion: a gently-framed sheet over the conversation. Feels like
// the teacher handed you something, not like you navigated to a tab.
function Excursion({ excursion, onDone, scriptMode }) {
  if (excursion.kind !== 'tone_drill') { onDone(); return null; }
  const enter = excursion.enterLine;
  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-ink/20 backdrop-blur-sm p-4" onClick={onDone}>
      <div className="w-full max-w-md rounded-3xl bg-white border border-line shadow-lift p-6 animate-rise" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4"><ScriptBubble hanzi={enter.hanzi} pinyin={enter.pinyin} english={enter.english} mode={scriptMode} /></div>
        <div className="space-y-2">
          {excursion.drill.items.flatMap(g => g.pair).slice(0, 6).map((w, i) => (
            <button key={i} onClick={() => playAudio({ audio_path: w.audio_path, hanzi: w.hanzi })}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-white border border-line hover:border-ink/30 text-left">
              <span className="w-7 h-7 rounded-full bg-ink/5 grid place-items-center text-xs">🔊</span>
              <span className="hanzi text-xl text-ink">{w.hanzi}</span>
              <span className="text-sm text-ink-soft">{w.pinyin}</span>
              <span className="text-[13px] text-ink-faint ml-auto">{(w.english || '').slice(0, 18)}</span>
            </button>
          ))}
        </div>
        <button onClick={onDone} className="mt-5 w-full py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">回到聊天 →</button>
      </div>
    </div>
  );
}
