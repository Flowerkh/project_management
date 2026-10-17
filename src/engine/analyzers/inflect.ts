// 영어 단수·복수 (Eloquent·GORM 의 테이블 이름 규칙용). Rails·jinzhu/inflection 규칙을 줄인 것.

const UNCOUNTABLE = new Set(['equipment', 'information', 'rice', 'money', 'species', 'series', 'fish', 'sheep', 'jeans', 'police', 'news', 'data', 'metadata', 'media',
  'feedback', 'staff', 'traffic', 'audio', 'software', 'hardware', 'knowledge', 'deer', 'aircraft', 'offspring', 'cattle', 'pokemon', 'chassis']);

const IRREGULAR: [string, string][] = [
  ['person', 'people'], ['man', 'men'], ['woman', 'women'], ['child', 'children'], ['sex', 'sexes'], ['move', 'moves'], ['zombie', 'zombies'], ['tooth', 'teeth'],
  ['foot', 'feet'], ['goose', 'geese'], ['ox', 'oxen'], ['criterion', 'criteria'], ['datum', 'data'], ['medium', 'media'], ['leaf', 'leaves'], ['life', 'lives'],
  ['knife', 'knives'], ['wife', 'wives'], ['half', 'halves'], ['thief', 'thieves'], ['loaf', 'loaves'], ['calf', 'calves'], ['cookie', 'cookies'], ['movie', 'movies'],
];
const IRR_PLURAL = new Map(IRREGULAR);
const IRR_SINGULAR = new Map(IRREGULAR.map(([a, b]) => [b, a] as const));

const PLURAL_RULES: [RegExp, string][] = [
  [/(quiz)$/i, '$1zes'],
  [/^(m|l)ouse$/i, '$1ice'],
  [/(matr|vert|ind)(?:ix|ex)$/i, '$1ices'],
  [/(x|ch|ss|sh|z)$/i, '$1es'],
  [/([^aeiouy]|qu)y$/i, '$1ies'],
  [/(shel|wol|sel|el|hal|cal|thie|lea|loa)f$/i, '$1ves'],
  [/(kni|wi|li)fe$/i, '$1ves'],
  [/sis$/i, 'ses'],
  [/([ti])um$/i, '$1a'],
  [/(buffal|tomat|potat|her|ech|vet)o$/i, '$1oes'],
  [/(bu)s$/i, '$1ses'],
  [/(alias|status|campus|virus|bonus|census|focus|genus|corpus|apparatus|bias|canvas)$/i, '$1es'],
  [/(octop)us$/i, '$1i'],
  [/^(ax|test)is$/i, '$1es'],
  [/s$/i, 's'],
  [/$/, 's'],
];

const SINGULAR_RULES: [RegExp, string][] = [
  [/(quiz)zes$/i, '$1'],
  [/(matr)ices$/i, '$1ix'],
  [/(vert|ind)ices$/i, '$1ex'],
  [/^(ox)en/i, '$1'],
  [/(alias|status|campus|virus|bonus|census|focus|genus|corpus|apparatus|bias|canvas)(es)?$/i, '$1'],
  [/(octop|vir)(us|i)$/i, '$1us'],
  [/^(a)x[ie]s$/i, '$1xis'],
  [/(cris|test)(is|es)$/i, '$1is'],
  [/(shoe)s$/i, '$1'],
  [/(buffal|tomat|potat|her|ech|vet)oes$/i, '$1o'],
  [/(bus)(es)?$/i, '$1'],
  [/^(m|l)ice$/i, '$1ouse'],
  [/(x|ch|ss|sh|z)es$/i, '$1'],
  [/(m)ovies$/i, '$1ovie'],
  [/(s)eries$/i, '$1eries'],
  [/([^aeiouy]|qu)ies$/i, '$1y'],
  [/(shel|wol|sel|el|hal|cal|thie|lea|loa)ves$/i, '$1f'],
  [/(kni|wi|li)ves$/i, '$1fe'],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, '$1sis'],
  [/([ti])a$/i, '$1um'],
  [/(n)ews$/i, '$1ews'],
  [/(ss|us|is)$/i, '$1'],
  [/s$/i, ''],
];

function keepCase(src: string, out: string): string {
  return src && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/** 낱말 하나의 복수형 */
export function pluralWord(word: string): string {
  const w = word.toLowerCase();
  if (!w || UNCOUNTABLE.has(w)) return word;
  const irr = IRR_PLURAL.get(w);
  if (irr) return keepCase(word, irr);
  if (IRR_SINGULAR.has(w)) return word;
  for (const [re, rep] of PLURAL_RULES) if (re.test(word)) return word.replace(re, rep);
  return word;
}

/** 낱말 하나의 단수형 */
export function singularWord(word: string): string {
  const w = word.toLowerCase();
  if (!w || UNCOUNTABLE.has(w)) return word;
  const irr = IRR_SINGULAR.get(w);
  if (irr) return keepCase(word, irr);
  if (IRR_PLURAL.has(w)) return word;
  for (const [re, rep] of SINGULAR_RULES) if (re.test(word)) return word.replace(re, rep);
  return word;
}

/** CamelCase / camelCase → snake_case */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** snake 이름의 마지막 낱말만 복수로 (order_item → order_items, bookshelf → bookshelves) */
export function pluralLast(snake: string): string {
  return snake.replace(/([^_]+)$/, (w) => pluralWord(w));
}

/** snake 이름의 마지막 낱말만 단수로 */
export function singularLast(snake: string): string {
  return snake.replace(/([^_]+)$/, (w) => singularWord(w));
}
