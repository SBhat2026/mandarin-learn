// Diagnostic probes for a driven session.
//
// These are deliberately written as INDEPENDENT ORACLES rather than as mirrors of
// the implementation. A probe that calls `vocabguard.validateTurn` to check that
// `vocabguard` produced a valid turn proves nothing — it agrees with itself by
// construction. So decodability recomputes its own allowed set, and the semantic
// check carries its own hand-checked noun→category ground truth for the words that
// have actually broken before (太阳 "how many suns do you have?", 高中 "how many
// senior high schools do you have?").
//
// Every probe returns {ok, severity, detail, evidence[]}. `severity` is 'fail' for a
// broken promise the app makes to the learner and 'warn' for a quality smell.

const CJK = /[一-鿿]/;
const chars = (s) => [...String(s || '')].filter(c => CJK.test(c));

// The function words a guided turn may always use — the frames are built from these
// plus the session's own nouns. Kept here, separate from vocabguard's CORE_RUNG0, so
// a bug that widens the real whitelist shows up as a decodability failure instead of
// being silently blessed.
const CORE = new Set([...'我你他她它们的了吗呢吧很也都和是有在去吃喝看想喜欢什么今天不个几这那里子',
  ...'一二三四五六七八九十', ...'。，？！、']);

// ── Ground truth for the semantic probe ─────────────────────────────────────
// Hand-checked, not derived from the app's own nounCategory(). Anything not listed
// falls back to the app's classifier, so this narrows over time as it is extended.
const TRUTH = {
  太阳: 'nature', 月亮: 'nature', 天: 'nature', 天气: 'nature', 雨: 'nature', 云: 'nature', 风: 'nature',
  山: 'nature', 海: 'nature', 河: 'nature', 水: 'drink',
  高中: 'place', 学校: 'place', 大学: 'place', 家: 'place', 中国: 'place', 北京: 'place',
  商店: 'place', 医院: 'place', 公园: 'place', 城市: 'place', 房间: 'place', 饭馆: 'place',
  猫: 'creature', 狗: 'creature', 鱼: 'creature', 鸟: 'creature', 马: 'creature', 猪: 'creature',
  老师: 'person', 学生: 'person', 朋友: 'person', 妈妈: 'person', 爸爸: 'person', 孩子: 'person',
  米饭: 'food', 面包: 'food', 苹果: 'food', 鸡蛋: 'food', 菜: 'food', 肉: 'food', 面条: 'food',
  茶: 'drink', 咖啡: 'drink', 牛奶: 'drink', 酒: 'drink',
  书: 'object', 桌子: 'object', 椅子: 'object', 车: 'object', 手机: 'object', 电脑: 'object', 笔: 'object',
  头: 'body', 手: 'body', 眼睛: 'body', 脚: 'body',
};
// Which categories each pattern may legitimately apply to.
//
// `count` is specifically counting with 个 — 一个水 is wrong (it wants 一杯水) and
// 几个太阳 is nonsense. Bare 有 is a SEPARATE and much wider thing: 我有水 ("I have
// water") is ordinary Chinese, and folding it into the counting pattern made this
// probe flag good sentences.
const PATTERN_FITS = {
  count:  ['object', 'creature', 'person', 'food', 'plant'],    // 几个X / 一个X / 两个X
  own:    ['object', 'creature', 'person', 'food', 'drink', 'plant', 'place'],  // 有X
  go:     ['place'],                                            // 去X / 在X
  eat:    ['food'],                                             // 吃X
  drink:  ['drink'],                                            // 喝X
};

export function categoryOf(noun, fallback) {
  return TRUTH[noun] || (fallback ? fallback(noun) : null);
}

// ── Probes ──────────────────────────────────────────────────────────────────

// A blank teacher bubble is the single worst failure mode this app has had: the
// learner is left staring at nothing with no way forward. (Caused historically by a
// reasoning model answering into `reasoning`, and by Ollama's 4096 num_ctx silently
// truncating the executor prompt.)
export function blankTurns({ turns }) {
  const bad = turns.filter(t => !String(t.reply?.hanzi || '').trim());
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: `${bad.length}/${turns.length} turns had no Chinese in them`,
    evidence: bad.slice(0, 3).map(t => `turn ${t.i}: ${JSON.stringify(t.reply).slice(0, 120)}`),
  };
}

