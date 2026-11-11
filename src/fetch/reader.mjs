/**
 * Main-content extraction: HTML in, Markdown-ish text out.
 *
 * The point is the same as trafilatura/readability: an LLM wants the article, not
 * the navigation, cookie banner, related-links rail, and footer. The host applies
 * turndown to whatever an `html` body contains, so a page returned as `text` here
 * is the only way to give the model a boilerplate-free body without changing the
 * tool's rendering rules.
 *
 * Three passes, cheapest first:
 *  1. drop non-content elements (script/style/nav/aside/footer/form/svg…);
 *  2. choose the densest container among `article` → `main` → `[role=main]` →
 *     `#content`/`.content` → `body`, scored by paragraph text;
 *  3. convert surviving blocks to Markdown (headings, lists, code, links) and
 *     collapse the blank lines that boilerplate removal leaves behind.
 */

import { decodeEntities } from '../util/html.mjs'

/** Containers that never carry the article body. */
const BOILERPLATE = /<(script|style|noscript|template|svg|iframe|canvas|form|nav|aside|footer|header|button|select|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi

/**
 * Region selectors, best first. Each pattern matches the *opening tag* of a
 * candidate container; the matching close tag is found by depth counting, because
 * the body of an `mdbook`/`Docusaurus` page nests divs several levels deep and a
 * non-greedy `</div>` would cut the article at the first inner block.
 */
/**
 * Chrome containers removed before extraction: matched on the opening tag and
 * removed with depth balancing, so a nested `div.sidebar > div` goes with its
 * parent. Attribute-based on purpose — a `<div class="related-posts">` rail must
 * go while `<div>` itself stays.
 */
const BOILERPLATE_CONTAINERS = [
  /<(?:div|section|aside|ul|ol|nav|form|table)\b[^>]*\b(?:id|class)\s*=\s*"[^"]*(?:\b(?:sidebar|site-nav|navbar|breadcrumbs?|pagination|pager|table-of-contents|toc|menu|skip-link|modal|popup|banner|cookie|consent|newsletter|subscribe|share|social|related|recommend|comments?|advert|sponsor|promo|notification|mdbook-help|searchform|search-form|toolbar|page-nav|footer|masthead|prev-next|prevnext|on-this-page|toc-container|document-toc|article-footer|tags|tag-list)\b)[^"]*"[^>]*>/gi,
]

const REGION_OPENERS = [
  /<article\b[^>]*>/gi,
  /<main\b[^>]*>/gi,
  /<[a-z]+[^>]*\brole\s*=\s*"main"[^>]*>/gi,
  /<[a-z]+[^>]*\bid\s*=\s*"content"[^>]*>/gi,
  /<[a-z]+[^>]*\bclass\s*=\s*"[^"]*\b(?:content|entry-content|post-body|article-body|markdown-body|md-content)\b[^"]*"[^>]*>/gi,
]

/**
 * Extract the readable body of an HTML document.
 *
 * @param {string} html page source
 * @returns {{ text: string, title?: string }} Markdown-ish body and document title
 */
export function extractReadable(html) {
  const title = titleOf(html)
  const withoutNoise = stripContainers(
    html.replace(/<!--[\s\S]*?-->/g, ' ').replace(BOILERPLATE, ' '),
  )
  const region = bestRegion(withoutNoise)
  const markdown = toMarkdown(region)
  return {
    text: trimNavLines(tidy(markdown)),
    ...(title === undefined ? {} : { title }),
  }
}

/**
 * Score every candidate region and keep the one with the most paragraph text.
 *
 * A page can have both `<main>` and a long `.content` sidebar; scoring beats
 * trusting the tag order, and `<body>` only wins when nothing else has text.
 *
 * @param {string} html page source without boilerplate
 * @returns {string} chosen region HTML
 */
function bestRegion(html) {
  let best = { html: bodyOf(html), score: paragraphScore(bodyOf(html)) }
  for (const opener of REGION_OPENERS) {
    for (const match of html.matchAll(opener)) {
      const inner = innerOf(html, match.index, match[0])
      if (inner === undefined || inner.length < 200) continue
      const score = paragraphScore(inner)
      if (score > best.score) best = { html: inner, score }
    }
  }
  return best.html
}

/**
 * Inner HTML of the element whose opening tag starts at `index`, found by counting
 * same-name open/close tags.
 *
 * @param {string} html document
 * @param {number} index offset of the opening tag
 * @param {string} openTag the opening tag text (e.g. `<div class="content">`)
 * @returns {string | undefined} inner HTML, or undefined when unbalanced
 */
function innerOf(html, index, openTag) {
  const tagName = /^<([a-zA-Z0-9-]+)/.exec(openTag)?.[1]
  if (tagName === undefined) return undefined
  const pattern = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi')
  pattern.lastIndex = index + openTag.length
  let depth = 1
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    if (match[1] === '/') {
      depth -= 1
      if (depth === 0) return html.slice(index + openTag.length, match.index)
    } else if (!match[0].endsWith('/>')) {
      depth += 1
    }
  }
  return undefined
}

/**
 * Remove every container matched by {@link BOILERPLATE_CONTAINERS}, outermost first.
 *
 * @param {string} html source
 * @returns {string} source without chrome containers
 */
export function stripContainers(html) {
  /** @type {Array<[number, number]>} */
  const spans = []
  for (const opener of BOILERPLATE_CONTAINERS) {
    opener.lastIndex = 0
    for (let match = opener.exec(html); match !== null; match = opener.exec(html)) {
      const end = indexAfterElement(html, match.index, match[0])
      spans.push([match.index, end ?? match.index + match[0].length])
      if (spans.length > 5000) break
    }
  }
  if (spans.length === 0) return html
  spans.sort((left, right) => left[0] - right[0])
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    if (start < cursor) {
      cursor = Math.max(cursor, end)
      continue
    }
    out += `${html.slice(cursor, start)} `
    cursor = end
  }
  return out + html.slice(cursor)
}

