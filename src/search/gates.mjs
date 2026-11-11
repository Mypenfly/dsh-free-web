/**
 * Serp quality gates.
 *
 * Two failure modes make keyless search unusable if taken at face value:
 *
 *  1. **Walls.** A CAPTCHA/consent/JS interstitial is a 200 response with no
 *     results, which naive code reports as "found nothing". Matching the markers
 *     turns it into an engine failure the breaker can act on.
 *  2. **Decoys.** A blocked engine may serve a *perfectly shaped* result list of
 *     unrelated rows (Bing's Microsoft-365 decoy page is the canonical case). Row
 *     count and markup prove nothing; only checking that rows actually mention the
 *     query does.
 */

/** Marker table: lowercase substring → gate reason. First match wins. */
const GATE_MARKERS = [
  [
    'captcha',
    [
      '/sorry/index',
      'unusual traffic',
      '/recaptcha/',
      'g-recaptcha',
      'h-captcha',
      'captcha-delivery',
      'are you a robot',
      'verify you are a human',
      'anomaly-modal',
      'made by a human',
      'captcha-wrap',
      'altcha',
      'verification required',
      'complete the challenge',
      '百度安全验证',
      '请输入验证码',
      'anticaptcha',
      '反爬',
      '安全验证',
    ],
  ],
  [
    'javascript',
    [
      'if you are not redirected',
      'please click here if you are not',
      'enable javascript to continue',
      'javascript is required',
    ],
  ],
  [
    'consent',
    ['consent.google.com', 'consent.bing.com', 'before you continue', 'privacy.yahoo.co.jp/areacheck'],
  ],
]

/**
 * Classify a response body as a wall, if it is one.
 * @param {string} html response body
 * @returns {string | null} gate reason (`captcha`, `javascript`, `consent`) or null
 */
export function detectGate(html) {
  const lowered = html.slice(0, 200_000).toLowerCase()
  for (const [reason, markers] of GATE_MARKERS) {
    if (markers.some((marker) => lowered.includes(marker))) return reason
  }
  return null
}

/**
 * Coherence score: the share of rows that mention a query term beyond the first
 * token (which is often the topic word every decoy also contains).
 *
 * Returns `null` when the sample is too small or the query has too few content
 * terms to judge — the caller must treat `null` as healthy, never as a decoy.
 *
 * @param {string} query user query
 * @param {Array<{ url: string, title?: string, snippet?: string }>} rows engine rows
 * @returns {number | null} 0..1, or null when undecidable
 */
export function coherenceScore(query, rows) {
  if (rows.length < 4) return null
  // Long queries judge on the terms after the first token (the topic word is what
  // a decoy echoes); short queries have no such surplus, so they judge on every
  // content term — otherwise a two-word query could never be caught.
  const residual = residualTerms(query)
  const terms = residual.length >= 2 ? residual : contentTerms(query)
  const hits = rows.filter((row) => {
    const haystack = `${row.title ?? ''} ${row.snippet ?? ''} ${row.url}`.toLowerCase()
    return terms.some((term) => haystack.includes(term))
  })
  return hits.length / rows.length
}

/**
 * Content terms of a query, excluding the first token.
 *
 * CJK runs have no spaces, so a run contributes character bigrams; Latin tokens
 * contribute themselves when longer than three characters.
 *
 * @param {string} query user query
 * @returns {string[]} lowercase terms
 */
export function residualTerms(query) {
  const tokens = query.trim().split(/\s+/).slice(1)
  const terms = []
  for (const token of tokens) {
    const cjk = [...token].filter((char) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/u.test(char))
    if (cjk.length >= 2) {
      for (let index = 0; index < cjk.length - 1; index += 1) terms.push(cjk[index] + cjk[index + 1])
    } else if (cjk.length === 1 || token.length > 3) {
      terms.push(token.toLowerCase())
    }
  }
  return [...new Set(terms)]
}

/**
 * Every content term of a query, first token included.
 * @param {string} query user query
 * @returns {string[]} lowercase terms
 */
export function contentTerms(query) {
  const terms = []
  for (const token of query.trim().split(/\s+/)) {
    const cjk = [...token].filter((char) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3]/u.test(char))
    if (cjk.length >= 2) {
      for (let index = 0; index < cjk.length - 1; index += 1) terms.push(cjk[index] + cjk[index + 1])
    } else if (cjk.length === 1 || token.length > 3) {
      terms.push(token.toLowerCase())
    }
  }
  return [...new Set(terms)]
}

/** Coherence floor below which a bucket is treated as a decoy page. */
export const DECOY_THRESHOLD = 0.3

/**
 * Decide whether one engine's rows look like a decoy.
 * @param {string} query user query
 * @param {Array<{ url: string, title?: string, snippet?: string }>} rows engine rows
 * @returns {{ decoy: false } | { decoy: true, score: number }} verdict
 */
export function isDecoy(query, rows) {
  const score = coherenceScore(query, rows)
  if (score === null) return { decoy: false }
  return score < DECOY_THRESHOLD ? { decoy: true, score } : { decoy: false }
}
