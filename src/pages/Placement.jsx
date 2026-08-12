import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { speak } from '../lib/speech.js';
import { TonedPinyin } from '../components/Toned.jsx';
import { Loading } from './Home.jsx';

// The entrance exam, dressed as a conversation rather than a test. Same teacher
// bubbles, same interlinear grounding, same tap-to-answer chips as a real session —
// it just escalates until you stop being able to follow, and stops there. Skippable
// at any point, and skipping is a normal outcome, not a failure.
export default function Placement() {
  const [state, setState] = useState(null);      // null = loading
  const [probe, setProbe] = useState(null);
  const [thread, setThread] = useState([]);      // rendered history of asked probes
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const started = useRef(false);
  const scroller = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (started.current) return; started.current = true;
    api.placement()
      .then(async (s) => {
        setState(s);
        if (s.taken) { setResult(s.result); return; }
        const r = await api.placementStart();
        setProbe(r.probe);
        setThread([{ probe: r.probe }]);
      })
      .catch(() => setState({ error: true }));
  }, []);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [thread, busy]);
  useEffect(() => { if (probe?.ask?.hanzi) speak(probe.ask.hanzi); }, [probe?.id]);

  async function answer(value) {
    if (busy || !probe) return;
    setBusy(true);
    setThread(t => t.map((x, i) => (i === t.length - 1 ? { ...x, answered: value } : x)));
    setTyped('');
    try {
      const r = await api.placementAnswer(value);
      if (r.done) { setResult(r.result); setProbe(null); }
      else { setProbe(r.probe); setThread(t => [...t, { probe: r.probe }]); }
    } catch { /* leave the probe in place; the learner can retry */ }
    finally { setBusy(false); }
  }

  async function skip() {
    if (busy) return;
    setBusy(true);
    try { const r = await api.placementSkip(); setResult(r.result); setProbe(null); }
    catch { setBusy(false); }
    finally { setBusy(false); }
  }

  if (state === null) return <Loading />;
  if (state?.error) return <div className="card-face p-6 text-ink-soft">Placement needs the local backend.</div>;

  if (result) return <Result result={result} onGo={() => navigate('/converse')} onHome={() => navigate('/')} />;

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)] animate-fade">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <span className="hanzi text-2xl text-ink">老师</span>
          <span className="text-sm text-ink-soft">a quick check — no score, no wrong answers</span>
        </div>
        <p className="text-[12.5px] text-ink-faint mt-1">
          Answer what you can. It stops as soon as it knows where to start you.
        </p>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto space-y-4 pr-1">
        {thread.map((item, i) => (
          <ProbeBubble key={item.probe?.id || i} probe={item.probe} answered={item.answered}
            isLast={i === thread.length - 1 && !busy}
            onAnswer={answer} />
        ))}
        {busy && <div className="text-ink-faint text-sm px-2">老师…</div>}
      </div>

      {/* Open production probes need a text box; multiple choice does not. */}
      {probe?.kind === 'produce' && !busy && (
        <form className="mt-3 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); answer(typed.trim()); }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
            placeholder="Say what you can in 汉字 or pinyin…"
            className="flex-1 px-4 py-3 rounded-full border border-line bg-white focus:outline-none focus:border-ink/40 hanzi" />
          <button type="submit" disabled={!typed.trim()}
            className="px-5 py-3 rounded-full bg-ink text-white text-sm disabled:opacity-40">Send</button>
          <button type="button" onClick={() => answer('')}
            className="px-4 py-3 rounded-full border border-line bg-white text-sm text-ink-soft hover:border-ink/30">
            I can't yet
          </button>
        </form>
      )}

      <div className="mt-3 pt-3 border-t border-line flex items-center justify-between">
        <button onClick={skip} disabled={busy}
          className="text-[13px] text-ink-faint hover:text-ink underline underline-offset-2 disabled:opacity-50">
          Skip this — start me from the beginning
        </button>
        <span className="text-[12px] text-ink-faint">{thread.length} of ~8</span>
      </div>
    </div>
  );
}

