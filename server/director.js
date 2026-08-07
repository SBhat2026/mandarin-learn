// The Conversation Director — the missing bridge between educational objectives
// and natural dialogue. It turns a capability-keyed plan (WHAT) + the personal
// profile (WHO) into a hidden CONVERSATION BLUEPRINT (the HOW-plan): how to open
// from a personal hook, which objectives to weave in only when natural, the tone,
// the question ladder, framed excursions, budget, and how to wrap up naturally.
//
// Claude never talks to the learner; it only plans. Qwen (the executor) speaks the
// blueprint. The blueprint is built once per conversation and cached on the session.
//
// ── Blueprint schema (validated by validateBlueprint) ──────────────────────
//   conversationGoal      : string   one plain-language aim ("chat about nature")
//   openingStrategy       : string   how to start from a PERSONAL hook
//   personalConnections[] : string   specific hooks Laoshi may use
//   educationalOpportunities[] : {objective, vocab[], pattern, priority}  (hidden)
//   reviewOpportunities[] : string   due items to resurface if the talk allows
//   tone                  : string   relaxed | curious | encouraging | ...
//   questionLadder[]      : string   ordered target question types (Workstream G)
//   steeringSuggestions[] : string   gentle pivots if the learner stalls
//   excursions[]          : {kind, enterLine, exitBridge}  framed activities
//   budget                : {newConcepts, reviewTargets, exchanges:[min,max], learnerInitiatedQuestions}
//   exitStrategy          : string   how to wrap up naturally
//   desiredLearnerFeeling : string   "I had an interesting conversation"
import { hasApiKey, completeJson, claudeModelPref, resolveModel } from './anthropic.js';
import { profileForPrompt, recentThreads } from './profile.js';
import { getSetting } from './db.js';

// The canonical question hierarchy (Workstream G). The Director orders a subset
// into questionLadder; higher rungs are preferred as capability mastery rises.
export const QUESTION_RUNGS = ['recognition', 'recall', 'personal_experience', 'comparison', 'explanation', 'creation'];

const DESIGN_PRINCIPLES = `You are the invisible Conversation Director for a Mandarin teacher named Laoshi.
You do NOT talk to the learner. You produce a hidden plan that Laoshi (a separate model) will perform.
Design principles you MUST encode into the plan:
- NEVER announce a lesson, topic, objective, or "new word". The learner must feel they are continuing a relationship, not starting a lesson.
- Establish a PERSONAL connection FIRST, using a real fact/thread about the learner, before any educational steering.
- NEVER fabricate personal history. If there is no real profile fact/thread, DO NOT invent one (no "did you go to…", "how was your trip…", "last time you…"). For a cold-start / low-data learner, open from a CONCRETE, GROUNDED micro-scene in the here-and-now — warm and system-led, honest, not a fake memory.
- Educational objectives stay HIDDEN — vocabulary is woven in only when the conversation naturally needs it, never presented as the subject.
- Optimize for the desiredLearnerFeeling: "I had an interesting conversation," not "I finished a lesson."
- Keep it achievable in a short chat; wrap up warmly and naturally when the goals are met or momentum fades.`;

// Build the blueprint. Dispatches to Claude (full) or a deterministic local path
// (offline). One call per conversation; cache the result on the session.
export async function buildBlueprint(plan, ctx = {}) {
  if (hasApiKey()) {
    try { return validateBlueprint(await buildBlueprintClaude(plan, ctx), plan); }
    catch { /* fall back to local so a conversation always has a plan */ }
  }
  return validateBlueprint(buildBlueprintLocal(plan, ctx), plan);
}