// Every reply must carry pinyin and English — the learner leans on both, and a turn
// missing either is unreadable at the guided rungs.
export function grounding({ turns }) {
  const bad = turns.filter(t => t.reply?.hanzi && (!String(t.reply.pinyin || '').trim() || !String(t.reply.english || '').trim()));
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: `${bad.length}/${turns.length} turns missing pinyin or English`,
    evidence: bad.slice(0, 3).map(t => `turn ${t.i}: "${t.reply.hanzi}" py="${t.reply.pinyin}" en="${t.reply.english}"`),
  };
}

// At the guided rungs the whole promise is that nothing on screen is opaque. A
// character earns its place one of two ways: the learner already has it (known set
// or core function words), or the turn SHIPS its grounding — a per-word token
// carrying pinyin and a gloss, which is what the interlinear renders.
//
// Checking membership alone would be wrong (the teacher's fixed lines legitimately
// use words outside the whitelist) and checking nothing would be worse. So this
// probe asks the honest question: could the learner read it, one way or the other?
export function decodability({ turns, rung, knownHanzi = new Set() }) {
  if (rung >= 2) return { ok: true, severity: 'warn', detail: 'free rung — decodability is not promised', evidence: [], skipped: true };
  const allowed = new Set([...CORE, ...knownHanzi]);
  const violations = [];
  for (const t of turns) {
    for (const w of t.introduced || []) for (const c of chars(w)) allowed.add(c);
    // Characters the turn grounds itself, from every token strip it ships.
    const grounded = new Set();
    for (const tok of t.groundedTokens || []) {
      if (!tok.pinyin || !String(tok.gloss || '').trim()) continue;    // an empty gloss grounds nothing
      for (const c of chars(tok.hanzi)) grounded.add(c);
    }
    for (const c of chars(t.reply?.hanzi)) {
      if (!allowed.has(c) && !grounded.has(c)) violations.push(`turn ${t.i}: ${c} in "${t.reply.hanzi}" — neither known nor grounded`);
    }
  }
  return {
    ok: violations.length === 0, severity: 'fail',
    detail: violations.length ? `${violations.length} characters shown that the learner cannot read`
      : 'every character was either known or grounded word-by-word',
    evidence: violations.slice(0, 6),
  };
}

// The "how many suns do you have?" class of bug: a frame applied to a noun it makes
// no sense for. Surface-matched against hand-checked categories.
export function semanticSanity({ turns, classify }) {
  const bad = [];
  for (const t of turns) {
    const h = String(t.reply?.hanzi || '');
    for (const [noun, truth] of Object.entries(TRUTH)) {
      if (!h.includes(noun)) continue;
      const hit = (pat, re) => { if (re.test(h) && !PATTERN_FITS[pat].includes(truth)) bad.push(`turn ${t.i}: ${pat} applied to ${noun} (${truth}) — "${h}"`); };
      hit('count', new RegExp(`(几个|一个|两个)\\s*${noun}`));
      hit('own',   new RegExp(`有\\s*${noun}`));
      hit('go',    new RegExp(`(去|在)\\s*${noun}`));
      hit('eat',   new RegExp(`吃\\s*${noun}`));
      hit('drink', new RegExp(`喝\\s*${noun}`));
    }
    // Nouns outside the ground truth fall back to the app's own classifier — weaker,
    // but it still catches a frame fired at a category it declared it does not fit.
    if (classify) {
      for (const w of t.sessionNouns || []) {
        if (TRUTH[w]) continue;
        const cat = classify(w);
        if (!cat) continue;
        if (new RegExp(`(几个|一个|两个)\\s*${w}`).test(h) && !PATTERN_FITS.count.includes(cat))
          bad.push(`turn ${t.i}: counted ${w} (${cat}) — "${h}"`);
      }
    }
  }
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: bad.length ? `${bad.length} semantically wrong frames` : 'no frame applied to a noun it does not fit',
    evidence: bad.slice(0, 5),
  };
}

