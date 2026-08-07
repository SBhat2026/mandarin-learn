import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Loading, ErrorNote } from './Home.jsx';
import { playAudio, speak } from '../lib/speech.js';
import { TonedPinyin } from '../components/Toned.jsx';

// Reading is now a graded-reader loop, not a re-read of old sentences: a story
// written at your level from words you know (+ a few glossed stretch words),
// finished with a light comprehension check that quietly feeds reading mastery.
export default function Reading() {
  const [story, setStory] = useState(undefined);      // undefined = loading
  const [passages, setPassages] = useState([]);
  const [pop, setPop] = useState(null);
  const [answers, setAnswers] = useState({});
  const [finished, setFinished] = useState(false);
  const [loadingFresh, setLoadingFresh] = useState(false);

  useEffect(() => {
    api.story().then(r => setStory(r.story ?? null)).catch(() => setStory(null));
    api.reading().then(d => setPassages(d.passages || [])).catch(() => {});
  }, []);

  async function newStory() {
    setLoadingFresh(true); setAnswers({}); setFinished(false);
    try { const r = await api.story(true); setStory(r.story ?? null); }
    catch { /* keep old */ } finally { setLoadingFresh(false); }
  }

  function answer(qi, oi) {
    if (finished || answers[qi] != null) return;
    setAnswers(a => ({ ...a, [qi]: oi }));
  }

  function finishStory() {
    if (finished || !story) return;
    const qs = story.questions || [];
    const correct = qs.filter((q, i) => answers[i] === q.answer).length;
    setFinished(true);
    api.storyOutcome({ correct, total: qs.length }).catch(() => {});
  }

  async function tapChar(e, context) {
    const rect = e.currentTarget.getBoundingClientRect();
    try {
      const { results } = await api.lookup(context);
      setPop({ term: context, results, x: rect.left, y: rect.bottom + window.scrollY });
    } catch { setPop(null); }
  }

  if (story === undefined) return <Loading />;

  const allAnswered = story?.questions?.length ? story.questions.every((q, i) => answers[i] != null) : true;

  return (
    <div className="animate-rise" onClick={(e) => { if (!e.target.closest('.lookup-pop')) setPop(null); }}>
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tightish">Reading</h1>
          <p className="text-ink-soft mt-1.5">A little story at your level. Tap a word to look it up; tap ◍ to hear a line.</p>
        </div>
        {story && (
          <button onClick={newStory} disabled={loadingFresh}
            className="px-4 py-2 rounded-full border border-line bg-white text-sm text-ink-soft hover:border-ink/30 disabled:opacity-50">
            {loadingFresh ? 'Writing…' : 'New story'}
          </button>
        )}
      </header>

      {!story && (
        <div className="card-face p-8 text-center text-ink-soft">
          Not enough words yet for a story — learn a few more in Practice first.
        </div>
      )}

      {story && (
        <article className="card-face p-7 mb-6">
          <div className="mb-5">
            <span className="hanzi text-2xl text-ink">{story.title.hanzi}</span>
            <span className="text-sm text-ink-faint ml-3">{story.title.english}</span>
          </div>

          {story.newWords?.length > 0 && (
            <div className="mb-6">
              <div className="text-[11px] uppercase tracking-[0.12em] text-jade-700 mb-2">New in this story</div>
              <div className="flex gap-2 flex-wrap">
                {story.newWords.map((w, i) => (
                  <button key={i} onClick={() => speak(w.hanzi)}
                    className="flex flex-col items-center px-3 py-2 rounded-2xl bg-jade-50/70 border border-jade-200">
                    <span className="hanzi text-xl text-ink">{w.hanzi}</span>
                    <span className="text-[11px] text-jade-700"><TonedPinyin pinyin={w.pinyin} /></span>
                    <span className="text-[11px] text-ink-faint">{w.gloss}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-5">
            {story.sentences.map((s, si) => (
              <Sentence key={si} s={s} onChar={tapChar} />
            ))}
          </div>

          {story.questions?.length > 0 && (
            <div className="mt-8 pt-5 border-t border-line">
              <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-3">Did you follow?</div>
              {story.questions.map((q, qi) => (
                <div key={qi} className="mb-4">
                  <div className="text-sm text-ink mb-2">{q.q}</div>
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((o, oi) => {
                      const picked = answers[qi];
                      const state = picked == null ? '' : oi === q.answer ? 'right' : oi === picked ? 'wrong' : 'dim';
                      return (
                        <button key={oi} onClick={() => answer(qi, oi)} disabled={picked != null}
                          className={`px-3 py-1.5 rounded-full text-[13px] border transition ${
                            state === 'right' ? 'bg-jade-500 text-white border-jade-500'
                              : state === 'wrong' ? 'bg-rose-50 text-rose-600 border-rose-200'
                              : state === 'dim' ? 'bg-white text-ink-faint border-line opacity-50'
                              : 'bg-white text-ink-soft border-line hover:border-ink/30'}`}>{o}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!finished ? (
            <button onClick={finishStory} disabled={!allAnswered}
              className="mt-4 w-full py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition disabled:opacity-40">
              Finished reading ✓
            </button>
          ) : (
            <div className="mt-4 text-center text-jade-700 text-sm py-3">读完了 · nicely read — this counts.</div>
          )}
        </article>
      )}

      {passages.length > 0 && (
        <>
          <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-3">More practice — sentences you've unlocked</div>
          <div className="space-y-4">
            {passages.map(p => (
              <article key={p.index} className="card-face p-7">
                <div className="space-y-5">
                  {p.sentences.map(s => <Sentence key={s.id} s={s} onChar={tapChar} />)}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {pop && (
        <div className="lookup-pop absolute z-30 w-72 card-face p-4 shadow-lift"
          style={{ left: Math.min(pop.x, window.innerWidth - 300), top: pop.y + 6 }}>
          <div className="flex justify-between items-start mb-2">
            <span className="hanzi text-2xl text-ink">{pop.results[0]?.simplified || pop.term}</span>
            <button onClick={() => setPop(null)} className="text-ink-faint hover:text-ink text-sm">✕</button>
          </div>
          {pop.results.length === 0 && <p className="text-sm text-ink-faint">No dictionary entry.</p>}
          {pop.results.slice(0, 3).map((r, i) => (
            <div key={i} className="mb-2 last:mb-0">
              <div className="text-jade-600 text-sm">{r.pinyin}</div>
              <div className="text-sm text-ink-soft">{r.definitions.slice(0, 3).join('; ')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Sentence({ s, onChar }) {
  return (
    <div className="group">
      <p className="hanzi text-[26px] leading-[1.7] text-ink">
        {[...s.hanzi].map((ch, i) => (
          /[一-鿿]/.test(ch)
            ? <span key={i} className="rounded px-[1px] cursor-pointer hover:bg-jade-100 transition-colors"
                onClick={(e) => { e.stopPropagation(); onChar(e, s.hanzi.slice(i, i + 4)); }}>{ch}</span>
            : <span key={i}>{ch}</span>
        ))}
        <button onClick={() => playAudio(s)}
          className="ml-2 align-middle text-jade-500 opacity-40 group-hover:opacity-100 transition text-lg">◍</button>
      </p>
      {s.pinyin && <p className="text-[13px] text-jade-600/80 mt-1">{s.pinyin}</p>}
      <p className="text-sm text-ink-faint mt-0.5">{s.english}</p>
    </div>
  );
}
