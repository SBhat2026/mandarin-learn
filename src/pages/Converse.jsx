import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { playAudio, speak, normalizeHanzi, captureSpoken, spokenCaptureSupported } from '../lib/speech.js';
import { TonedPinyin, ScriptBubble, scriptModeFromLevel } from '../components/Toned.jsx';

// One continuous conversation with Laoshi, laid out as a LADDER. At the guided rungs
// (0/1) every teacher sentence is rendered word-by-word (interlinear: hanzi / pinyin /
// gloss), new words are met in a small strip before they're used, and the learner can
// tap a ready-made reply — never forced into production they can't do, never stranded.
// At the free rung (2) it collapses to a plain sentence with tap-to-reveal. No lesson
// announcements, no scores — the plan stays hidden.
export default function Converse({ onFallback }) {
  const [session, setSession] = useState(null);
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [done, setDone] = useState(false);
  const [excursion, setExcursion] = useState(null);
  const [popover, setPopover] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [ime, setIme] = useState(null);          // live pinyin→hanzi conversion preview
  const imeTimer = useRef(null);
  const inputRef = useRef(null);
  const scroller = useRef(null);
  const opened = useRef(false);
  const pendingSpoken = useRef(null);
  const finished = useRef(false);
  const itemsRef = useRef(items);
  const sessionRef = useRef(null);
  const sessionId = session?.sessionId;
  const scriptMode = scriptModeFromLevel(session?.scriptLevel, session?.scriptPref);
  const canSpeak = spokenCaptureSupported();

  useEffect(() => {
    if (opened.current) return; opened.current = true;
    api.conversationPlan()
      .then(s => { setSession(s); return s; })
      .then(s => turn('', true, null, s.sessionId))
      .catch(() => onFallback?.());
  }, []);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [items, busy]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  // Leaving mid-conversation (including during the goodbye) must still record what
  // was learned — otherwise the two-beat close could silently drop a whole session.
  useEffect(() => () => {
    if (finished.current || !sessionRef.current) return;
    if (itemsRef.current.some(i => i.role === 'user')) finish(sessionRef.current, 'abandoned');
  }, []);

  function historyFor() {
    return items.filter(i => i.role === 'user' || i.role === 'assistant')
      .map(i => ({ role: i.role, content: i.role === 'user' ? i.hanzi : (i.hanzi + ' ' + (i.english || '')) }));
  }

  function reveal(i) {
    if (revealed[i]) return;
    setRevealed(r => ({ ...r, [i]: true }));
    api.signalChannel('reveal_text').catch(() => {});
  }

  // Ask Laoshi to finish. The teacher delivers a real goodbye (referring back to
  // something from this conversation) instead of the learner having to abandon the
  // page mid-sentence.
  function wrapUp() {
    if (busy || done || !sessionId) return;
    turn('', false, null, sessionId, false, true);
  }

  async function turn(text, opening = false, spoken = null, sid = sessionId, tapped = false, forceWrap = false) {
    if (busy || !sid) return;
    const history = historyFor();
    if (!opening && !forceWrap) {
      const last = items[items.length - 1];
      const lastIdx = items.length - 1;
      if (last?.role === 'assistant' && last.audioFirst && !revealed[lastIdx]) api.signalChannel('kept_audio').catch(() => {});
      setItems(prev => [...prev, { role: 'user', hanzi: text, tapped }]);
      if (spoken) api.pronObserve({ spoken: { ...spoken, transcript: text }, targetVocab: [] }).catch(() => {});
    }
    setInput(''); pendingSpoken.current = null; setBusy(true);
    try {
      const reply = await api.conversationTurn({ sessionId: sid, history, userText: (opening || forceWrap) ? '' : text, forceWrap });
      if (!reply.hanzi && reply.english?.includes('backend')) { onFallback?.(); return; }
      setItems(prev => {
        const next = [...prev, {
          role: 'assistant',
          hanzi: reply.hanzi, pinyin: reply.pinyin, english: reply.english, note: reply.note,
          tokens: reply.tokens, newWords: reply.newWords, choices: reply.choices,
          intro: reply.intro, outro: reply.outro, reground: reply.reground, followFrame: reply.followFrame,
          invite: reply.invite, rung: reply.rung, knobs: reply.knobs, audioFirst: reply.audioFirst,
        }];
        if (reply.inlineRep) next.push({ type: 'rep', rep: reply.inlineRep });
        return next;
      });
      if (reply.intro?.hanzi) speak(reply.intro.hanzi);
      const say = reply.followFrame?.hanzi || reply.hanzi;
      if (say) setTimeout(() => speak(say), reply.intro?.hanzi ? 900 : 0);
      if (reply.excursion) setExcursion(reply.excursion);
      // `closing` is the first beat of the goodbye — the learner still gets to
      // reply. Only `shouldWrap` (the second beat) actually ends the conversation.
      if (reply.shouldWrap) finish(sid, reply.wrapReason);
    } catch { onFallback?.(); } finally { setBusy(false); }
  }

  // Tap a scaffolded choice → send it as the learner's turn. A confident pick is a
  // hidden comprehension signal that helps the ladder decide when to fade scaffolding.
  function chooseChip(choice) {
    if (busy || done) return;
    api.signalChoice(true).catch(() => {});
    // tapped=true: assisted production earns recognition-level credit post-hoc,
    // never full 'spoken' credit (conversation.js heuristicSignals).
    turn(choice.hanzi, false, null, sessionId, true);
  }

  function returnFromExcursion(ex) {
    setExcursion(null);
    const b = ex.exitBridge;
    if (b?.hanzi) { setItems(prev => [...prev, { role: 'assistant', hanzi: b.hanzi, pinyin: b.pinyin, english: b.english }]); speak(b.hanzi); }
  }

  function finish(sid = sessionId, endedReason = null) {
    if (finished.current) return;      // scheduling must run exactly once
    finished.current = true;
    setDone(true);
    const transcript = itemsRef.current.filter(i => i.role === 'user' || i.role === 'assistant');
    api.conversationComplete({ sessionId: sid, transcript, endedReason }).catch(() => {});
  }

  async function mic() {
    if (!canSpeak || listening || busy) return;
    setListening(true); setLevel(0);
    try {
      const lastTeacher = [...items].reverse().find(i => i.role === 'assistant')?.hanzi || '';
      const cap = await captureSpoken({ expectedSyllables: 3, timeoutMs: 6000, onLevel: setLevel, hint: lastTeacher });
      const spoken = { transcript: cap.transcript, alternatives: cap.alternatives, heardTones: null, timing: cap.timing };
      if (cap.transcript) { setInput(cap.transcript); pendingSpoken.current = spoken; }
    } catch {} finally { setListening(false); }
  }

  // Live pinyin IME: typing latin that looks like pinyin shows a hanzi preview;
  // tap it (or just send) to speak in characters. English ("how do I say…")
  // passes through untouched.
  function onInputChange(value) {
    setInput(value); pendingSpoken.current = null;
    clearTimeout(imeTimer.current);
    const latin = /^[a-zA-Z' ]{2,}$/.test(value.trim());
    if (!latin) { setIme(null); return; }
    imeTimer.current = setTimeout(async () => {
      try {
        const r = await api.pinyinConvert(value.trim());
        setIme(r.ok ? r : null);
      } catch { setIme(null); }
    }, 250);
  }

  function acceptIme() {
    if (!ime?.hanzi) return;
    setInput(ime.hanzi); setIme(null);
    inputRef.current?.focus();
  }

  function submitTyped() {
    let text = input.trim();
    if (!text) return;
    // Typed pinyin auto-converts on send — the preview showed what it becomes.
    if (ime?.ok && ime.hanzi && /^[a-zA-Z' ]+$/.test(text)) text = ime.hanzi;
    setIme(null);
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
  const lastAssistantIdx = items.reduce((acc, it, i) => (it.role === 'assistant' ? i : acc), -1);

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
            <TeacherBubble key={i} it={it} idx={i} scriptMode={scriptMode}
              hiddenAudio={it.audioFirst && !revealed[i]}
              onReveal={() => reveal(i)} onChar={lookupChar}
              isLast={i === lastAssistantIdx && !done}
              onChoose={chooseChip} />
          );
        })}
        {busy && <div className="text-ink-faint text-sm px-2">老师…</div>}
      </div>

      {popover && <WordPopover popover={popover} />}
      {excursion && <Excursion excursion={excursion} onDone={() => returnFromExcursion(excursion)} scriptMode={scriptMode} />}

      {done ? (
        <div className="mt-4 text-center text-ink-soft text-sm py-4 border-t border-line">聊到这儿 · 明天见</div>
      ) : (
        <div className="mt-3">
          {listening && <div className="text-center text-sm text-rose-500 mb-2 animate-pulse">Listening… speak now</div>}
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={() => { setInput('How do I say '); inputRef.current?.focus(); }}
              className="text-[12px] text-ink-soft hover:text-ink border border-line rounded-full px-3 py-1 bg-white/70">
              💬 Help me say something…
            </button>
            <button type="button" onClick={wrapUp} disabled={busy}
              className="ml-auto text-[12px] text-ink-faint hover:text-ink border border-line rounded-full px-3 py-1 bg-white/70 disabled:opacity-40"
              title="Finish the conversation">
              聊到这儿 · wrap up
            </button>
          </div>
          {ime?.ok && ime.hanzi && (
            <button type="button" onClick={acceptIme}
              className="mb-2 ml-2 flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-jade-50 border border-jade-200 hover:border-jade-400 transition">
              <span className="hanzi text-lg text-ink">{ime.hanzi}</span>
              <span className="text-[12px] text-jade-700"><TonedPinyin pinyin={ime.pinyin} /></span>
              <span className="text-[11px] text-ink-faint">tap or send ↵</span>
            </button>
          )}
          <div className="flex items-center gap-2">
            {canSpeak && (
              <button type="button" onClick={mic} disabled={busy}
                style={listening ? { transform: `scale(${micScale})` } : undefined}
                className={`w-14 h-14 shrink-0 rounded-full grid place-items-center text-2xl transition ${
                  listening ? 'bg-rose-500 text-white shadow-lg shadow-rose-200' : 'bg-ink text-white hover:opacity-90'}`}
                title="Speak">🎤</button>
            )}
            <form onSubmit={(e) => { e.preventDefault(); submitTyped(); }} className="flex-1 flex items-center gap-2">
              <input ref={inputRef} value={input} onChange={(e) => onInputChange(e.target.value)}
                placeholder={canSpeak ? 'Type pinyin or 汉字, or tap 🎤…' : 'Type pinyin, 汉字, or English…'}
                className="flex-1 px-4 py-3 rounded-full border border-line bg-white focus:outline-none focus:border-ink/40 hanzi" />
              <button type="submit" disabled={busy || !input.trim()} className="w-12 h-12 shrink-0 rounded-full bg-ink text-white grid place-items-center disabled:opacity-40">↑</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// One teacher bubble. Assembles, in order: an intro lead-in, the meet-the-words strip,
// the (re-grounded) interlinear sentence, and tap-to-say choices. Falls back to the
// plain reveal view at the free rung.
function TeacherBubble({ it, idx, scriptMode, hiddenAudio, onReveal, onChar, isLast, onChoose }) {
  const interlinear = it.knobs?.interlinear && it.knobs.interlinear !== 'reveal';
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] px-4 py-3 rounded-2xl rounded-bl-md bg-white border border-line space-y-2">
        {hiddenAudio ? (
          <button onClick={() => speak(it.hanzi)} onDoubleClick={onReveal} className="flex items-center gap-3 text-left">
            <span className="w-9 h-9 shrink-0 rounded-full bg-ink text-white grid place-items-center">🔊</span>
            <span className="text-[13px] text-ink-soft">Listen first — tap to replay, <button onClick={(e) => { e.stopPropagation(); onReveal(); }} className="text-jade-600 underline">show text</button></span>
          </button>
        ) : (
          <>
            {it.intro?.hanzi && <IntroLine line={it.intro} interlinear={interlinear} />}
            {it.newWords?.length > 0 && <MeetWords words={it.newWords} />}
            {it.reground && (
              <div className="rounded-xl bg-amber-50/60 border border-amber-100 px-3 py-2">
                <div className="text-[11px] text-amber-700/80 mb-1">let's break it down</div>
                <Interlinear tokens={it.reground.tokens} />
              </div>
            )}
            {interlinear
              ? <Interlinear tokens={(it.followFrame?.tokens) || it.tokens} english={(it.followFrame?.english) || it.english} />
              : <TeacherText hanzi={it.hanzi} pinyin={it.pinyin} english={it.english} mode={scriptMode} onChar={onChar} onSpeak={() => speak(it.hanzi)} />}
            {it.outro?.hanzi && <IntroLine line={it.outro} muted interlinear={interlinear} />}
            {it.note && <div className="text-[12px] text-jade-600 border-t border-line pt-2">💡 {it.note}</div>}
            {isLast && it.choices?.length > 0 && <Choices choices={it.choices} invite={it.invite} onChoose={onChoose} />}
          </>
        )}
      </div>
    </div>
  );
}

// A small warm lead-in / send-off line. This is still Chinese, so at the guided rungs
// it gets the same word-by-word treatment as everything else — it used to render
// hanzi + English with NO pinyin, which made the first line a beginner ever sees the
// one line they could not read.
function IntroLine({ line, muted, interlinear }) {
  if (interlinear && line.tokens?.length) {
    return (
      <div className={muted ? 'opacity-80' : ''}>
        <Interlinear tokens={line.tokens} english={line.english} />
      </div>
    );
  }
  return (
    <button onClick={() => speak(line.hanzi)} className={`block text-left ${muted ? 'opacity-80' : ''}`}>
      <span className="hanzi text-[15px] text-ink">{line.hanzi}</span>
      {line.pinyin && <span className="text-[12px] text-jade-600 ml-2"><TonedPinyin pinyin={line.pinyin} /></span>}
      <span className="text-[12px] text-ink-faint ml-2">{line.english}</span>
    </button>
  );
}

// Meet-the-words: introduce each new word (emoji/image + hanzi + pinyin + gloss + audio)
// BEFORE it is used in a sentence. Not a game — just a gentle "here are the words".
function MeetWords({ words }) {
  return (
    <div className="flex gap-2 flex-wrap py-1">
      {words.map((w, i) => (
        <button key={i} onClick={() => (w.audioRef ? playAudio({ audio_path: w.audioRef, hanzi: w.hanzi }) : speak(w.hanzi))}
          className={`flex flex-col items-center px-3 py-2 rounded-2xl border text-center transition min-w-[64px] ${
            w.isNew ? 'bg-jade-50/70 border-jade-200' : 'bg-white border-line'}`} title="Tap to hear">
          <span className="text-lg leading-none mb-0.5">{w.imageRef?.kind === 'emoji' ? w.imageRef.value : '🔊'}</span>
          <span className="hanzi text-xl text-ink leading-tight">{w.hanzi}</span>
          <span className="text-[11px] text-jade-700"><TonedPinyin pinyin={w.pinyin} /></span>
          <span className="text-[11px] text-ink-faint">{w.gloss}</span>
        </button>
      ))}
    </div>
  );
}

// Interlinear: render each word as a stacked unit — hanzi / colored pinyin / English
// gloss — new words highlighted, each tappable to replay its own audio. This is the
// per-word grounding that makes a beginner sentence decodable.
function Interlinear({ tokens = [], english }) {
  if (!tokens.length) return null;
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-1 gap-y-1.5">
        {tokens.map((t, i) => {
          const punct = /^[。，？！、：；·]+$/.test(t.hanzi);
          if (punct) return <span key={i} className="hanzi text-xl text-ink self-end pb-1">{t.hanzi}</span>;
          return (
            <button key={i} onClick={() => speak(t.hanzi)}
              className={`flex flex-col items-center px-1 rounded-lg hover:bg-ink/5 ${t.isNew ? 'bg-jade-50' : ''}`} title="Tap to hear">
              {t.pinyin && <span className={`text-[11px] leading-tight ${t.isNew ? 'text-jade-700' : 'text-ink-faint'}`}><TonedPinyin pinyin={t.pinyin} /></span>}
              <span className={`hanzi text-xl leading-tight ${t.isNew ? 'text-jade-800' : 'text-ink'}`}>{t.hanzi}</span>
              {t.gloss && <span className="text-[10px] leading-tight text-ink-faint/90 max-w-[72px] truncate">{t.gloss}</span>}
            </button>
          );
        })}
      </div>
      {english && <div className="text-[12px] text-ink-faint/80 mt-1.5">{english}</div>}
    </div>
  );
}