// A session that never ends is the bug the arc was built to fix. It must reach a
// wrap on its own, without the harness forcing one.
export function arcCompletion({ turns, ceiling = 18 }) {
  const wrapped = turns.findIndex(t => t.reply?.shouldWrap);
  const beats = [...new Set(turns.map(t => t.reply?.beat).filter(Boolean))];
  return {
    ok: wrapped >= 0 && wrapped < ceiling, severity: 'fail',
    detail: wrapped >= 0 ? `ended itself at turn ${wrapped + 1} after beats [${beats.join('→')}]`
      : `never ended in ${turns.length} turns (beats seen: ${beats.join('→') || 'none'})`,
    evidence: [],
  };
}

// The `grow` beat: a session must travel, introducing a word it did not open with.
// Without this a conversation grinds the same two nouns through every template.
export function midSessionGrowth({ turns }) {
  const opening = new Set(turns[0]?.introduced || []);
  const later = new Set();
  for (const t of turns.slice(1)) for (const w of t.introduced || []) if (!opening.has(w)) later.add(w);
  return {
    ok: later.size > 0, severity: 'warn',
    detail: later.size ? `grew ${later.size} new word(s) mid-session: ${[...later].join(' ')}`
      : `never introduced a word beyond the opening set (${[...opening].join(' ') || 'none'})`,
    evidence: [],
  };
}

// Fixation: the session must not be about one noun. Measured as the share of turns
// mentioning the single most-used session word.
export function fixation({ turns }) {
  const counts = new Map();
  const nouns = new Set(turns.flatMap(t => t.sessionNouns || []));
  for (const n of nouns) counts.set(n, turns.filter(t => String(t.reply?.hanzi || '').includes(n)).length);
  if (!counts.size) return { ok: true, severity: 'warn', detail: 'no session nouns to measure', evidence: [], skipped: true };
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = n / turns.length;
  return {
    ok: share <= 0.75, severity: 'warn',
    detail: `most-used word ${top} appeared in ${n}/${turns.length} turns (${Math.round(share * 100)}%)`,
    evidence: [...counts.entries()].map(([k, v]) => `${k}:${v}`),
  };
}

// The teacher must not say the same sentence twice in a row (and rarely at all).
export function repetition({ turns }) {
  const seen = new Map();
  const dupes = [], consecutive = [];
  let prev = '';
  for (const t of turns) {
    const h = String(t.reply?.hanzi || '');
    if (!h) continue;
    if (h === prev) consecutive.push(`turn ${t.i}: repeated "${h}"`);
    seen.set(h, (seen.get(h) || 0) + 1);
    prev = h;
  }
  for (const [h, n] of seen) if (n > 2) dupes.push(`"${h}" ×${n}`);
  return {
    ok: consecutive.length === 0 && dupes.length === 0, severity: consecutive.length ? 'fail' : 'warn',
    detail: consecutive.length ? `${consecutive.length} back-to-back repeats`
      : dupes.length ? `${dupes.length} sentence(s) said more than twice` : 'no repeated sentences',
    evidence: [...consecutive, ...dupes].slice(0, 5),
  };
}

// Never-strand: after the learner signals confusion, the reply must both re-ground
// (break something down / slow down) AND still hand back a next move. "I don't
// know" or a dead end is the failure.
export function neverStrand({ turns }) {
  const after = turns.filter(t => t.wasConfusion);
  if (!after.length) return { ok: true, severity: 'warn', detail: 'no confusion turn was injected', evidence: [], skipped: true };
  const bad = after.filter(t => {
    const r = t.reply || {};
    const hasMove = !!(r.choices?.length || /[？?]/.test(r.hanzi || '') || r.invite || r.tokens?.length);
    return !r.hanzi || !hasMove;
  });
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: bad.length ? `${bad.length}/${after.length} confusion turns left the learner with no next move`
      : `all ${after.length} confusion turns re-grounded and offered a way forward`,
    evidence: bad.slice(0, 3).map(t => `turn ${t.i}: "${t.reply?.hanzi}"`),
  };
}

