/**
 * Dependency-free HTML helpers: entity decoding, tag stripping, and
 * class-scoped element extraction.
 *
 * Every keyless search engine responds with a full page; the only thing we need
 * from it is a handful of blocks. A full DOM parser is not available in the host
 * runtime (no domino/linkedom), so extraction is regex-based and deliberately
 * narrow: each engine names the container class or tag pattern it expects, and
 * the helpers below turn that into text.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
}

/**
 * Decode HTML entities (`&amp;`, `&#39;`, `&#x27;`) in one pass.
 *
 * @param {string} input raw HTML text
 * @returns {string} decoded text
 */
export function decodeEntities(input) {
  if (!input.includes('&')) return input
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X'
      const value = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return match
      try {
        return String.fromCodePoint(value)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()]
    return named === undefined ? match : named
  })
}

/** Remove `script`, `style`, `noscript`, and comment nodes; their text is never content. */
export function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

/**
 * Collapse one HTML fragment to plain text.
 *
 * Block-level boundaries become spaces (not newlines): engine snippets are
 * single-line by contract, and newlines inside them would break the tool's
 * `- [title](url) — snippet` rendering.
 *
 * @param {string} html fragment
 * @returns {string} whitespace-collapsed text
 */
export function htmlToText(html) {
  const text = stripNonContent(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * Extract the inner HTML of every element whose `class` attribute contains one of
 * the given tokens.
 *
 * The closing-tag match is non-recursive (`</tag>` first occurrence), which is
 * exact for the leaf containers engines use (`<div class="result">`, `<li>`), and
 * an acceptable approximation for wrapper divs. Callers that need nested blocks
 * (e.g. Bing's `b_algo` list items) use a tag-scoped variant instead.
 *
 * @param {string} html page source
 * @param {string[]} classTokens class substrings, tried in order
 * @param {string} [tag] restrict the opening tag (`div`, `li`, `article`)
 * @returns {string[]} inner HTML of each match, in document order
 */
export function elementsByClass(html, classTokens, tag = '[a-z0-9]+') {
  for (const token of classTokens) {
    const pattern = new RegExp(
      `<(${tag})\\b[^>]*\\bclass\\s*=\\s*"[^"]*${escapeRegExp(token)}[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
      'gi',
    )
    const found = [...html.matchAll(pattern)].map((m) => m[2])
    if (found.length > 0) return found
  }
  return []
}

/** Escape one literal string for use inside a `RegExp` source. */
export function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read the first attribute value from an opening tag inside a fragment.
 *
 * @param {string} html fragment
 * @param {string} attribute attribute name (case-insensitive)
 * @returns {string | undefined} the raw (undecoded) value
 */
export function firstAttribute(html, attribute) {
  const match = html.match(new RegExp(`\\b${escapeRegExp(attribute)}\\s*=\\s*"([^"]*)"`, 'i'))
  return match?.[1]
}

/**
 * First `href` in one fragment, skipping `javascript:`, `#`, and the given hosts.
 *
 * @param {string} html fragment
 * @param {RegExp} [skip] host pattern to reject
 * @returns {string | undefined} absolute or site-relative href
 */
export function firstHref(html, skip) {
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)) {
    const href = decodeEntities(match[1]).trim()
    if (href.length === 0 || href.startsWith('#') || href.startsWith('javascript:')) continue
    if (skip !== undefined && skip.test(href)) continue
    return href
  }
  return undefined
}
