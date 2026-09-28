// wuzzy/crawl canonicalization, protocol version 1 (experimental), in plain
// Node. A line-for-line port of memetic-block/wuzzy
// apps/backend/src/canonicalize/v1/index.ts so that the content hash this
// node returns for a page is the same hash Wuzzy would attest for the same
// bytes at the same URL: a Hermes user holding our receipt can compare it with
// an independent crawl of the same page. Their VERIFY.md is the prose spec;
// their code uses linkedom (not jsdom, as the prose says) and the fixtures in
// test/fixtures are theirs, so this port is checked against their vectors.
import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

export const PROTOCOL = 'wuzzy/crawl-experimental'
export const PROTOCOL_VERSION = 1
/** Canonical markdown shorter than this is a thin page: no hash, `skipped`. */
export const MIN_CONTENT_CHARS = 80

const turndown = () => new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })

/** The normalization tail. Order is part of the protocol: NFC before the whitespace passes. */
export function normalize(markdown) {
  return markdown
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n')
}

const NEVER_CONTENT = 'script, style, template'

function stripNonContent(document) {
  for (const element of document.querySelectorAll(NEVER_CONTENT)) element.remove()
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */)
  const comments = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.remove()
}

function atUrl(document, url) {
  Object.defineProperty(document, 'documentURI', { value: url, configurable: true })
  Object.defineProperty(document, 'baseURI', { value: url, configurable: true })
}

/** Readability first; when it declines, the whole body, so a page is never reduced to nothing. */
export function extract(html, url) {
  const { document } = parseHTML(html)
  atUrl(document, url)
  const documentTitle = document.title.trim() || null
  stripNonContent(document)
  const clone = document.cloneNode(true)
  atUrl(clone, url)
  const article = new Readability(clone).parse()
  const fragment = article?.content ?? document.body.innerHTML
  return { title: article?.title?.trim() || documentTitle, markdown: turndown().turndown(fragment) }
}

/** sha256 over exact bytes, no normalization. */
export const rawHash = (source) => createHash('sha256').update(typeof source === 'string' ? Buffer.from(source, 'utf8') : source).digest('hex')
/** sha256 over canonical markdown. Only meaningful on `normalize` output. */
export const contentHash = (canonicalMarkdown) => createHash('sha256').update(canonicalMarkdown, 'utf8').digest('hex')

/**
 * @param {{source: Uint8Array|string, url: string, format?: 'html'|'markdown'}} input
 * @returns {{skipped: false, title: string|null, markdown: string, contentHash: string, rawHash: string, protocol: string, protocolVersion: number} | {skipped: true, reason: 'thin', rawHash: string}}
 */
export function canonicalize({ source, url, format = 'html' }) {
  const raw = rawHash(source)
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8').decode(source)
  const extracted = format === 'markdown' ? { title: null, markdown: text } : extract(text, url)
  const markdown = normalize(extracted.markdown)
  if (markdown.trim().length < MIN_CONTENT_CHARS) return { skipped: true, reason: 'thin', rawHash: raw }
  return { skipped: false, title: extracted.title, markdown, contentHash: contentHash(markdown), rawHash: raw, protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION }
}