// Latency is a pedagogy problem, not just an engineering one: a teacher that takes
// three minutes to answer is a teacher the learner walks away from.
export function latency({ turns, budgetMs = 8000 }) {
  const ms = turns.map(t => t.ms).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ms.length) return { ok: true, severity: 'warn', detail: 'no timings', evidence: [], skipped: true };
  const p50 = ms[Math.floor(ms.length * 0.5)], worst = ms[ms.length - 1];
  return {
    ok: worst <= budgetMs, severity: 'warn',
    detail: `p50 ${p50}ms · worst ${worst}ms (budget ${budgetMs}ms)`,
    evidence: worst > budgetMs ? [`slowest turn ${worst}ms`] : [],
  };
}

// The rung the level actually lands on. A mismatch means the ladder is mis-reading
// the learner — an advanced user stuck on frames, or a beginner thrown into free chat.
export function rungAssignment({ rung, expectedRung }) {
  return {
    ok: expectedRung == null || rung === expectedRung, severity: 'fail',
    detail: `rung ${rung}${expectedRung != null ? ` (expected ${expectedRung})` : ''}`,
    evidence: [],
  };
}

// ── Reading probes ──────────────────────────────────────────────────────────

export function coverageSane({ reading, expectBand }) {
  const p = reading?.profile;
  if (!p) return { ok: false, severity: 'fail', detail: 'no reading profile', evidence: [] };
  const ok = expectBand ? p.band === expectBand : true;
  return {
    ok, severity: 'warn',
    detail: `${p.charactersMet} chars met · ${Math.round(p.estimatedCoverage * 100)}% coverage · ${p.band}${expectBand ? ` (expected ${expectBand})` : ''}`,
    evidence: [],
  };
}

// The promise the Read track makes: at most one unmet character per sentence, and
// the passage as a whole above the 90% floor.
export function passageSanity({ reading }) {
  const ps = reading?.passages || [];
  if (!ps.length) return { ok: true, severity: 'warn', detail: 'no passages available at this level', evidence: [], skipped: true };
  const bad = [];
  for (const p of ps) {
    if (p.coverage < 0.9) bad.push(`passage ${p.index}: ${Math.round(p.coverage * 100)}% below the 90% floor`);
    for (const s of p.sentences) if ((s.unknown || []).length > 1) bad.push(`passage ${p.index}: "${s.hanzi}" has ${s.unknown.length} unmet chars`);
  }
  const bands = ps.map(p => p.band);
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: bad.length ? `${bad.length} passage violations` : `${ps.length} passages, bands [${bands.join(', ')}]`,
    evidence: bad.slice(0, 5),
  };
}

// Passages must CLIMB — a track that only ever serves 100%-known sentences never
// teaches a character from context.
export function passageClimb({ reading }) {
  const ps = reading?.passages || [];
  if (ps.length < 2) return { ok: true, severity: 'warn', detail: 'too few passages to judge', evidence: [], skipped: true };
  const stretch = ps.filter(p => p.sentences.some(s => (s.unknown || []).length > 0));
  return {
    ok: stretch.length > 0, severity: 'warn',
    detail: stretch.length ? `${stretch.length}/${ps.length} passages contain a new character`
      : 'every passage is fully known — nothing new is ever met in context',
    evidence: [],
  };
}

// A high-yield key must be trustworthy (consistency ≥0.6), unmet, and actually
// unlock something.
export function highYieldSanity({ reading }) {
  const hy = reading?.profile?.highYield || [];
  if (!hy.length) return { ok: true, severity: 'warn', detail: 'no high-yield keys proposed', evidence: [], skipped: true };
  const bad = hy.filter(h => h.consistency < 0.6 || !h.unlocks?.length);
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: bad.length ? `${bad.length} untrustworthy keys proposed`
      : `${hy.length} keys, best ${hy[0].hanzi}→${hy[0].unlocks.length} unlocks @ ${Math.round(hy[0].consistency * 100)}%`,
    evidence: bad.slice(0, 3).map(h => `${h.hanzi} consistency=${h.consistency}`),
  };
}