function ProbeBubble({ probe, answered, isLast, onAnswer }) {
  if (!probe) return null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-line space-y-2.5">
        <button onClick={() => speak(probe.ask.hanzi)} className="block text-left">
          <div className="flex items-center gap-3">
            {probe.image?.kind === 'emoji' && <span className="text-3xl">{probe.image.value}</span>}
            <div>
              {probe.ask.pinyin && (
                <div className="text-[12px] text-jade-700 mb-0.5"><TonedPinyin pinyin={probe.ask.pinyin} /></div>
              )}
              <div className="hanzi text-2xl text-ink leading-snug">{probe.ask.hanzi}</div>
            </div>
            <span className="text-ink-faint text-sm ml-1">🔊</span>
          </div>
        </button>

        {/* Word-by-word grounding — the same interlinear the guided rung uses, so
            even a probe you can't answer teaches you something. */}
        {probe.tokens?.length > 1 && (
          <div className="flex flex-wrap items-end gap-x-1 gap-y-1 pt-1 border-t border-line/70">
            {probe.tokens.map((t, i) => (
              <span key={i} className="flex flex-col items-center px-1">
                {t.pinyin && <span className="text-[10px] text-ink-faint leading-tight"><TonedPinyin pinyin={t.pinyin} /></span>}
                <span className="hanzi text-[15px] text-ink leading-tight">{t.hanzi}</span>
              </span>
            ))}
          </div>
        )}

        <div className="text-[12.5px] text-ink-soft">{probe.prompt}</div>

        {probe.options && (
          <div className="flex flex-wrap gap-1.5">
            {probe.options.map((o, i) => {
              const picked = answered === o;
              return (
                <button key={i} onClick={() => isLast && onAnswer(o)} disabled={!isLast || answered != null}
                  className={`px-3 py-1.5 rounded-full text-[13px] border text-left transition ${
                    picked ? 'bg-ink text-white border-ink'
                      : answered != null ? 'bg-white text-ink-faint border-line opacity-50'
                      : 'bg-white text-ink-soft border-line hover:border-jade-300 hover:bg-jade-50/50'}`}>
                  <span className={probe.chinese ? 'hanzi text-[15px]' : ''}>{o}</span>
                </button>
              );
            })}
            {isLast && answered == null && (
              <button onClick={() => onAnswer('')}
                className="px-3 py-1.5 rounded-full text-[13px] border border-dashed border-line text-ink-faint hover:text-ink">
                I don't know
              </button>
            )}
          </div>
        )}
        {answered != null && probe.kind === 'produce' && (
          <div className="text-[13px] text-ink-soft">
            {answered ? <span className="hanzi">{answered}</span> : <span className="text-ink-faint italic">skipped</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// The outcome is stated as a starting point, never as a level or a score — the
// whole point of the redesign is that you are somewhere on a road, not on a rung.
function Result({ result, onGo, onHome }) {
  return (
    <div className="animate-rise max-w-lg">
      <div className="hanzi text-4xl text-ink mb-3">好</div>
      <h1 className="text-2xl font-semibold tracking-tightish mb-2">
        {result?.source === 'skipped' ? "We'll start at the beginning" : result?.label || "Here's where we'll start"}
      </h1>
      <p className="text-ink-soft text-[14px] mb-6">
        {result?.source === 'skipped'
          ? 'Laoshi will start from the very first words and speed up as soon as you show you can go faster.'
          : 'Laoshi will start you here and keep adjusting — if it feels too easy or too hard, it moves on its own.'}
        {result?.wordsMarked > 0 && ` ${result.wordsMarked} words are already counted as yours.`}
      </p>
      <div className="flex gap-2">
        <button onClick={onGo}
          className="px-5 py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">
          <span className="hanzi">跟老师聊聊</span> →
        </button>
        <button onClick={onHome}
          className="px-5 py-3 rounded-full border border-line bg-white text-ink-soft hover:border-ink/30 transition">
          Home
        </button>
      </div>
    </div>
  );
}