// Scaffolded responses: glossed tap-to-say chips. Tapping sends it as the learner's
// turn. No scoring, no "correct/wrong" — just ready ways to reply so they're never stuck.
function Choices({ choices, invite, onChoose }) {
  return (
    <div className="pt-1.5 border-t border-line/70">
      {invite && <div className="text-[11px] text-jade-700 mb-1">你试试看 · your turn — tap to say it</div>}
      <div className="flex flex-wrap gap-1.5">
        {choices.map((c, i) => (
          <button key={i} onClick={() => onChoose(c)}
            className="px-3 py-1.5 rounded-full text-left border border-line bg-white hover:border-jade-300 hover:bg-jade-50/50 transition">
            <span className="hanzi text-[15px] text-ink">{c.hanzi}</span>
            {c.gloss && <span className="text-[11px] text-ink-faint ml-1.5">{c.gloss}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Free-rung plain sentence + per-character tap-to-look-up (tap-to-reveal reading).
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
  const [anchor, setAnchor] = useState(null);
  useEffect(() => { let ok = true; api.image(term).then(r => ok && r?.kind !== 'none' && setAnchor(r)).catch(() => {}); return () => { ok = false; }; }, [term]);
  const top = Math.min(y + 6, (typeof window !== 'undefined' ? window.innerHeight : 800) - 160);
  return (
    <div className="fixed z-40 w-64 p-3 rounded-2xl bg-white border border-line shadow-lift text-sm" style={{ left: Math.max(8, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 400) - 264)), top }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-1">
        <span className="hanzi text-xl text-ink flex items-center gap-2">
          {term}
          {anchor?.kind === 'emoji' && <span className="text-lg" title="picture">{anchor.value}</span>}
          {anchor?.kind === 'url' && <img src={anchor.value} alt="" className="w-8 h-8 rounded object-cover" />}
        </span>
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

function InlineRep({ rep }) {
  const [answered, setAnswered] = useState(null);
  const [anchor, setAnchor] = useState(null);
  useEffect(() => { let ok = true; api.image(rep.hanzi).then(r => ok && r?.kind !== 'none' && setAnchor(r)).catch(() => {}); return () => { ok = false; }; }, [rep.hanzi]);
  async function answer(opt) {
    if (answered) return;
    const correct = opt === rep.gloss;
    setAnswered({ opt, correct });
    api.review({ cardId: rep.cardId, rating: correct ? 3 : 2, dimension: 'meaning', exercise: 'recognition', durationMs: 0 }).catch(() => {});
    api.signalChoice(correct).catch(() => {});
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-bl-md bg-jade-50/60 border border-jade-100">
        <div className="flex items-center gap-2 mb-2">
          <button onClick={() => (rep.audio ? playAudio({ audio_path: rep.audio, hanzi: rep.hanzi }) : speak(rep.hanzi))} className="w-8 h-8 rounded-full bg-white border border-line grid place-items-center text-sm">🔊</button>
          <span className="hanzi text-2xl text-ink">{rep.hanzi}</span>
          {anchor?.kind === 'emoji' && <span className="text-xl" title="picture">{anchor.value}</span>}
          {anchor?.kind === 'url' && <img src={anchor.value} alt="" className="w-7 h-7 rounded object-cover" />}
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

function Excursion({ excursion, onDone, scriptMode }) {
  if (excursion.kind !== 'tone_drill' && excursion.kind !== 'shadowing') { onDone(); return null; }
  const enter = excursion.enterLine;
  return (
    <div className="fixed inset-0 z-30 flex items-end sm:items-center justify-center bg-ink/20 backdrop-blur-sm p-4" onClick={onDone}>
      <div className="w-full max-w-md rounded-3xl bg-white border border-line shadow-lift p-6 animate-rise" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4"><ScriptBubble hanzi={enter.hanzi} pinyin={enter.pinyin} english={enter.english} mode={scriptMode} /></div>
        {excursion.kind === 'shadowing'
          ? <Shadowing shadow={excursion.shadow} />
          : (
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
          )}
        <button onClick={onDone} className="mt-5 w-full py-3 rounded-full bg-ink text-white font-medium hover:opacity-90 transition">回到聊天 →</button>
      </div>
    </div>
  );
}

function Shadowing({ shadow }) {
  const [busyIdx, setBusyIdx] = useState(-1);
  const [heard, setHeard] = useState({});
  const canSpeak = spokenCaptureSupported();

  async function echo(idx, item) {
    if (busyIdx >= 0) return;
    setBusyIdx(idx);
    try {
      const cap = await captureSpoken({ expectedSyllables: [...item.hanzi].length, timeoutMs: 6000, hint: item.hanzi });
      if (cap?.transcript) {
        setHeard(h => ({ ...h, [idx]: true }));
        api.pronObserve({ spoken: { transcript: cap.transcript, alternatives: cap.alternatives, heardTones: null, timing: cap.timing },
          targetVocab: shadow.targetVocab || [] }).catch(() => {});
      }
    } catch {} finally { setBusyIdx(-1); }
  }

  return (
    <div className="space-y-2">
      {shadow.items.map((s, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-white border border-line">
          <button onClick={() => (s.audio ? playAudio({ audio_path: s.audio, hanzi: s.hanzi }) : speak(s.hanzi))}
            className="w-8 h-8 shrink-0 rounded-full bg-ink/5 grid place-items-center text-sm" title="Listen">🔊</button>
          <div className="min-w-0 flex-1">
            <div className="hanzi text-lg text-ink truncate">{s.hanzi}</div>
            <div className="text-[12px] text-ink-faint truncate">{s.pinyin}</div>
          </div>
          {canSpeak && (
            <button onClick={() => echo(i, s)} disabled={busyIdx >= 0}
              className={`w-9 h-9 shrink-0 rounded-full grid place-items-center text-sm transition ${
                heard[i] ? 'bg-jade-500 text-white' : busyIdx === i ? 'bg-rose-500 text-white animate-pulse' : 'bg-ink text-white hover:opacity-90'}`}
              title="Repeat">{heard[i] ? '✓' : '🎤'}</button>
          )}
        </div>
      ))}
    </div>
  );
}
