import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { TonedPinyin } from '../components/Toned.jsx';

// Home is a DOOR, not a map. It used to show a numbered path of units, which meant
// the first thing you saw every day was how far you still had to go. Now it shows
// exactly two ways forward — speaking and reading — each phrased as the next thing
// to do, with progress expressed as what you can already do rather than as a
// position on a ladder.
export default function Home() {
  const [data, setData] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.home().then(setData).catch(e => setData({ error: e.message })); }, []);

  if (!data) return <Loading />;
  if (data.error) return <ErrorNote msg={data.error} />;

  const { speak, read, progress, dueNow, streak, placement } = data;
  const offerExam = placement && !placement.taken;

  return (
    <div className="animate-rise">
      {offerExam && <ExamOffer onTake={() => navigate('/placement')} />}

      <section className="mb-7">
        <div className="text-[13px] font-medium text-ink-faint mb-1">
          {speak?.started ? 'Welcome back' : 'Welcome'}
        </div>
        <h1 className="text-3xl font-semibold tracking-tightish">
          {speak?.started ? '继续' : '开始吧'}
          <span className="text-ink-faint text-xl font-normal ml-3">
            {speak?.started ? 'keep going' : "let's begin"}
          </span>
        </h1>
      </section>

      {/* The two tracks. Speaking leads — it is the point of the app. */}
      <div className="space-y-3 mb-8">
        <TrackCard
          primary
          hanzi="说" latin="Speak"
          title={speak?.label}
          onClick={() => navigate('/converse')}
          cta={speak?.started ? '继续聊' : '跟老师聊聊'}
          detail={
            speak?.pickUpFrom?.length
              ? <WordThread words={speak.pickUpFrom} />
              : <span className="text-[13px] text-ink-faint">Laoshi will introduce a few words and talk with you about them.</span>
          }
        />
        <TrackCard
          hanzi="读" latin="Read"
          title={read?.label}
          disabled={!read?.ready}
          onClick={() => read?.ready && navigate('/reading')}
          cta={read?.hasStory ? '接着读' : '读一读'}
          detail={
            read?.ready
              ? (<>
                  {read.title
                    ? <span className="text-[13px] text-ink-soft"><span className="hanzi text-[15px] mr-2">{read.title.hanzi}</span>{read.title.english}</span>
                    : <span className="text-[13px] text-ink-faint">A short story written from the words you know.</span>}
                  {/* Coverage, not a level — the number that says whether a page is readable. */}
                  {read.charactersMet > 0 && (
                    <div className="text-[12px] text-ink-faint mt-1">
                      <b className="text-ink">{read.charactersMet}</b> characters ·
                      about <b className="text-ink">{Math.round((read.coverage || 0) * 100)}%</b> of everyday text
                    </div>
                  )}
                </>)
              : <span className="text-[13px] text-ink-faint">Meet a few more words in conversation and a story appears here.</span>
          }
        />
      </div>

      {/* One quiet line of state. No levels, no percentage-to-next-tier. */}
      <div className="flex items-center gap-5 text-[12px] text-ink-faint mb-8 px-1">
        <span><b className="text-ink text-[13px]">{progress?.known ?? 0}</b> words you can use</span>
        <span><b className="text-ink text-[13px]">{progress?.met ?? 0}</b> met so far</span>
        {dueNow > 0 && <span><b className="text-ink text-[13px]">{dueNow}</b> ready to revisit</span>}
        {streak > 0 && <span><b className="text-ink text-[13px]">{streak}</b> day streak 🔥</span>}
      </div>

      <TodayControls />
    </div>
  );
}

// A one-time, dismissible-by-doing offer. Deliberately not a wall: the app is fully
// usable without ever taking it.
function ExamOffer({ onTake }) {
  const [busy, setBusy] = useState(false);
  async function skip() {
    if (busy) return;
    setBusy(true);
    try { await api.placementSkip(); window.location.reload(); } catch { setBusy(false); }
  }
  return (
    <section className="mb-7 card-face p-5 border-jade-200 bg-jade-50/40">
      <div className="text-[13px] font-medium text-ink mb-1">Have you studied Chinese before?</div>
      <p className="text-[13px] text-ink-soft mb-3.5">
        A one-minute chat with Laoshi finds where to start you. Or skip it and start from the beginning —
        the app works either way and adjusts as you go.
      </p>
      <div className="flex items-center gap-2">
        <button onClick={onTake}
          className="px-4 py-2 rounded-full bg-ink text-white text-[13px] font-medium hover:opacity-90 transition">
          Take the quick check →
        </button>
        <button onClick={skip} disabled={busy}
          className="px-4 py-2 rounded-full border border-line bg-white text-[13px] text-ink-soft hover:border-ink/30 transition disabled:opacity-50">
          {busy ? 'Setting up…' : 'Start from the beginning'}
        </button>
      </div>
    </section>
  );
}

