import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Loading, ErrorNote } from './Home.jsx';

const pct = (v) => v == null ? '—' : Math.round(v * 100) + '%';

export default function Stats() {
  const [data, setData] = useState(null);
  useEffect(() => { api.stats().then(setData).catch(e => setData({ error: e.message })); }, []);
  if (!data) return <Loading />;
  if (data.error) return <ErrorNote msg={data.error} />;

  const { wordsByState, retentionCurve, weakestWords, tones, throttle: t, today, retention14d } = data;

  return (
    <div className="space-y-6 animate-rise">
      <header>
        <h1 className="text-3xl font-semibold tracking-tightish">Progress</h1>
        <p className="text-ink-soft mt-1.5">Your retention, pace, and where to focus.</p>
      </header>

      {/* Adaptive rate */}
      <section className="card-face p-6">
        <div className="flex items-start gap-6">
          <div className="shrink-0">
            <div className="text-5xl font-semibold text-ink leading-none">{t.current}</div>
            <div className="text-[11px] text-ink-faint mt-1.5">new words / day</div>
          </div>
          <div className="flex-1 pt-1">
            <div className="flex items-center gap-2 mb-1.5"><Badge decision={t.decision} />
              {t.previous !== t.current && <span className="text-[12px] text-ink-faint">from {t.previous}</span>}
            </div>
            <p className="text-sm text-ink-soft">{t.reason}</p>
            <div className="text-[12px] text-ink-faint mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <span>14-day retention {pct(t.metrics.retention)}</span>
              <span>{t.metrics.avgDailyMinutes.toFixed(0)} min/day</span>
              <span>backlog {t.metrics.backlogRatio.toFixed(1)}×</span>
              <span>today {today.count} reviews · {today.minutes.toFixed(1)} min</span>
            </div>
          </div>
        </div>
      </section>

      {/* Retention curve */}
      <section className="card-face p-6">
        <SectionTitle>Retention by week <span className="text-ink-faint font-normal">· target 88%</span></SectionTitle>
        <Bars data={retentionCurve.map(r => ({ label: r.week.slice(-2), value: r.retention }))} />
        {retention14d != null && <p className="text-[12px] text-ink-faint mt-3">Rolling 14-day retention: {pct(retention14d)}.</p>}
      </section>

      <div className="grid sm:grid-cols-2 gap-6">
        {/* Words by state */}
        <section className="card-face p-6">
          <SectionTitle>Words by state</SectionTitle>
          <div className="space-y-2 mt-1">
            {['review', 'learning', 'relearning', 'new', 'unseen'].map(k => {
              const total = Object.values(wordsByState).reduce((a, b) => a + b, 0) || 1;
              const v = wordsByState[k] || 0;
              return (
                <div key={k} className="flex items-center gap-3">
                  <span className="w-20 text-[12px] text-ink-faint capitalize">{k}</span>
                  <div className="flex-1 h-2 rounded-full bg-[#f0ede8] overflow-hidden">
                    <div className={`h-full ${k === 'review' ? 'bg-jade-500' : k === 'unseen' ? 'bg-stone-300' : 'bg-jade-300'}`}
                      style={{ width: (v / total * 100) + '%' }} />
                  </div>
                  <span className="w-12 text-right text-[13px] font-medium">{v}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Per-tone */}
        <section className="card-face p-6">
          <SectionTitle>Per-tone accuracy</SectionTitle>
          <div className="grid grid-cols-5 gap-2 mt-1">
            {[1, 2, 3, 4, 5].map(tone => {
              const s = tones.perTone[tone];
              return (
                <div key={tone} className="rounded-xl bg-stone-50 p-2.5 text-center">
                  <div className="text-lg font-semibold">{s?.acc == null ? '—' : Math.round(s.acc * 100) + '%'}</div>
                  <div className="text-[10px] text-ink-faint mt-0.5">t{tone} · {s?.total || 0}</div>
                </div>
              );
            })}
          </div>
          {tones.weakest && <p className="text-[12px] text-rose-600 mt-3">Focus: tone {tones.weakest.tone}.</p>}
        </section>
      </div>

      {/* Weakest words */}
      <section className="card-face p-6">
        <SectionTitle>Weakest words</SectionTitle>
        {weakestWords.length === 0 && <p className="text-sm text-ink-faint mt-1">No lapses yet — nice.</p>}
        <ul className="divide-y divide-line mt-1">
          {weakestWords.map((w, i) => (
            <li key={i} className="py-2.5 flex items-center gap-4 text-sm">
              <span className="hanzi text-xl text-ink w-10">{w.hanzi}</span>
              <span className="text-jade-600 w-24">{w.pinyin}</span>
              <span className="text-ink-soft flex-1 truncate">{w.english}</span>
              <span className="text-[12px] text-rose-500 shrink-0">{w.lapses} lapse{w.lapses === 1 ? '' : 's'} · {w.card_type}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="text-sm font-medium text-ink-soft mb-4">{children}</h2>;
}

function Badge({ decision }) {
  const m = {
    increase: 'bg-jade-100 text-jade-700', hold: 'bg-stone-100 text-ink-soft',
    decrease: 'bg-rose-100 text-rose-700',
  };
  const label = { increase: '↑ increasing', hold: '→ holding', decrease: '↓ easing off' };
  return <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${m[decision] || m.hold}`}>{label[decision] || decision}</span>;
}

function Bars({ data }) {
  if (!data.length) return <p className="text-sm text-ink-faint">No review history yet.</p>;
  return (
    <div className="flex items-end gap-1.5 h-32 mt-2">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5">
          <div className="w-full rounded-t-md bg-jade-400/80 hover:bg-jade-500 transition-colors"
            style={{ height: `${Math.max(2, (d.value || 0) * 100)}%` }} title={pct(d.value)} />
          <div className="text-[9px] text-ink-faint">{d.label}</div>
        </div>
      ))}
    </div>
  );
}
