/**
 * Publication-date parsing for engine snippets.
 *
 * Every engine writes dates in its own locale: Bing's RSS feed from a Chinese
 * egress answers `周二, 10 11月 2026 09:00:00 GMT`, 360 writes `2026年1月14日`, and
 * Western feeds write `Tue, 10 Nov 2026 09:00:00 GMT`. `new Date()` handles only the
 * last one, so the localized forms are normalized here.
 *
 * A parsed date is a *hint*: it comes from a snippet, so callers attach it to a
 * source but never drop a source that lacks one.
 */

/** Month names used by English and CJK feeds. */
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6, 七月: 7, 八月: 8, 九月: 9, 十月: 10,
  十一月: 11, 十二月: 12,
}

/** Earliest date accepted; anything older is boilerplate (copyright lines). */
const MIN_YEAR = 1990

/**
 * Parse one date out of free text.
 *
 * @param {string} raw text that contains a date somewhere
 * @param {{ now?: number }} [options] clock, injectable for tests
 * @returns {string | undefined} `YYYY-MM-DD`, or undefined when no usable date
 */
export function parseDate(raw, options = {}) {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length === 0) return undefined
  const now = options.now ?? Date.now()
  const candidate = isoFromNumeric(text) ?? isoFromCjk(text) ?? isoFromNamedMonth(text) ?? isoFromNative(text)
  if (candidate === undefined) return undefined
  return withinRange(candidate, now) ? candidate : undefined
}

/** `2026-11-11`, `2026/10/1`, `11/11/2026`. */
function isoFromNumeric(text) {
  const ymd = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text)
  if (ymd !== null) return format(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))
  const mdy = /(?<!\d)(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?!\d)/.exec(text)
  if (mdy !== null) return format(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]))
  return undefined
}

/** `2026年1月14日`. */
function isoFromCjk(text) {
  const chinese = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text)
  if (chinese !== null) return format(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]))
  return undefined
}

/**
 * `Tue, 10 Nov 2026 09:00:00 GMT` and its localized twin
 * `周二, 10 11月 2026 09:00:00 GMT` — both put the day before the month, but the
 * localized one writes the month as `11月` (digits plus a Han unit), so the token is
 * resolved as a name or as a number rather than matched as either.
 */
function isoFromNamedMonth(text) {
  const named = /(?<!\d)(\d{1,2})\s+([^\s,]{1,10})\s+(\d{4})(?!\d)/u.exec(text)
  if (named === null) return undefined
  const token = named[2].replace(/[.月\s]/gu, '').toLowerCase()
  const month = /^\d{1,2}$/u.test(token) ? Number(token) : MONTHS[token]
  if (month === undefined) return undefined
  return format(Number(named[3]), month, Number(named[1]))
}

/** Last resort: whatever `Date` itself understands. */
function isoFromNative(text) {
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString().slice(0, 10)
}

/** Build `YYYY-MM-DD`, rejecting impossible calendar values. */
function format(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined
  return date.toISOString().slice(0, 10)
}

/** Reject implausible dates (from a copyright year to a far-future typo). */
function withinRange(iso, now) {
  const year = Number(iso.slice(0, 4))
  if (year < MIN_YEAR) return false
  const limit = now + 24 * 60 * 60 * 1000
  return Date.parse(iso) <= limit
}