// The words a session will pick back up from — concrete evidence that yesterday
// happened, which is what "continue" should mean.
function WordThread({ words }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {words.map((w, i) => (
        <span key={i} className="inline-flex items-baseline gap-1.5 px-2.5 py-1 rounded-full bg-white/80 border border-line">
          <span className="hanzi text-[15px] text-ink">{w.hanzi}</span>
          <span className="text-[11px] text-jade-700"><TonedPinyin pinyin={w.pinyin} /></span>
          <span className="text-[11px] text-ink-faint">{w.gloss}</span>
        </span>
      ))}
    </div>
  );
}

function TrackCard({ hanzi, latin, title, detail, cta, onClick, primary, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`w-full text-left rounded-3xl border p-5 transition group ${
        disabled ? 'bg-white/40 border-line/70 cursor-default'
          : primary ? 'bg-white border-ink/15 shadow-soft hover:shadow-lift'
          : 'bg-white border-line hover:border-ink/25 hover:shadow-soft'}`}>
      <div className="flex items-center gap-4">
        <span className={`hanzi text-3xl leading-none w-12 shrink-0 ${disabled ? 'text-ink-faint' : 'text-ink'}`}>{hanzi}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-0.5">{latin}</div>
          <div className={`font-medium mb-1.5 ${disabled ? 'text-ink-soft' : 'text-ink'}`}>{title}</div>
          {detail}
        </div>
        {!disabled && (
          <span className={`shrink-0 px-4 py-2 rounded-full text-[13px] font-medium transition ${
            primary ? 'bg-ink text-white' : 'border border-line text-ink-soft group-hover:border-ink/30'}`}>
            <span className="hanzi">{cta}</span> →
          </span>
        )}
      </div>
    </button>
  );
}

// Visible learner controls over the (otherwise invisible) engine: pace dial,
// today's conversation topics, a "stretch me" toggle, and can-do progress.
function TodayControls() {
  const [prefs, setPrefs] = useState(null);
  const [open, setOpen] = useState(false);
  const saveTimer = useRef(null);
  const pending = useRef({});

  useEffect(() => { api.prefs().then(setPrefs).catch(() => setPrefs(null)); }, []);
  if (!prefs) return null;

  function push(next) {
    setPrefs(p => ({ ...p, ...next }));
    pending.current = { ...pending.current, ...next };   // accumulate — rapid edits all save
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const body = pending.current; pending.current = {};
      api.setPrefs(body).catch(() => {});
    }, 400);
  }
  function toggleTopic(t) {
    const cur = prefs.topics || [];
    const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t].slice(-3);
    push({ topics: next });
  }

  const prog = prefs.progress || {};
  return (
    <section className="mb-8 card-face p-5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink">Your pace & topics</span>
        <span className="text-[12px] text-ink-faint">
          {prefs.pace} new words/day{prefs.stretch ? ' · stretching' : ''}{(prefs.topics || []).length ? ` · ${prefs.topics.join(', ')}` : ''} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="mt-4 space-y-4 animate-fade">
          <div>
            <div className="flex justify-between text-[12px] text-ink-faint mb-1">
              <span>New words per day</span><span className="text-ink font-medium">{prefs.pace}</span>
            </div>
            <input type="range" min="3" max="35" value={prefs.pace}
              onChange={(e) => push({ pace: Number(e.target.value) })} className="w-full accent-black" />
          </div>
          <div>
            <div className="text-[12px] text-ink-faint mb-1.5">What do you want to talk about today? <span className="text-ink-faint/60">(up to 3)</span></div>
            <div className="flex flex-wrap gap-1.5">
              {(prefs.allTopics || []).map(t => (
                <button key={t} onClick={() => toggleTopic(t)}
                  className={`px-2.5 py-1 rounded-full text-[12px] border capitalize transition ${
                    (prefs.topics || []).includes(t) ? 'bg-ink text-white border-ink' : 'bg-white text-ink-soft border-line hover:border-ink/30'}`}>{t}</button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink-soft cursor-pointer">
            <input type="checkbox" checked={prefs.stretch} onChange={(e) => push({ stretch: e.target.checked })} className="accent-black" />
            Stretch me — longer, harder conversations
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink-soft cursor-pointer">
            <input type="checkbox" checked={prefs.script === 'hanzi'} onChange={(e) => push({ script: e.target.checked ? 'hanzi' : 'auto' })} className="accent-black" />
            Characters first — hanzi as the headline, pinyin underneath
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink-soft cursor-pointer">
            <input type="checkbox" checked={prefs.style === 'visual'} onChange={(e) => push({ style: e.target.checked ? 'visual' : 'balanced' })} className="accent-black" />
            I learn by reading — fewer listening drills, text never hidden
          </label>
          <div className="pt-3 border-t border-line flex gap-5 text-[12px] text-ink-faint">
            <span><b className="text-ink">{prog.knownWords ?? 0}</b> words solid</span>
            <span><b className="text-ink">{prog.readWords ?? 0}</b> read well</span>
            <span><b className="text-ink">{prog.capabilitiesUnlocked ?? 0}</b>/{prog.capabilitiesTotal ?? 0} things you can do</span>
          </div>
        </div>
      )}
    </section>
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
