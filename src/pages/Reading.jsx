import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Loading, ErrorNote } from './Home.jsx';
import { playAudio } from '../lib/speech.js';

export default function Reading() {
  const [data, setData] = useState(null);
  const [pop, setPop] = useState(null);

  useEffect(() => { api.reading().then(setData).catch(e => setData({ error: e.message })); }, []);
  if (!data) return <Loading />;
  if (data.error) return <ErrorNote msg={data.error} />;

  async function tapChar(e, context) {
    const rect = e.currentTarget.getBoundingClientRect();
    try {
      const { results } = await api.lookup(context);
      setPop({ term: context, results, x: rect.left, y: rect.bottom + window.scrollY });
    } catch { setPop(null); }
  }

  return (
    <div className="animate-rise" onClick={(e) => { if (!e.target.closest('.lookup-pop')) setPop(null); }}>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tightish">Reading</h1>
        <p className="text-ink-soft mt-1.5">Passages from your completed units. Tap a word to look it up, tap the speaker to hear a line.</p>
      </header>

      {data.passages.length === 0 && (
        <div className="card-face p-8 text-center text-ink-soft">
          No passages yet — complete more units so their sentences unlock.
        </div>
      )}

      <div className="space-y-4">
        {data.passages.map(p => (
          <article key={p.index} className="card-face p-7">
            <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-5">Passage {p.index}</div>
            <div className="space-y-5">
              {p.sentences.map(s => (
                <div key={s.id} className="group">
                  <p className="hanzi text-[26px] leading-[1.7] text-ink">
                    {[...s.hanzi].map((ch, i) => (
                      /[一-鿿]/.test(ch)
                        ? <span key={i} className="rounded px-[1px] cursor-pointer hover:bg-jade-100 transition-colors"
                            onClick={(e) => { e.stopPropagation(); tapChar(e, s.hanzi.slice(i, i + 4)); }}>{ch}</span>
                        : <span key={i}>{ch}</span>
                    ))}
                    <button onClick={() => playAudio(s)}
                      className="ml-2 align-middle text-jade-500 opacity-40 group-hover:opacity-100 transition text-lg">◍</button>
                  </p>
                  {s.pinyin && <p className="text-[13px] text-jade-600/80 mt-1">{s.pinyin}</p>}
                  <p className="text-sm text-ink-faint mt-0.5">{s.english}</p>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

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
