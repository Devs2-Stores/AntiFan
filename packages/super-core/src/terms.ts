// Text -> FTS5 terms for the retrieval layer.
//
// Retrieval used to quote every whitespace token as an FTS term, so attachment
// markers, bare numerals and function words all entered the expression as real
// terms. Measured on this corpus: the marker token `#1,` alone matched 1977
// claims, `[Image` matched 532, `và` 432, `bị` 65, and the AND form matched
// nothing for four real prompts — which forced the OR fallback and filled the
// candidate pool from the whole store (2695 / 2754 / 607 / 593 rows).
//
// Terms are now drawn from content words only and emitted as PREFIXES, because
// FTS matches whole tokens: the indexed token for the browser's page renderer is
// `webcontentsview`, so the plain term `webcontent` matched 0 claims while the
// prefix `"webcontent"*` matched 68.

/**
 * Closed function-word list, folded to ASCII (no diacritics, lowercase): FTS5's
 * unicode61 tokenizer removes diacritics from the index and from the query, so
 * `bị` and `bi` are one term and one entry covers both spellings.
 *
 * `đ` is the exception: it is a distinct letter (U+0111), not a marked `d`, so
 * unicode61 keeps it. `được` indexes as `đuoc` — measured, `"được"` matches 197
 * claims and `"duoc"` 6 — and the stopword for it must be spelled the same way.
 * Both spellings are listed for the words that survive the difference.
 *
 * Only words that carry no retrieval signal for a code/knowledge store are here.
 * Domain content stays, including its Vietnamese spelling: `lỗi` (error), `màu`
 * (color), `sửa` (fix), `push`, `commit`, `theme`, `cart`.
 */
export const RETRIEVAL_STOPWORDS: ReadonlySet<string> = new Set([
  // Vietnamese particles, pronouns, copulas, question words, light intent verbs.
  'ai', 'anh', 'ay', 'ban', 'bao', 'ben', 'bi', 'boi', 'cac', 'cai', 'can', 'cang',
  'chi', 'chinh', 'cho', 'chua', 'chung', 'co', 'con', 'cua', 'cung', 'da', 'đa', 'dang', 'đang',
  'day', 'đay', 'de', 'đe', 'do', 'du', 'duoc', 'đuoc', 'gi', 'giua', 'hay', 'hoac',
  'hoi', 'hon', 'khi', 'khong', 'kia', 'ko', 'la', 'lai', 'lam', 'len', 'luon', 'ma',
  'moi', 'mot', 'muon', 'nao', 'nay', 'nhe', 'nhu', 'nhung', 'nua', 'phai', 'qua', 'rang',
  'roi', 'sao', 'se', 'sau', 'tai', 'thi', 'the', 'theo', 'toi', 'trong', 'tren',
  'truoc', 'tu', 'tuy', 'va', 'vao', 'vay', 've', 'vi', 'voi', 'xem', 'xuong', 'biet',
  'uhm', 'dc', 'đi', 'di',
  // English function words.
  'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'done', 'down', 'during', 'each', 'either', 'every', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'let', 'lets', 'may', 'me', 'might', 'mine', 'more', 'most',
  'must', 'my', 'neither', 'no', 'nor', 'not', 'now', 'of', 'off', 'ok', 'okay', 'on',
  'only', 'or', 'our', 'out', 'over', 'per', 'please', 'shall', 'she', 'should', 'so',
  'some', 'still', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'up', 'us', 'very', 'via', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why',
  'will', 'with', 'would', 'yeah', 'yes', 'yet', 'you', 'your', 'yours',
]);

/** Lowercase, diacritic-free form. Matches what FTS5 unicode61 indexes. */
export const foldTerm = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

/** Bracketed attachment/annotation markers carry no words a claim can match. */
const MARKER_RE = /\[[^\]]*\]/g;
/** Punctuation FTS5 would treat as syntax, plus the edges of a pasted token. */
const EDGE_PUNCT_RE = /^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu;
const LETTER_RE = /\p{L}/u;

/**
 * Content terms of a request, in first-seen order and deduplicated by folded
 * form. Empty when the request carries no content word — which the caller must
 * read as "no term-based retrieval", never as "match everything".
 */
export function buildFtsTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text ?? '').replace(MARKER_RE, ' ').split(/\s+/)) {
    const token = raw.replace(EDGE_PUNCT_RE, '');
    // A numeral, a dimension (`1568x882`) or a lone symbol is not a word.
    if (token.length < 2 || !LETTER_RE.test(token)) continue;
    const folded = foldTerm(token);
    if (RETRIEVAL_STOPWORDS.has(folded) || seen.has(folded)) continue;
    seen.add(folded);
    terms.push(token);
  }
  return terms;
}

/** FTS5 expression over content terms, each a prefix match on a quoted token. */
export function ftsExpression(terms: string[], join: 'AND' | 'OR'): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(` ${join} `);
}

/**
 * How many of the request's content terms a statement carries. FTS matches whole
 * tokens and ranks by their rarity, so a claim matching one common token could
 * outrank the claim that matched three; retrieval sorts by this before the
 * composite score.
 */
export function contentCoverage(statement: unknown, terms: string[]): number {
  if (typeof statement !== 'string' || terms.length === 0) return 0;
  const hay = foldTerm(statement);
  let hit = 0;
  for (const term of terms) if (hay.includes(foldTerm(term))) hit += 1;
  return hit;
}