// Self-teaching is only honest when the learner has evidence. A prediction offered
// with nothing met is the app telling them they "already know" something they don't.
export function selfTeachHonesty({ reading }) {
  const probes = reading?.insights || [];
  const bad = probes.filter(p => p.predict && !(p.predict.evidence?.length || p.knownPhonetic));
  return {
    ok: bad.length === 0, severity: 'fail',
    detail: bad.length ? `${bad.length} predictions offered with no evidence to reason from`
      : `${probes.filter(p => p.predict).length}/${probes.length} tapped characters offered a justified prediction`,
    evidence: bad.slice(0, 3).map(p => p.hanzi),
  };
}

// No turn may offer a tap-to-answer chip. The whole point of removing them is that a
// learner could otherwise finish a session by recognition alone, so this is checked
// at every level rather than trusted to the knobs.
export function noChoices({ turns }) {
  const offending = turns.filter(t => (t.reply?.choices || []).length > 0);
  return {
    ok: offending.length === 0, severity: 'fail',
    detail: offending.length ? `${offending.length} turns offered tap-to-answer choices`
      : 'no turn answered for the learner',
    evidence: offending.slice(0, 3).map(t => `turn ${t.i}: ${(t.reply.choices || []).map(c => c.hanzi).join(' / ')}`),
  };
}

// Removing the chips is only safe if the learner is never stuck: at the guided rungs
// a model sentence must be available to ask for, and it must be readable.
export function modelAnswerAvailable({ turns, rung }) {
  if (rung >= 2) return { ok: true, severity: 'warn', detail: 'free rung — no model sentence by design', evidence: [], skipped: true };
  const asking = turns.filter(t => !t.reply?.shouldWrap);
  const missing = asking.filter(t => !t.reply?.modelAnswer?.hanzi);
  const unreadable = asking.filter(t => t.reply?.modelAnswer?.hanzi && !t.reply.modelAnswer.pinyin);
  return {
    ok: missing.length === 0 && unreadable.length === 0, severity: 'fail',
    detail: missing.length ? `${missing.length}/${asking.length} turns left no way to see one right answer`
      : unreadable.length ? `${unreadable.length} model sentences had no pinyin`
      : `every turn offered a readable model sentence on request`,
    evidence: [...missing, ...unreadable].slice(0, 3).map(t => `turn ${t.i}`),
  };
}

// The deliberate errors the scripted learner makes MUST come back corrected — and
// nothing correct may be "corrected". Both halves matter equally.
export function correction({ turns }) {
  const planted = turns.filter(t => t.plantedError);
  const missed = planted.filter(t => !t.reply?.correction);
  const spurious = turns.filter(t => t.knownGood && t.reply?.correction);
  const ok = missed.length === 0 && spurious.length === 0;
  return {
    ok, severity: 'fail',
    detail: !planted.length ? 'no errors were planted at this level'
      : missed.length ? `${missed.length}/${planted.length} planted errors went uncorrected`
      : spurious.length ? `${spurious.length} correct sentences were "corrected"`
      : `all ${planted.length} planted errors corrected, no false positives`,
    evidence: [
      ...missed.map(t => `turn ${t.i}: "${t.userText}" not corrected`),
      ...spurious.map(t => `turn ${t.i}: "${t.userText}" wrongly corrected to ${t.reply.correction.contrast?.to}`),
    ].slice(0, 4),
    skipped: !planted.length,
  };
}

// Strictness must actually RISE. Toneless pinyin is a fine beginner answer and an
// advanced learner avoiding the work; if both are treated the same, the ladder is
// decorative.
export function strictnessRises({ turns, level }) {
  const toneless = turns.filter(t => t.tonelessProbe);
  if (!toneless.length) return { ok: true, severity: 'warn', detail: 'no toneless probe at this level', evidence: [], skipped: true };
  const corrected = toneless.filter(t => t.reply?.correction);
  const shouldCorrect = level.id >= 2;                 // firm/exacting bands
  const ok = shouldCorrect ? corrected.length > 0 : corrected.length === 0;
  return {
    ok, severity: 'fail',
    detail: shouldCorrect
      ? (ok ? 'toneless pinyin is corrected at this level' : 'toneless pinyin passed unchallenged at an advanced level')
      : (ok ? 'toneless pinyin accepted, as it should be for a beginner' : 'a beginner was corrected for typing without tones'),
    evidence: toneless.slice(0, 2).map(t => `turn ${t.i}: "${t.userText}" → ${t.reply?.correction ? 'corrected' : 'accepted'}`),
  };
}

