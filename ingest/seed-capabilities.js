// Seed the capability catalog — the top planning unit. A capability is an
// expressive thing the learner can DO ("describe a living thing"); vocabulary and
// grammar patterns are the means, resolved at plan time (not hard-coded ids).
//
// The deterministic CATALOG below always works with no API key. An optional
// Claude-assisted enrichment step proposes extra requirements from the imported
// word/pattern pool and caches them, so reruns are free and offline-safe.
//
//   node ingest/seed-capabilities.js            # seed (idempotent)
//   node ingest/seed-capabilities.js --enrich   # + Claude requirement enrichment
import 'dotenv/config';
import { db, initSchema } from '../server/db.js';
import { hasApiKey, completeJson } from '../server/anthropic.js';

// Requirement refs are resolvable tokens, never raw word ids:
//   "pos:a"        → words whose POS role includes a (adjective)
//   "topic:nature" → words tagged with the topic
//   "word:好"      → a specific literal (used sparingly for function words)
//   pattern refs are grammar pattern_tags (aspirational until sentences carry them)
export const CATALOG = [
  // ---- Survival (A0/A1): the first things you can do at all -----------------
  { slug: 'greet_someone', name: 'greet someone', cefr: 'A0', order: 1, prereq: [],
    reqs: [['vocab', 'topic:greetings', 2], ['vocab', 'pos:r', 1]] },
  { slug: 'introduce_self', name: 'introduce yourself', cefr: 'A1', order: 2, prereq: ['greet_someone'],
    reqs: [['vocab', 'topic:greetings', 1], ['vocab', 'pos:r', 1.5], ['pattern', 'shi-identity', 1]] },
  { slug: 'say_yes_no', name: 'say yes and no', cefr: 'A0', order: 3, prereq: [],
    reqs: [['vocab', 'word:是', 1], ['vocab', 'word:不', 1], ['vocab', 'word:对', 1]] },
  { slug: 'count_and_number', name: 'count and use numbers', cefr: 'A1', order: 4, prereq: [],
    reqs: [['vocab', 'topic:numbers', 2], ['vocab', 'pos:q', 1]] },
  { slug: 'tell_time', name: 'tell and ask the time', cefr: 'A1', order: 5, prereq: ['count_and_number'],
    reqs: [['vocab', 'topic:time', 2], ['vocab', 'topic:numbers', 1]] },
  { slug: 'express_thanks', name: 'thank and respond politely', cefr: 'A0', order: 6, prereq: ['greet_someone'],
    reqs: [['vocab', 'topic:greetings', 2]] },
  { slug: 'ask_someones_name', name: 'ask what something is called', cefr: 'A1', order: 7, prereq: ['introduce_self'],
    reqs: [['vocab', 'pos:r', 1.5], ['pattern', 'shenme-question', 1]] },
  { slug: 'talk_about_family', name: 'talk about your family', cefr: 'A1', order: 8, prereq: ['introduce_self'],
    reqs: [['vocab', 'topic:family', 3], ['vocab', 'word:有', 1], ['pattern', 'you-possession', 1]] },
  { slug: 'express_like_dislike', name: 'say what you like and dislike', cefr: 'A1', order: 9, prereq: ['say_yes_no'],
    reqs: [['vocab', 'word:喜欢', 1.5], ['vocab', 'pos:v', 1], ['vocab', 'topic:hobbies', 1]] },
  { slug: 'order_food', name: 'order food and drink', cefr: 'A2', order: 10, prereq: ['count_and_number', 'express_like_dislike'],
    reqs: [['vocab', 'topic:food', 3], ['vocab', 'topic:drink', 1], ['vocab', 'word:要', 1], ['pattern', 'yao-want', 1]] },
  { slug: 'ask_price', name: 'ask how much something costs', cefr: 'A2', order: 11, prereq: ['count_and_number'],
    reqs: [['vocab', 'topic:money', 2], ['vocab', 'topic:shopping', 1], ['pattern', 'duoshao-question', 1]] },
  { slug: 'ask_where_something_is', name: 'ask where something is', cefr: 'A2', order: 12, prereq: ['ask_someones_name'],
    reqs: [['vocab', 'topic:places', 2], ['vocab', 'word:在', 1], ['pattern', 'zai-location', 1.5]] },

  // ---- Descriptive (A2): give things qualities ------------------------------
  { slug: 'describe_a_person', name: 'describe a person', cefr: 'A2', order: 20, prereq: ['talk_about_family'],
    reqs: [['vocab', 'pos:a', 2], ['vocab', 'topic:body', 1], ['pattern', 'de-attributive', 1.5]] },
  { slug: 'describe_a_living_thing', name: 'describe a living thing', cefr: 'A2', order: 21, prereq: ['describe_a_person'],
    reqs: [['vocab', 'pos:a', 2], ['vocab', 'topic:animals', 2], ['vocab', 'topic:nature', 1], ['pattern', 'de-attributive', 1.5]] },
  { slug: 'describe_color_and_object', name: 'describe an object and its color', cefr: 'A2', order: 22, prereq: ['count_and_number'],
    reqs: [['vocab', 'topic:colors', 2], ['vocab', 'pos:a', 1], ['vocab', 'pos:n', 1]] },
  { slug: 'describe_clothing', name: 'describe what someone is wearing', cefr: 'A2', order: 23, prereq: ['describe_color_and_object'],
    reqs: [['vocab', 'topic:clothing', 3], ['vocab', 'topic:colors', 1], ['vocab', 'word:穿', 1]] },
  { slug: 'describe_the_weather', name: 'talk about the weather', cefr: 'A2', order: 24, prereq: ['express_like_dislike'],
    reqs: [['vocab', 'topic:weather', 3], ['vocab', 'pos:a', 1]] },
  { slug: 'describe_feelings', name: 'say how you feel', cefr: 'A2', order: 25, prereq: ['express_like_dislike'],
    reqs: [['vocab', 'topic:feelings', 3], ['vocab', 'word:很', 1], ['pattern', 'hen-degree', 1]] },
  { slug: 'describe_a_place', name: 'describe a place', cefr: 'A2', order: 26, prereq: ['ask_where_something_is', 'describe_color_and_object'],
    reqs: [['vocab', 'topic:places', 2], ['vocab', 'pos:a', 1], ['pattern', 'you-existence', 1]] },
  { slug: 'talk_about_daily_routine', name: 'describe your daily routine', cefr: 'A2', order: 27, prereq: ['tell_time'],
    reqs: [['vocab', 'pos:v', 2], ['vocab', 'topic:time', 1], ['pattern', 'time-sequence', 1]] },
  { slug: 'compare_two_things', name: 'compare two things', cefr: 'A2', order: 28, prereq: ['describe_color_and_object'],
    reqs: [['vocab', 'pos:a', 2], ['vocab', 'word:比', 1.5], ['pattern', 'comparison-bi', 2]] },

  // ---- Narrative (A2/B1): put actions in time -------------------------------
  { slug: 'talk_about_past_action', name: 'talk about something you did', cefr: 'B1', order: 30, prereq: ['talk_about_daily_routine'],
    reqs: [['vocab', 'pos:v', 2], ['vocab', 'word:了', 1.5], ['pattern', 'le-completion', 2]] },
  { slug: 'talk_about_future_plan', name: 'talk about your plans', cefr: 'B1', order: 31, prereq: ['talk_about_daily_routine'],
    reqs: [['vocab', 'pos:v', 2], ['vocab', 'word:要', 1], ['vocab', 'word:想', 1], ['pattern', 'yao-future', 1.5]] },
  { slug: 'describe_a_trip', name: 'describe a trip or outing', cefr: 'B1', order: 32, prereq: ['talk_about_past_action', 'ask_where_something_is'],
    reqs: [['vocab', 'topic:travel', 2], ['vocab', 'topic:transport', 2], ['vocab', 'pos:v', 1]] },
  { slug: 'tell_a_short_story', name: 'tell a short story in sequence', cefr: 'B1', order: 33, prereq: ['talk_about_past_action'],
    reqs: [['vocab', 'pos:v', 2], ['pattern', 'time-sequence', 1.5], ['pattern', 'le-completion', 1]] },

  // ---- Opinion / abstract (B1): reason and evaluate -------------------------
  { slug: 'give_an_opinion', name: 'give a simple opinion', cefr: 'B1', order: 40, prereq: ['express_like_dislike', 'describe_feelings'],
    reqs: [['vocab', 'word:觉得', 1.5], ['vocab', 'pos:a', 1], ['pattern', 'juede-opinion', 1.5]] },
  { slug: 'explain_a_reason', name: 'explain a reason', cefr: 'B1', order: 41, prereq: ['give_an_opinion'],
    reqs: [['vocab', 'word:因为', 1.5], ['vocab', 'word:所以', 1], ['pattern', 'because-so', 2]] },
  { slug: 'make_a_suggestion', name: 'suggest doing something together', cefr: 'B1', order: 42, prereq: ['talk_about_future_plan'],
    reqs: [['vocab', 'word:一起', 1], ['vocab', 'word:吧', 1], ['pattern', 'ba-suggestion', 1.5]] },
  { slug: 'agree_or_disagree', name: 'agree or disagree', cefr: 'B1', order: 43, prereq: ['give_an_opinion'],
    reqs: [['vocab', 'word:同意', 1], ['vocab', 'word:觉得', 1], ['pattern', 'juede-opinion', 1]] },
  { slug: 'talk_about_hobbies', name: 'talk about your hobbies in detail', cefr: 'B1', order: 44, prereq: ['express_like_dislike', 'talk_about_daily_routine'],
    reqs: [['vocab', 'topic:hobbies', 3], ['vocab', 'topic:sports', 1], ['vocab', 'pos:v', 1]] },
  { slug: 'talk_about_health', name: 'talk about how you feel physically', cefr: 'B1', order: 45, prereq: ['describe_feelings', 'talk_about_family'],
    reqs: [['vocab', 'topic:health', 3], ['vocab', 'topic:body', 1], ['pattern', 'hen-degree', 1]] },
  { slug: 'talk_about_work_or_school', name: 'talk about your work or study', cefr: 'B1', order: 46, prereq: ['talk_about_daily_routine'],
    reqs: [['vocab', 'topic:work', 2], ['vocab', 'topic:school', 2], ['vocab', 'pos:v', 1]] },
  { slug: 'talk_about_technology', name: 'talk about phones and technology', cefr: 'B1', order: 47, prereq: ['talk_about_daily_routine'],
    reqs: [['vocab', 'topic:technology', 3], ['vocab', 'pos:v', 1]] },
];

