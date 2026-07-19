// Shared character-family logic so both the conversation lesson (instructional
// patterns) and the fallback exercise teach panel present ACCURATE families:
// meaning-bearing radicals only, and phonetic series only when the component
// genuinely predicts the reading.
export const firstReading = (pinyinJson) => { try { return JSON.parse(pinyinJson || '[]')[0] || ''; } catch { return ''; } };

// Meaning-bearing radicals only. Structural/stroke radicals (一, 丨…) carry no
// semantic cue, so "一 means one → 不" would mislead.
export const SEMANTIC_RADICALS = {
  '亻': 'person', '人': 'person', '氵': 'water', '水': 'water', '忄': 'heart/feeling', '心': 'heart',
  '讠': 'speech', '言': 'speech', '扌': 'hand', '手': 'hand', '口': 'mouth', '木': 'tree/wood',
  '火': 'fire', '灬': 'fire', '土': 'earth', '女': 'woman', '目': 'eye', '日': 'sun/day', '月': 'moon/flesh',
  '山': 'mountain', '足': 'foot', '钅': 'metal', '石': 'stone', '田': 'field', '艹': 'plant',
  '竹': 'bamboo', '纟': 'thread', '虫': 'insect', '鸟': 'bird', '鱼': 'fish', '马': 'horse',
  '犭': 'animal', '疒': 'illness', '饣': 'food', '衤': 'clothing', '礻': 'ritual/spirit', '贝': 'money/shell',
  '车': 'vehicle', '门': 'door', '雨': 'rain', '走': 'walk', '辶': 'movement', '力': 'strength',
  '刂': 'knife', '刀': 'knife', '宀': 'roof/home', '广': 'shelter', '页': 'head', '耳': 'ear',
};

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'z', 'c', 's', 'r', 'y', 'w'];
// Rhyme = toneless syllable minus its leading initial — what a phonetic series predicts.
export function rhyme(pinyin = '') {
  let s = String(pinyin).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  for (const init of INITIALS) if (s.startsWith(init)) { s = s.slice(init.length); break; }
  return s;
}
