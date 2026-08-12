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
  const [profile, setProfile] = useState(null);
  const [pop, setPop] = useState(null);
  const [answers, setAnswers] = useState({});
  const [finished, setFinished] = useState(false);
  const [loadingFresh, setLoadingFresh] = useState(false);

  useEffect(() => {
    api.story().then(r => setStory(r.story ?? null)).catch(() => setStory(null));
    api.reading().then(d => setPassages(d.passages || [])).catch(() => {});
    api.readingProfile().then(setProfile).catch(() => {});
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
      const { results, insight } = await api.charInsight(context);
      setPop({ term: context, results, insight, x: rect.left, y: rect.bottom + window.scrollY });
    } catch { setPop(null); }
  }

  if (story === undefined) return <Loading />;

  const allAnswered = story?.questions?.length ? story.questions.every((q, i) => answers[i] != null) : true;

  return (
    <div className="animate-rise" onClick={(e) => { if (!e.target.closest('.lookup-pop')) setPop(null); }}>
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tightish">Reading</h1>
          <p className="text-ink-soft mt-1.5">A little story at your level. Tap a character to work it out; tap ◍ to hear a line.</p>
          {profile && <CoverageLine p={profile} />}
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
          <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-1">More to read — easiest first</div>
          <p className="text-[12px] text-ink-faint mb-3">
            Sentences you can mostly decode. A dotted character is one you haven't met — read past it if you can.
          </p>
          <div className="space-y-4">
            {passages.map(p => (
              <article key={p.index} className="card-face p-7">
                <div className="text-[11px] text-ink-faint mb-4">{BAND_COPY[p.band]}</div>
                <div className="space-y-5">
                  {p.sentences.map(s => <Sentence key={s.id} s={s} onChar={tapChar} />)}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {profile?.highYield?.length > 0 && <HighYield chars={profile.highYield} />}

      {pop && <CharPopover pop={pop} onClose={() => setPop(null)} />}
    </div>
  );
}

// An honest readout of where reading stands. Coverage of running text — not a level,
// not a percentage of a syllabus — because coverage is what actually decides whether
// a page can be read: ~95% is reasonable, ~98% comfortable, below ~90% it is decoding.
const BAND_COPY = {
  comfortable: 'most pages read comfortably',
  readable: 'you can follow most of what you meet',
  effortful: 'readable with a few stops per line',
  'too-hard': 'still decoding — every character counts right now',
};

function CoverageLine({ p }) {
  const pct = Math.round((p.estimatedCoverage || 0) * 100);
  return (
    <p className="text-[12px] text-ink-faint mt-2">
      <b className="text-ink text-[13px]">{p.charactersMet}</b> characters met ·
      you recognise about <b className="text-ink text-[13px]">{pct}%</b> of everyday text — {BAND_COPY[p.band]}
      {p.toReadable > 0 && <> · <span className="text-jade-700">~{p.toReadable} more to read freely</span></>}
    </p>
  );
}

// The acceleration lever, made visible. Not "the next most frequent character" but
// the one that makes the MOST other characters guessable — learning 方 buys nine
// characters' worth of reading, an equally frequent isolated character buys one.
function HighYield({ chars }) {
  return (
    <section className="mt-8">
      <div className="text-[11px] uppercase tracking-[0.12em] text-ink-faint mb-1">Characters that unlock the most</div>
      <p className="text-[12px] text-ink-faint mb-3">Each of these is the sound-key to a family — learn one and the rest become guessable.</p>
      <div className="space-y-2">
        {chars.map(c => (
          <div key={c.hanzi} className="card-face p-4 flex items-center gap-4">
            <button onClick={() => speak(c.hanzi)} className="text-center shrink-0 w-14">
              <div className="hanzi text-3xl text-ink leading-none">{c.hanzi}</div>
              <div className="text-[11px] text-jade-700 mt-1">{c.reading}</div>
            </button>
            <div className="min-w-0">
              <div className="text-[12px] text-ink-soft mb-1">
                makes <b className="text-ink">{c.unlocks.length}</b> more readable
                <span className="text-ink-faint"> · {Math.round(c.consistency * 100)}% of the family follows the rule</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.unlocks.slice(0, 8).map(u => (
                  <span key={u.hanzi} className="hanzi text-lg text-ink-soft px-1.5 py-0.5 rounded bg-jade-50/70 border border-jade-100">{u.hanzi}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Tapping a character is the SELF-TEACHING moment, so the sound is asked before it
// is given: a learner who predicts a reading and then has it confirmed acquires the
// character far faster than one who is simply told. When there is nothing to reason
// from, this degrades to the plain dictionary rather than inventing a mnemonic.
function CharPopover({ pop, onClose }) {
  const [revealed, setRevealed] = useState(false);
  const ins = pop.insight;
  const predict = ins?.predict;

  useEffect(() => { setRevealed(false); }, [pop.term]);

  return (
    <div className="lookup-pop absolute z-30 w-80 card-face p-4 shadow-lift"
      style={{ left: Math.min(pop.x, window.innerWidth - 340), top: pop.y + 6 }}>
      <div className="flex justify-between items-start mb-2">
        <span className="hanzi text-2xl text-ink">{ins?.hanzi || pop.results[0]?.simplified || pop.term}</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink text-sm">✕</button>
      </div>

      {predict && !revealed && (
        <div className="mb-3 p-3 rounded-2xl bg-jade-50/60 border border-jade-200">
          <div className="text-[12px] text-ink-soft mb-2">
            You already know {predict.evidence.map(e => e.hanzi).join('、') || predict.phonetic} — so what do you think this sounds like?
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {predict.evidence.map(e => (
              <span key={e.hanzi} className="inline-flex items-baseline gap-1 px-2 py-0.5 rounded-full bg-white border border-jade-200">
                <span className="hanzi text-[15px] text-ink">{e.hanzi}</span>
                <span className="text-[11px] text-jade-700"><TonedPinyin pinyin={e.reading} /></span>
              </span>
            ))}
          </div>
          <button onClick={() => setRevealed(true)}
            className="px-3 py-1.5 rounded-full bg-ink text-white text-[12px] font-medium hover:opacity-90 transition">
            I've got a guess — show me
          </button>
        </div>
      )}

      {predict && revealed && (
        <div className="mb-3 p-3 rounded-2xl bg-jade-50/60 border border-jade-200">
          <div className="text-[13px] text-ink mb-1">
            <span className="hanzi mr-1.5">{predict.phonetic}</span>
            says <b>{predict.predicted}</b>
            {predict.holds === true && <span className="text-jade-700"> — and it holds here ✓</span>}
            {predict.holds === false && <span className="text-ink-faint"> — but this one breaks the pattern</span>}
          </div>
          <div className="text-[11px] text-ink-faint">
            {Math.round(predict.consistency * 100)}% of this family follows it
            {ins.series?.members?.length > 0 && <> · {ins.series.members.map(m => m.hanzi).join(' ')}</>}
          </div>
        </div>
      )}

      {ins?.semantic && (
        <div className="mb-3 text-[12px] text-ink-soft">
          <span className="hanzi text-[15px] text-ink mr-1.5">{ins.semantic.radical}</span>
          means <b>{ins.semantic.sense}</b> — so this is likely something to do with that.
          {ins.semantic.family.length > 0 && (
            <span className="text-ink-faint"> Like {ins.semantic.family.map(f => f.hanzi).join('、')}.</span>
          )}
        </div>
      )}

      {pop.results.length === 0 && <p className="text-sm text-ink-faint">No dictionary entry.</p>}
      {pop.results.slice(0, 3).map((r, i) => (
        <div key={i} className="mb-2 last:mb-0">
          <div className="text-jade-600 text-sm">{r.pinyin}</div>
          <div className="text-sm text-ink-soft">{r.definitions.slice(0, 3).join('; ')}</div>
        </div>
      ))}
    </div>
  );
}

function Sentence({ s, onChar }) {
  // The characters standing between the learner and a clean read, marked so they can
  // be read PAST rather than stopped at — the whole point of a 95%-coverage text.
  const unknown = new Set(s.unknown || []);
  return (
    <div className="group">
      <p className="hanzi text-[26px] leading-[1.7] text-ink">
        {[...s.hanzi].map((ch, i) => (
          /[一-鿿]/.test(ch)
            ? <span key={i}
                className={`rounded px-[1px] cursor-pointer hover:bg-jade-100 transition-colors ${
                  unknown.has(ch) ? 'border-b border-dotted border-jade-400 text-ink-soft' : ''}`}
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