export function seedCatalog() {
  const d = db();
  const upCap = d.prepare(`INSERT INTO capabilities(slug,name,description,cefr_ish,ordering,prerequisites_json)
    VALUES(@slug,@name,@description,@cefr_ish,@ordering,@prerequisites_json)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description,
      cefr_ish=excluded.cefr_ish, ordering=excluded.ordering, prerequisites_json=excluded.prerequisites_json`);
  const getId = d.prepare('SELECT id FROM capabilities WHERE slug=?');
  const clearReq = d.prepare('DELETE FROM capability_requirements WHERE capability_id=?');
  const insReq = d.prepare('INSERT INTO capability_requirements(capability_id,kind,ref,weight) VALUES(?,?,?,?)');

  const tx = d.transaction(() => {
    for (const c of CATALOG) {
      upCap.run({ slug: c.slug, name: c.name, description: c.description || c.name,
        cefr_ish: c.cefr, ordering: c.order, prerequisites_json: JSON.stringify(c.prereq || []) });
      const id = getId.get(c.slug).id;
      clearReq.run(id);                                   // requirements are declarative → replace
      for (const [kind, ref, weight] of c.reqs) insReq.run(id, kind, ref, weight ?? 1);
    }
  });
  tx();
  return CATALOG.length;
}

// Optional Claude enrichment: propose a couple of extra requirement refs per
// capability from the actual imported pool. Cached in learner_model so reruns are
// free; deterministic catalog stands alone with no key.
async function enrich() {
  if (!hasApiKey()) { console.log('· no API key — skipping enrichment (deterministic catalog stands alone)'); return 0; }
  const d = db();
  const topics = [...new Set(d.prepare('SELECT topics FROM words WHERE topics IS NOT NULL').all()
    .flatMap(r => { try { return JSON.parse(r.topics); } catch { return []; } }))];
  let added = 0;
  for (const c of CATALOG) {
    const cacheKey = `cap_enrich:${c.slug}`;
    const cached = d.prepare('SELECT value FROM learner_model WHERE key=?').get(cacheKey);
    let extra = cached ? safeJson(cached.value) : null;
    if (!extra) {
      try {
        extra = await completeJson({
          system: 'You design a Mandarin capability curriculum. Given a capability and the available topic tags, propose up to 3 additional requirement refs that help a learner express it. Use only refs of the form "topic:<tag>" (from the provided list) or "pos:<code>" where code ∈ n,v,a,d,r,m,q,t (noun,verb,adjective,adverb,pronoun,numeral,classifier,time). Output JSON {reqs:[{kind:"vocab",ref,weight}]}.',
          messages: [{ role: 'user', content: `Capability: ${c.name} (${c.slug}). Available topics: ${topics.join(', ')}.` }],
          max_tokens: 300,
        });
        d.prepare('INSERT OR REPLACE INTO learner_model(key,value,updated) VALUES(?,?,datetime(\'now\'))')
          .run(cacheKey, JSON.stringify(extra));
      } catch { extra = null; }
    }
    const id = d.prepare('SELECT id FROM capabilities WHERE slug=?').get(c.slug)?.id;
    if (!id || !extra?.reqs) continue;
    const ins = d.prepare('INSERT INTO capability_requirements(capability_id,kind,ref,weight) VALUES(?,?,?,?)');
    const seen = new Set(d.prepare('SELECT ref FROM capability_requirements WHERE capability_id=?').all(id).map(r => r.ref));
    for (const r of extra.reqs.slice(0, 3)) {
      if (!r?.ref || seen.has(r.ref)) continue;
      if (!/^(topic:|pos:|word:)/.test(r.ref)) continue;   // guard the resolver's contract
      ins.run(id, 'vocab', r.ref, r.weight ?? 0.8); seen.add(r.ref); added++;
    }
  }
  return added;
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  initSchema();
  const n = seedCatalog();
  console.log(`✓ seeded ${n} capabilities`);
  if (process.argv.includes('--enrich')) {
    const added = await enrich();
    console.log(`✓ enrichment added ${added} requirement refs`);
  }
  process.exit(0);
}