// A conversation is an exchange, not a broadcast. The guided rungs used to emit pure
// statements — "这是屋。" "我有电脑。" — five turns in a row, nothing asked, nothing
// picked up from the learner. This checks that most turns actually invite a reply and
// that the teacher refers back to what the learner said.
export function invitesResponse({ turns }) {
  // The closing beats are exempt: a recombination win and a goodbye are supposed to
  // land, not interrogate. Everything in the conversational middle must ask.
  const CLOSERS = new Set(['win', 'farewell']);
  const speaking = turns.filter(t => t.reply?.hanzi && !t.reply?.shouldWrap && !CLOSERS.has(t.reply?.beat));
  if (!speaking.length) return { ok: true, severity: 'warn', detail: 'no turns', evidence: [], skipped: true };
  const asks = speaking.filter(t => /[？?]/.test(t.reply.hanzi) || /吗|呢|什么|几|谁|哪|怎么样|为什么/.test(t.reply.hanzi));
  const ratio = asks.length / speaking.length;
  return {
    ok: ratio >= 0.6, severity: 'fail',
    detail: `${asks.length}/${speaking.length} turns invited a reply (${Math.round(ratio * 100)}%)`,
    evidence: speaking.filter(t => !asks.includes(t)).slice(0, 3).map(t => `turn ${t.i}: "${t.reply.hanzi}" — states, asks nothing`),
  };
}

// Does the teacher pick up what the learner actually said? Without this the turns can
// all end in a question and still be a script being read at someone.
export function picksUpLearner({ turns }) {
  const pairs = turns.filter(t => t.userText && !t.wasConfusion && t.reply?.hanzi);
  if (!pairs.length) return { ok: true, severity: 'warn', detail: 'no learner turns', evidence: [], skipped: true };
  const echoed = pairs.filter(t => {
    const said = [...String(t.userText)].filter(c => /[一-鿿]/.test(c));
    return said.length && said.some(ch => t.reply.hanzi.includes(ch));
  });
  const ratio = echoed.length / pairs.length;
  return {
    ok: ratio >= 0.3, severity: 'warn',
    detail: `${echoed.length}/${pairs.length} replies reused something the learner said (${Math.round(ratio * 100)}%)`,
    evidence: [],
  };
}

// Every session should be aimed at something the learner can see.
export function hasGoal({ turns, rung }) {
  if (rung >= 2) return { ok: true, severity: 'warn', detail: 'free rung — no stated aim', evidence: [], skipped: true };
  const withGoal = turns.filter(t => t.reply?.goal?.en);
  return {
    ok: withGoal.length > 0, severity: 'fail',
    detail: withGoal.length ? `session aim: "${withGoal[0].reply.goal.en}"` : 'no session aim was offered',
    evidence: [],
  };
}

export const CONVERSATION_PROBES = [
  ['invites-response', invitesResponse], ['picks-up-learner', picksUpLearner], ['has-goal', hasGoal],
  ['no-choices', noChoices], ['model-answer', modelAnswerAvailable],
  ['correction', correction], ['strictness', strictnessRises],
  ['blank-turns', blankTurns], ['grounding', grounding], ['decodability', decodability],
  ['semantic-sanity', semanticSanity], ['arc-completion', arcCompletion],
  ['mid-session-growth', midSessionGrowth], ['fixation', fixation], ['repetition', repetition],
  ['never-strand', neverStrand], ['latency', latency], ['rung-assignment', rungAssignment],
];

export const READING_PROBES = [
  ['coverage', coverageSane], ['passage-sanity', passageSanity], ['passage-climb', passageClimb],
  ['high-yield', highYieldSanity], ['self-teach-honesty', selfTeachHonesty],
];
