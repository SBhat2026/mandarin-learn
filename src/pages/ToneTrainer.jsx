import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Loading, ErrorNote } from './Home.jsx';
import { playAudio } from '../lib/speech.js';

const TONE = {
  1: { mark: 'ā', name: 'high' }, 2: { mark: 'á', name: 'rising' },
  3: { mark: 'ǎ', name: 'dip' }, 4: { mark: 'à', name: 'falling' }, 5: { mark: 'a', name: 'neutral' },
};

export default function ToneTrainer() {
  const [data, setData] = useState(null);
  useEffect(() => { api.tone(12).then(setData).catch(e => setData({ error: e.message })); }, []);
  if (!data) return <Loading />;
  if (data.error) return <ErrorNote msg={data.error} />;

  const { stats, weak, drill } = data;
  const hasStats = Object.keys(stats.perTone).length > 0;

  return (
    <div className="animate-rise">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tightish">Tones</h1>
        <p className="text-ink-soft mt-1.5">Minimal-pair drills from native audio. Accuracy comes from your speaking cards.</p>
      </header>

      <section className="mb-10">
        <div className="grid grid-cols-5 gap-2.5">
          {[1, 2, 3, 4, 5].map(t => {
            const s = stats.perTone[t]; const acc = s?.acc;
            const weakHere = weak?.tone === t;
            return (
              <div key={t} className={`rounded-2xl p-4 text-center border ${weakHere ? 'bg-rose-50 border-rose-200' : 'bg-white border-line'}`}>
                <div className="hanzi text-2xl text-ink-soft leading-none">{TONE[t].mark}</div>
                <div className="text-[11px] text-ink-faint mt-1">tone {t} · {TONE[t].name}</div>
                <div className="text-2xl font-semibold mt-2">{acc == null ? '—' : Math.round(acc * 100) + '%'}</div>
                <div className="text-[10px] text-ink-faint">{s?.total || 0} reps</div>
              </div>
            );
          })}
        </div>
        {weak && <p className="text-sm text-rose-600 mt-3">Weakest: tone {weak.tone}{weak.pair ? ` — often heard as tone ${weak.pair.b}` : ''}.</p>}
        {!hasStats && <p className="text-sm text-ink-faint mt-3">Do some speaking cards to build per-tone stats.</p>}
      </section>

      <section>
        <h2 className="text-sm font-medium text-ink-soft mb-3">
          Minimal pairs {drill.length ? '' : '— need more single-syllable words with audio'}
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {drill.map((d, i) => (
            <div key={i} className="card-face p-5">
              <div className="text-[11px] text-ink-faint mb-3 font-mono">base “{d.base}”</div>
              <div className="flex items-center justify-around">
                {d.pair.map((w, j) => (
                  <button key={j} onClick={() => playAudio(w)}
                    className="text-center px-3 py-1 rounded-xl hover:bg-stone-50 transition group">
                    <div className="hanzi text-4xl text-ink">{w.hanzi}</div>
                    <div className="text-jade-600 text-sm mt-1">{w.pinyin}</div>
                    <div className="text-[11px] text-ink-faint truncate max-w-[9rem]">{w.english}</div>
                    <div className="text-[10px] text-ink-faint mt-1.5 group-hover:text-jade-500">◍ tap</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
