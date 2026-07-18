import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

export default function Home() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();
  const currentRef = useRef(null);

  useEffect(() => { api.home().then(setData).catch(e => setData({ error: e.message })); }, []);
  useEffect(() => {
    if (data && currentRef.current) currentRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [data]);

  if (!data) return <Loading />;
  if (data.error) return <ErrorNote msg={data.error} />;

  const { units, currentUnitId, dueNow, streak } = data;
  const current = units.find(u => u.id === currentUnitId);
  const learned = units.reduce((n, u) => n + (u.progress?.review || 0), 0);

  return (
    <div className="animate-rise">
      {/* Hero */}
      <section className="mb-10">
        <div className="text-[13px] font-medium text-ink-faint mb-1">Welcome back</div>
        <h1 className="text-3xl font-semibold tracking-tightish mb-6">
          {current ? current.name : 'Your path'}
        </h1>
        <div className="flex items-stretch gap-3">
          <Metric value={dueNow} label="Due today" primary />
          <Metric value={learned} label="Words learned" />
          <Metric value={`${streak}`} label="Day streak" suffix={streak > 0 ? '🔥' : ''} />
          <button onClick={() => navigate('/session')}
            className="ml-auto self-stretch px-6 rounded-2xl bg-ink text-white font-medium shadow-soft
                       hover:shadow-lift transition-shadow flex items-center gap-2">
            {dueNow > 0 ? 'Review' : 'Practice'} <span aria-hidden>→</span>
          </button>
        </div>
      </section>

      {/* Path */}
      {units.length === 0 && <p className="text-ink-soft">No units yet — run the ingest pipeline.</p>}
      <div className="relative pl-1">
        <div className="absolute left-[27px] top-4 bottom-4 w-px bg-line" aria-hidden />
        <ol className="space-y-2.5">
          {units.map(u => (
            <PathNode key={u.id} unit={u} current={u.id === currentUnitId}
              refEl={u.id === currentUnitId ? currentRef : null}
              onClick={() => u.id === currentUnitId && navigate('/session')} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function PathNode({ unit, current, onClick, refEl }) {
  const pct = Math.round((unit.progress?.ratio || 0) * 100);
  const started = pct > 0 || current;
  return (
    <li ref={refEl} className="relative flex items-center gap-4">
      {/* node dot */}
      <div className={`relative z-10 shrink-0 w-[54px] flex justify-center`}>
        <span className={`grid place-items-center w-9 h-9 rounded-full text-[13px] font-semibold border
          ${unit.completed ? 'bg-jade-500 border-jade-500 text-white'
            : current ? 'bg-white border-ink text-ink ring-4 ring-jade-100'
            : started ? 'bg-white border-line text-ink-soft'
            : 'bg-[#f4f2ee] border-line text-ink-faint'}`}>
          {unit.completed ? '✓' : unit.position}
        </span>
      </div>
      <button onClick={onClick} disabled={!current}
        className={`flex-1 text-left px-4 py-3 rounded-2xl border transition
          ${current ? 'bg-white border-ink/15 shadow-soft hover:shadow-lift cursor-pointer'
            : unit.completed ? 'bg-white/70 border-line'
            : 'bg-white/40 border-line/70'}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`font-medium ${started ? 'text-ink' : 'text-ink-soft'}`}>{unit.name}</div>
            <div className="text-[12px] text-ink-faint capitalize">{unit.topic} · {unit.wordCount} words</div>
          </div>
          <div className="text-right">
            {current && <span className="text-[11px] font-medium text-jade-600">Continue</span>}
            {unit.completed && <span className="text-[11px] text-jade-600">Complete</span>}
            <div className="text-[12px] text-ink-faint mt-0.5">{unit.progress?.review || 0}/{unit.progress?.total || 0}</div>
          </div>
        </div>
        {started && (
          <div className="mt-2.5 h-1 rounded-full bg-[#f0ede8] overflow-hidden">
            <div className="h-full bg-jade-400 transition-all" style={{ width: pct + '%' }} />
          </div>
        )}
      </button>
    </li>
  );
}

function Metric({ value, label, primary, suffix }) {
  return (
    <div className={`px-5 py-3 rounded-2xl border ${primary ? 'bg-ink text-white border-ink' : 'bg-white border-line'}`}>
      <div className={`text-2xl font-semibold leading-none ${primary ? 'text-white' : 'text-ink'}`}>
        {value}{suffix ? <span className="text-base ml-0.5">{suffix}</span> : null}
      </div>
      <div className={`text-[11px] mt-1.5 ${primary ? 'text-white/70' : 'text-ink-faint'}`}>{label}</div>
    </div>
  );
}

export function Loading() {
  return (
    <div className="py-24 flex flex-col items-center gap-3 text-ink-faint animate-fade">
      <div className="hanzi text-3xl animate-pulse">学</div>
      <span className="text-sm">Loading…</span>
    </div>
  );
}

export function ErrorNote({ msg }) {
  return <div className="p-4 rounded-2xl bg-white border border-line text-ink-soft text-sm">Error: {msg}</div>;
}
