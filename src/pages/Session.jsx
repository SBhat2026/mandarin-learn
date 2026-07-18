import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Loading } from './Home.jsx';
import { playAudio, listenOnce, recognitionSupported, normalizeHanzi } from '../lib/speech.js';

const RATING = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
const RATING_KEYS = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

export default function Session() {
  const [session, setSession] = useState(null);
  const [queue, setQueue] = useState([]);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState({ count: 0, again: 0 });
  const [drillDone, setDrillDone] = useState(false);
  const startedAt = useRef(Date.now());
  const navigate = useNavigate();

  const load = useCallback(() => {
    api.session().then(s => {
      setSession(s);
      setQueue([...s.due, ...s.new]);
      setIdx(0); setRevealed(false);
      startedAt.current = Date.now();
    });
  }, []);
  useEffect(load, [load]);

  const card = queue[idx];

  const grade = useCallback(async (rating, extra = {}) => {
    if (!card) return;
    const durationMs = Date.now() - startedAt.current;
    api.review({ cardId: card.id, rating, durationMs, ...extra }).catch(() => {});
    setDone(d => ({ count: d.count + 1, again: d.again + (rating === 1 ? 1 : 0) }));
    setIdx(idx + 1); setRevealed(false); startedAt.current = Date.now();
  }, [card, idx]);

  useEffect(() => {
    const onKey = (e) => {
      if (!card || card.card_type === 'speaking') return;
      if (e.code === 'Space') { e.preventDefault(); if (!revealed) setRevealed(true); return; }
      if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        grade(RATING[RATING_KEYS[e.key]]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, revealed, grade]);

  if (!session) return <Loading />;

  if (session.toneDrill && !drillDone && idx === 0 && done.count === 0) {
    return <ToneDrillIntro drill={session.toneDrill} onSkip={() => setDrillDone(true)} />;
  }

  if (!card) return <Complete done={done} onMore={load} onHome={() => navigate('/')} hadCards={queue.length > 0} />;

  return (
    <div className="animate-rise">
      <ProgressBar idx={idx} total={queue.length} unit={session.unit} counts={session.counts} />
      <CardView key={card.id} card={card} revealed={revealed}
        onReveal={() => setRevealed(true)} onGrade={grade} />
    </div>
  );
}

function ProgressBar({ idx, total, unit, counts }) {
  return (
    <div className="mb-7">
      <div className="flex justify-between items-baseline text-[12px] text-ink-faint mb-2">
        <span className="font-medium text-ink-soft">{unit ? unit.name : 'Review'}</span>
        <span>{idx} / {total}{counts ? ` · ${counts.due} due · ${counts.new} new` : ''}</span>
      </div>
      <div className="h-1 rounded-full bg-[#f0ede8] overflow-hidden">
        <div className="h-full bg-jade-400 transition-all duration-300" style={{ width: total ? (idx / total * 100) + '%' : 0 }} />
      </div>
    </div>
  );
}

function CardView(props) {
  const t = props.card.card_type;
  if (t === 'speaking') return <SpeakingCard {...props} />;
  if (t === 'reading') return <ReadingCard {...props} />;
  return <ListeningCard {...props} />;
}

function Chip({ children }) {
  return (
    <span className="text-[10.5px] uppercase tracking-[0.12em] px-2.5 py-1 rounded-full bg-stone-100 text-ink-faint font-medium">
      {children}
    </span>
  );
}

const GRADE_STYLE = {
  Again: 'text-rose-700 border-rose-200 hover:bg-rose-50',
  Hard: 'text-amber-700 border-amber-200 hover:bg-amber-50',
  Good: 'text-jade-700 border-jade-200 hover:bg-jade-50',
  Easy: 'text-slate-600 border-slate-200 hover:bg-slate-50',
};

function GradeButtons({ onGrade, extra, highlight }) {
  return (
    <div className="grid grid-cols-4 gap-2.5 mt-8">
      {Object.entries(RATING).map(([label, val]) => (
        <button key={label} onClick={() => onGrade(val, extra)}
          className={`py-3.5 rounded-2xl bg-white border font-medium transition ${GRADE_STYLE[label]}
            ${highlight === label ? 'ring-2 ring-jade-300' : ''}`}>
          <div className="text-[15px]">{label}</div>
          <div className="text-[10px] opacity-50 mt-0.5">{val}</div>
        </button>
      ))}
    </div>
  );
}

function AudioBtn({ card, label = 'Play audio', big }) {
  return (
    <button onClick={() => playAudio(card)}
      className={`inline-flex items-center gap-2 rounded-full border border-line bg-white text-ink-soft
        hover:text-ink hover:shadow-soft transition ${big ? 'px-6 py-3 text-[15px]' : 'px-4 py-2 text-[13px]'}`}>
      <span className="text-jade-500">◍</span> {label}
    </button>
  );
}

function Shell({ chip, children }) {
  return (
    <div className="card-face px-8 py-12 sm:px-12 sm:py-14 text-center min-h-[440px] flex flex-col">
      <div className="flex justify-center mb-8"><Chip>{chip}</Chip></div>
      <div className="flex-1 flex flex-col justify-center">{children}</div>
    </div>
  );
}

function ListeningCard({ card, revealed, onReveal, onGrade }) {
  useEffect(() => { const t = setTimeout(() => playAudio(card), 220); return () => clearTimeout(t); }, [card.id]);
  return (
    <Shell chip={`Listening · ${card.kind}`}>
      {!revealed ? (
        <>
          <p className="text-ink-soft mb-8">Listen, then recall the meaning.</p>
          <div className="mb-10"><AudioBtn card={card} label="Replay" big /></div>
          <RevealBtn onReveal={onReveal} />
        </>
      ) : <Reveal card={card} onGrade={onGrade} showHanzi withAudio />}
    </Shell>
  );
}

function ReadingCard({ card, revealed, onReveal, onGrade }) {
  return (
    <Shell chip={`Reading · ${card.kind}`}>
      <div className="hanzi text-6xl sm:text-7xl leading-none mb-5 text-ink">{card.hanzi}</div>
      {!revealed ? (
        <>
          <p className="text-ink-faint text-sm mb-9">Say it aloud, then recall the meaning.</p>
          <RevealBtn onReveal={onReveal} />
        </>
      ) : <Reveal card={card} onGrade={onGrade} withAudio />}
    </Shell>
  );
}

function RevealBtn({ onReveal }) {
  return (
    <button onClick={onReveal}
      className="mx-auto inline-flex items-center gap-2 px-7 py-3 rounded-2xl bg-ink text-white font-medium
                 shadow-soft hover:shadow-lift transition">
      Reveal <kbd className="!bg-white/15 !border-white/20 !text-white/90">space</kbd>
    </button>
  );
}

function Reveal({ card, onGrade, showHanzi, withAudio, extra }) {
  return (
    <div className="animate-rise">
      {showHanzi && <div className="hanzi text-6xl sm:text-7xl leading-none mb-4 text-ink">{card.hanzi}</div>}
      <div className="text-2xl text-jade-600 font-medium">{card.pinyin || '—'}</div>
      <div className="text-lg text-ink-soft mt-2 max-w-md mx-auto">{card.english}</div>
      {card.pattern_tag && <div className="mt-2 text-[12px] text-ink-faint">pattern · {card.pattern_tag}</div>}
      {withAudio && <div className="mt-6"><AudioBtn card={card} /></div>}
      <GradeButtons onGrade={onGrade} extra={extra || {}} />
      <p className="text-[12px] text-ink-faint mt-4">Grade with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></p>
    </div>
  );
}

function SpeakingCard({ card, onGrade }) {
  const [phase, setPhase] = useState('prompt');
  const [heard, setHeard] = useState(null);
  const [matched, setMatched] = useState(false);
  const supported = recognitionSupported();
  const target = normalizeHanzi(card.hanzi);

  async function startListen() {
    if (!supported) { setPhase('result'); setHeard(null); return; }
    setPhase('listening');
    try {
      const { transcript } = await listenOnce({});
      const ok = normalizeHanzi(transcript) === target;
      setHeard(transcript); setMatched(ok); setPhase('result');
    } catch { setHeard(null); setMatched(false); setPhase('result'); }
  }

  const extra = { targetTone: card.tone_pattern || null, heardTone: heard == null ? null : (matched ? card.tone_pattern : '0') };

  return (
    <Shell chip={`Speaking · ${card.kind}`}>
      <p className="text-ink-faint text-sm mb-2">Say this in Mandarin</p>
      <div className="text-2xl sm:text-3xl font-semibold mb-9 max-w-md mx-auto">{card.english}</div>

      {phase === 'prompt' && (
        <button onClick={startListen}
          className="mx-auto inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl bg-ink text-white font-medium shadow-soft hover:shadow-lift transition">
          <span className="w-2 h-2 rounded-full bg-jade-400" /> {supported ? 'Hold to speak' : 'Listen & self-grade'}
        </button>
      )}
      {phase === 'listening' && (
        <div className="flex flex-col items-center gap-3 py-4 animate-fade">
          <div className="flex items-end gap-1 h-8">
            {[0, 1, 2, 3, 4].map(i => <span key={i} className="w-1.5 bg-jade-400 rounded-full animate-pulse" style={{ height: `${8 + (i % 3) * 8}px`, animationDelay: `${i * 0.1}s` }} />)}
          </div>
          <span className="text-ink-soft text-sm">Listening…</span>
        </div>
      )}

      {phase === 'result' && (
        <div className="animate-rise">
          <div className="hanzi text-5xl sm:text-6xl leading-none mb-3 text-ink">{card.hanzi}</div>
          <div className="text-xl text-jade-600 font-medium">{card.pinyin}</div>
          <div className="mt-5"><AudioBtn card={card} label="Hear target — compare tones" /></div>

          {supported && heard != null && (
            <div className={`mt-5 mx-auto max-w-sm p-3 rounded-2xl text-sm border
              ${matched ? 'bg-jade-50 border-jade-200 text-jade-700' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
              {matched ? '✓ Matched the target' : (
                <div className="flex items-center justify-center gap-2">
                  <span className="hanzi-sans">{heard || '—'}</span><span className="opacity-40">→</span><span className="hanzi-sans">{card.hanzi}</span>
                </div>
              )}
            </div>
          )}
          {supported && heard == null && <p className="mt-5 text-sm text-amber-600">Didn’t catch that — replay and self-grade.</p>}
          {!supported && <p className="mt-5 text-sm text-ink-faint">Speech recognition isn’t available here. Repeat aloud and grade yourself.</p>}

          <GradeButtons onGrade={onGrade} extra={extra} highlight={matched ? 'Good' : null} />
          <p className="text-[12px] text-ink-faint mt-4">{matched ? 'Match suggests “Good”. ' : ''}You decide.</p>
        </div>
      )}
    </Shell>
  );
}

function Complete({ done, onMore, onHome, hadCards }) {
  return (
    <div className="card-face px-8 py-16 text-center animate-rise">
      <div className="hanzi text-5xl mb-5 text-jade-500">好</div>
      <h2 className="text-2xl font-semibold">{hadCards ? 'Session complete' : 'All caught up'}</h2>
      <p className="text-ink-soft mt-2">
        {hadCards ? `${done.count} cards reviewed${done.again ? ` · ${done.again} to revisit` : ''}.` : 'Nothing due right now. New words unlock as you progress.'}
      </p>
      <div className="mt-8 flex gap-3 justify-center">
        <button onClick={onMore} className="px-6 py-2.5 rounded-2xl bg-ink text-white font-medium shadow-soft hover:shadow-lift transition">More</button>
        <button onClick={onHome} className="px-6 py-2.5 rounded-2xl bg-white border border-line text-ink-soft hover:text-ink transition">Home</button>
      </div>
    </div>
  );
}

function ToneDrillIntro({ drill, onSkip }) {
  return (
    <div className="card-face px-8 py-12 text-center animate-rise">
      <div className="flex justify-center mb-5"><Chip>Warm-up · tone {drill.tone}</Chip></div>
      <h2 className="text-xl font-semibold">A quick tone drill first</h2>
      <p className="text-ink-soft text-sm mt-2 max-w-sm mx-auto">Tone {drill.tone} has been slipping. Tap each pair and listen for the contrast.</p>
      <div className="grid grid-cols-2 gap-3 mt-7">
        {drill.items.map((it, i) => (
          <div key={i} className="p-3 rounded-2xl border border-line bg-white flex items-center justify-around">
            {it.pair.map((w, j) => (
              <button key={j} onClick={() => playAudio(w)} className="text-center px-2 hover:scale-[1.03] transition">
                <div className="hanzi text-3xl text-ink">{w.hanzi}</div>
                <div className="text-[13px] text-jade-600 mt-0.5">{w.pinyin}</div>
              </button>
            ))}
          </div>
        ))}
      </div>
      <button onClick={onSkip} className="mt-8 px-6 py-2.5 rounded-2xl bg-ink text-white font-medium shadow-soft hover:shadow-lift transition">Begin reviews →</button>
    </div>
  );
}