/**
 * Offset just past the element starting at `index`, or undefined when unbalanced.
 * @param {string} html document
 * @param {number} index offset of the opening tag
 * @param {string} openTag opening tag text
 * @returns {number | undefined} offset after the close tag
 */
function indexAfterElement(html, index, openTag) {
  const tagName = /^<([a-zA-Z0-9-]+)/.exec(openTag)?.[1]
  if (tagName === undefined) return undefined
  const pattern = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi')
  pattern.lastIndex = index + openTag.length
  let depth = 1
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    if (match[1] === '/') {
      depth -= 1
      if (depth === 0) return match.index + match[0].length
    } else if (!match[0].endsWith('/>')) {
      depth += 1
    }
  }
  return undefined
}

/** Fall back to the document body (or the whole document) when no region matched. */
function bodyOf(html) {
  return /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html
}

/**
 * Text weight of one region: paragraph and list-item characters, discounting
 * link-heavy blocks (nav rails, tag clouds) which are mostly anchors.
 *
 * @param {string} html region source
 * @returns {number} score
 */
function paragraphScore(html) {
  let score = 0
  for (const match of html.matchAll(/<(p|li|pre|blockquote|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(match[2])
    score += text.length
  }
  const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].reduce(
    (total, match) => total + stripTags(match[1]).length,
    0,
  )
  const total = stripTags(html).length
  if (total > 0 && links / total > 0.6) score *= 0.3
  return score
}

/** Title element text, with the site suffix trimmed. */
function titleOf(html) {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (raw === undefined) return undefined
  const text = stripTags(raw)
  const trimmed = text.replace(/\s+[|·—–-]\s+[^|·—–-]{2,40}$/u, '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Convert one HTML region to Markdown.
 *
 * Only the constructs that survive into an LLM answer are kept: headings, lists,
 * code blocks, quotes, links, emphasis, tables flattened to rows. Everything else
 * is text.
 *
 * @param {string} html region source
 * @returns {string} Markdown
 */
export function toMarkdown(html) {
  let out = html
  // Preserve code fences before generic tag stripping.
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, body) => {
    const language = /class\s*=\s*"[^"]*(?:language-|lang-)([\w+#-]+)/i.exec(body)?.[1] ?? ''
    const code = decodeEntities(stripTags(body)).replace(/^\n+|\n+$/g, '')
    return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`
  })
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, body) => {
    const text = inline(body)
    return text.length === 0 ? '' : `\n\n${'#'.repeat(Number(level))} ${text}\n\n`
  })
  out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, body) => {
    const text = tidy(toMarkdown(body))
    if (text.length === 0) return ''
    return `\n\n${text
      .split('\n')
      .map((line) => (line.length === 0 ? '>' : `> ${line}`))
      .join('\n')}\n\n`
  })
  out = out.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, body) => {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
        .map((cell) => inline(cell[1]).replace(/\|/g, '\\|'))
        .join(' | '),
    )
    return rows.length === 0 ? '' : `\n\n${rows.map((row) => `| ${row} |`).join('\n')}\n\n`
  })
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, body) => `\n- ${inline(body)}`)
  out = out.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n')
  out = out.replace(/<br\s*\/?>/gi, '\n')
  out = out.replace(/<(p|div|section|article|tr|dd|dt)\b[^>]*>/gi, '\n\n')
  out = out.replace(/<\/(p|div|section|article|tr|dd|dt|main)>/gi, '\n\n')
  out = inline(out)
  return out
}

/**
 * Render one inline fragment: links, emphasis, inline code, then plain text.
 * @param {string} html fragment
 * @returns {string} Markdown text
 */
function inline(html) {
  let out = html
  out = out.replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (match, href, body) => {
    const text = stripTags(body).trim()
    if (text.length === 0) return ''
    if (href.startsWith('#') || href.startsWith('javascript:')) return text
    return `[${text}](${href})`
  })
  out = out.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
  out = out.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_match, body) => {
    const text = stripTags(body).trim()
    return text.length === 0 ? '' : `*${text}*`
  })
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, body) => `\`${decodeEntities(stripTags(body)).trim()}\``)
  return decodeEntities(stripTags(out)).replace(/[ \t]+/g, ' ')
}

/** Strip remaining tags and decode entities. */
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ')
}

/**
 * Drop leading and trailing lines that are only navigation: link-dense, short, and
 * before the first heading or first real paragraph. `main` on docs sites opens with
 * "Previous / Next" rails that no attribute selector reliably marks.
 *
 * @param {string} markdown tidied body
 * @returns {string} body without the nav rails
 */
export function trimNavLines(markdown) {
  const lines = markdown.split('\n')
  const isNav = (line) => {
    const text = line.trim()
    if (text.length === 0 || text.startsWith('#')) return false
    const links = [...text.matchAll(/\[[^\]]+\]\([^)]+\)/g)]
    if (links.length === 0) return false
    const linkChars = links.reduce((total, match) => total + match[0].length, 0)
    return linkChars / text.length > 0.5 || (text.length < 120 && links.length >= 1 && linkChars > text.length * 0.4)
  }
  let start = 0
  while (start < lines.length && (lines[start].trim().length === 0 || isNav(lines[start]))) start += 1
  let end = lines.length
  while (end > start && (lines[end - 1].trim().length === 0 || isNav(lines[end - 1]))) end -= 1
  return lines.slice(start, end).join('\n')
}

/**
 * Collapse the blank-line runs and dangling spaces left by boilerplate removal.
 * @param {string} markdown converted text
 * @returns {string} tidied text
 */
export function tidy(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