async function buildBlueprintClaude(plan, ctx) {
  const profile = ctx.profileDigest ?? profileForPrompt();
  const threads = recentThreads(3).map(t => t.value);
  const cap = plan.capability;
  const rungs = ladderForMastery(ctx.capabilityMastery ?? 0);
  const payload = {
    capability: cap ? { name: cap.name, cefr: cap.cefr } : null,
    hiddenObjectives: plan.objectives || [],
    focalWord: plan.focal ? `${plan.focal.hanzi} (${plan.focal.pinyin}) = ${plan.focal.gloss}` : null,
    supportingVocab: (plan.targetVocab || []).map(v => v.hanzi),
    dueReview: (plan.reviewVocab || []).map(v => v.hanzi),
    learnerProfile: profile || '(no profile yet — this may be an early session)',
    openThreads: threads,
    scriptLevel: plan.scriptLevel,
    recentMetrics: ctx.metrics || null,
    preferredQuestionRungs: rungs,
    // Visible learner control: topics they explicitly asked to talk about today.
    requestedTopics: getSetting('chat_topics', []) || [],
  };
  const tier = ctx.modelPref || claudeModelPref();
  const out = await completeJson({
    // DESIGN_PRINCIPLES is invariant across every conversation → cache it; only the
    // per-conversation schema+payload instruction varies.
    system: {
      static: DESIGN_PRINCIPLES,
      dynamic: `Given the capability to develop, the hidden objectives, the learner's profile, and their recent conversational behavior, output a Conversation Blueprint as strict JSON with EXACTLY these keys:
{
 "conversationGoal": string,
 "openingStrategy": string,            // how Laoshi opens from a PERSONAL hook (reference a profile fact/thread if any)
 "personalConnections": string[],      // specific hooks Laoshi may use
 "educationalOpportunities": [{"objective":string,"vocab":string[],"pattern":string|null,"priority":number}],
 "reviewOpportunities": string[],
 "tone": string,
 "questionLadder": string[],           // ordered subset of: ${QUESTION_RUNGS.join(', ')}
 "steeringSuggestions": string[],
 "excursions": [{"kind":"reading"|"tone_drill"|"rep_burst"|"shadowing","enterLine":string,"exitBridge":string}],
 "microNarration": {"use":boolean,"seed":string},   // OPTIONAL rare device: a tiny 1–2 sentence vignette Laoshi may narrate ONCE if it fits; keep it in comprehensible input. use=false most of the time.
 "scene": string|null,                 // optional light real-world scene giving production a purpose (e.g. "ordering at a noodle shop")
 "budget": {"newConcepts":number,"reviewTargets":number,"exchanges":[number,number],"learnerInitiatedQuestions":number},
 "exitStrategy": string,
 "desiredLearnerFeeling": string
}
openingStrategy and personalConnections MUST reference the learner's real profile when one exists, and never open with "what do you want to talk about?". Keep excursions optional (0–1 here). microNarration.use should be true only occasionally. Output ONLY the JSON.`,
    },
    tier,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    max_tokens: 900,
  });
  out._engine = 'claude';
  out._model = resolveModel(tier);
  console.log(`[director] blueprint via ${out._model} (${tier})`);
  return out;
}

// OFFLINE-MODE: deterministic blueprint. Fills the SAME schema from templates +
// profile + plan, with no cloud call. Coherent but simpler than the Claude plan.
// TODO(offline): richen with a local Qwen planning pass (see docs/offline-mode.md).
export function buildBlueprintLocal(plan, ctx = {}) {
  const profile = ctx.profileDigest ?? profileForPrompt();
  const threads = recentThreads(3).map(t => t.value);
  const cap = plan.capability;
  const goal = cap ? goalPhrase(cap) : 'have a relaxed chat and reuse familiar words';
  const rungs = ladderForMastery(ctx.capabilityMastery ?? 0);

  // Personal hooks: an explicitly-requested topic wins, then an open thread, then a
  // stated interest, then the scene.
  const requested = (getSetting('chat_topics', []) || [])[0] || null;
  const interest = firstInterest(profile);
  const connections = [];
  if (requested) connections.push(`they asked to talk about ${requested} today — honor that`);
  if (threads[0]) connections.push(`follow up on: ${threads[0]}`);
  if (interest) connections.push(`they enjoy ${interest} — open there`);
  const opening = requested
    ? `They chose to talk about ${requested} today — open there directly with a warm, concrete question.`
    : threads[0]
      ? `Pick up the open thread naturally — ask how "${threads[0]}" is going.`
      : interest
        ? `Open by connecting to something they like (${interest}) and ask a warm question about it.`
        : `No real profile facts exist yet, so DO NOT invent any personal history or past events. Open from a concrete, grounded thing in the here-and-now (something simple and everyday) and ask one easy question about it. Never fabricate a memory, and never open with a generic "so, what shall we discuss?" prompt.`;

  return {
    conversationGoal: goal,
    openingStrategy: opening,
    personalConnections: connections.length ? connections : ['everyday life, kept light and personal'],
    educationalOpportunities: (plan.objectives || []).map(o => ({
      objective: o.objective, vocab: o.vocab || [], pattern: o.pattern || null, priority: o.priority ?? 1 })),
    reviewOpportunities: (plan.reviewVocab || []).map(v => v.hanzi),
    tone: interest ? 'warm and curious' : 'relaxed and encouraging',
    questionLadder: rungs,
    steeringSuggestions: [
      'if they stall, offer a simple either/or question',
      interest ? `pivot toward ${interest} if energy dips` : 'pivot to a concrete, everyday detail if energy dips',
    ],
    excursions: [],   // offline path keeps it to pure conversation
    microNarration: microNarrationSeed(plan),
    scene: sceneFor(cap),
    budget: { newConcepts: 1, reviewTargets: Math.min(2, (plan.reviewVocab || []).length), exchanges: [4, 8], learnerInitiatedQuestions: 1 },
    exitStrategy: 'When it has run its course, warmly hand them a thought for next time and close without a formal ending.',
    desiredLearnerFeeling: 'I had an interesting little conversation with someone who knows me.',
    _engine: 'local',
  };
}

// Higher capability mastery → prefer higher rungs of the question hierarchy.
function ladderForMastery(mastery = 0) {
  const start = mastery >= 0.7 ? 2 : mastery >= 0.4 ? 1 : 0;
  return QUESTION_RUNGS.slice(start, start + 4);
}

function goalPhrase(cap) {
  const map = {
    describe_a_living_thing: 'chat about animals or plants they find interesting',
    describe_the_weather: 'chat about the weather and what they like to do in it',
    talk_about_family: 'chat about family and the people close to them',
    order_food: 'chat about food they like and eating out',
    talk_about_hobbies: 'chat about how they spend their free time',
    describe_a_trip: 'chat about a place they went or want to go',
  };
  return map[cap.slug] || `have a natural chat where "${cap.name}" comes up on its own`;
}

function firstInterest(digest) {
  if (!digest) return null;
  const m = digest.match(/Enjoys — ([^.]+)\./);
  return m ? m[1].split(',')[0].trim() : null;
}

// Mini-narration (used SPARINGLY): a tiny 1–2 sentence vignette Laoshi may narrate
// once, built from the focal word, to give comprehensible input in story form.
// Offline we enable it only for the more descriptive/narrative capabilities so it
// stays rare; the executor further limits it to a single use per conversation.
function microNarrationSeed(plan) {
  const cap = plan.capability;
  const focal = plan.focal;
  const narrativeish = cap && (cap.ordering ?? 0) >= 2 && focal?.hanzi;
  if (!narrativeish) return { use: false, seed: '' };
  return { use: true, seed: `a very short, concrete everyday moment involving ${focal.hanzi} (${focal.gloss || ''})`.trim() };
}

// A light real-world scene that gives production a purpose, when the capability
// suggests one. Kept situational, never a quiz.
function sceneFor(cap) {
  if (!cap) return null;
  const map = {
    order_food: 'ordering something to eat at a small restaurant',
    describe_the_weather: 'chatting about today\'s weather before heading out',
    ask_where_something_is: 'asking a passer-by where something is',
    describe_a_trip: 'swapping stories about a place you went',
  };
  return map[cap.slug] || null;
}

// Validate + coerce a blueprint to the schema so downstream code (Qwen executor,
// completion logic) can trust its shape. Fills sane defaults for missing keys.
export function validateBlueprint(bp, plan = {}) {
  const b = bp && typeof bp === 'object' ? bp : {};
  const arr = (x) => Array.isArray(x) ? x : [];
  const budget = b.budget && typeof b.budget === 'object' ? b.budget : {};
  const ex = Array.isArray(budget.exchanges) && budget.exchanges.length === 2 ? budget.exchanges.map(Number) : [4, 8];
  return {
    conversationGoal: String(b.conversationGoal || 'have a relaxed, personal chat'),
    openingStrategy: String(b.openingStrategy || 'Open warmly and personally; never announce a lesson.'),
    personalConnections: arr(b.personalConnections).map(String).slice(0, 6),
    educationalOpportunities: arr(b.educationalOpportunities).map(o => ({
      objective: String(o?.objective || ''), vocab: arr(o?.vocab).map(String),
      pattern: o?.pattern ?? null, priority: Number(o?.priority ?? 1) })).filter(o => o.objective),
    reviewOpportunities: arr(b.reviewOpportunities).map(String).slice(0, 8),
    tone: String(b.tone || 'relaxed and encouraging'),
    questionLadder: arr(b.questionLadder).filter(r => QUESTION_RUNGS.includes(r)).slice(0, 5),
    steeringSuggestions: arr(b.steeringSuggestions).map(String).slice(0, 5),
    excursions: arr(b.excursions).map(e => ({
      kind: ['reading', 'tone_drill', 'rep_burst', 'shadowing'].includes(e?.kind) ? e.kind : 'rep_burst',
      enterLine: String(e?.enterLine || ''), exitBridge: String(e?.exitBridge || '') }))
      .filter(e => e.enterLine).slice(0, 2),
    microNarration: (() => {
      const m = b.microNarration && typeof b.microNarration === 'object' ? b.microNarration : {};
      return { use: Boolean(m.use), seed: String(m.seed || '') };
    })(),
    scene: b.scene ? String(b.scene) : null,
    budget: {
      newConcepts: Number(budget.newConcepts ?? 1),
      reviewTargets: Number(budget.reviewTargets ?? 2),
      exchanges: [Math.max(2, ex[0] || 4), Math.max(ex[0] || 4, ex[1] || 8)],
      learnerInitiatedQuestions: Number(budget.learnerInitiatedQuestions ?? 1),
    },
    exitStrategy: String(b.exitStrategy || 'Wrap up warmly with a thought for next time; no formal ending.'),
    desiredLearnerFeeling: String(b.desiredLearnerFeeling || 'I had an interesting conversation.'),
    questionLadderFallback: QUESTION_RUNGS,
    _engine: b._engine || 'local',
  };
}
