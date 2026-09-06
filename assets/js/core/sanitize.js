// HTML sanitizer.
//
// Supplier descriptions are untrusted input that gets rendered in the preview
// panes, so this runs before anything reaches the DOM.
//
// The approach is rebuild-from-scratch rather than scrub-in-place: the source is
// parsed in an inert document, then a brand new tree is constructed containing
// only allowlisted elements and allowlisted, re-validated attributes. Nothing
// from the original serialization survives, which closes the mutation-XSS
// avenues that in-place scrubbing has to defend against one by one.
//
// Namespaced content (SVG, MathML) is dropped outright rather than filtered.
// The tools have no use for it, and it is the source of most parser-confusion
// tricks.

const ALLOWED_TAGS = new Set([
  // text
  'P', 'BR', 'HR', 'SPAN', 'DIV', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SUB', 'SUP',
  'SMALL', 'MARK', 'CODE', 'PRE', 'BLOCKQUOTE', 'Q', 'CITE', 'ABBR', 'TIME',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  // structure
  'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'FIGURE',
  'FIGCAPTION', 'ADDRESS', 'DETAILS', 'SUMMARY', 'HGROUP', 'DL', 'DT', 'DD',
  'UL', 'OL', 'LI',
  // tables
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL',
  // media and links
  'A', 'IMG', 'VIDEO', 'SOURCE', 'TRACK',
]);

// Attributes allowed on any element.
const GLOBAL_ATTRS = new Set(['class', 'dir', 'lang', 'title', 'style']);

// Attributes allowed only on specific elements.
const TAG_ATTRS = {
  A: new Set(['href', 'target', 'rel']),
  IMG: new Set(['src', 'alt', 'width', 'height', 'loading', 'srcset', 'sizes']),
  VIDEO: new Set(['src', 'poster', 'controls', 'width', 'height', 'muted', 'loop', 'playsinline']),
  SOURCE: new Set(['src', 'srcset', 'type', 'media', 'sizes']),
  TRACK: new Set(['src', 'kind', 'srclang', 'label', 'default']),
  TH: new Set(['colspan', 'rowspan', 'scope', 'headers', 'abbr']),
  TD: new Set(['colspan', 'rowspan', 'headers']),
  COL: new Set(['span']),
  COLGROUP: new Set(['span']),
  OL: new Set(['start', 'reversed', 'type']),
  TIME: new Set(['datetime']),
  ABBR: new Set(['title']),
  Q: new Set(['cite']),
  BLOCKQUOTE: new Set(['cite']),
};

// Attributes whose value is a URL and must be protocol-checked.
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite', 'srcset']);

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'data:']);

// Only images may use data: URIs, and only real image types.
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;

/**
 * Browsers ignore control characters, whitespace and zero-width or bidi marks
 * inside a URL. They have to be removed before the protocol is read, or
 * "java<TAB>script:alert(1)" looks like a harmless relative path.
 *
 * Written as a code-point filter rather than a regex so the ranges stay
 * readable and the source file holds no literal control bytes.
 */
function stripUrlNoise(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code <= 0x20) continue;                       // C0 controls and space
    if (code >= 0x7f && code <= 0xa0) continue;       // DEL, C1 controls, NBSP
    if (code >= 0x200b && code <= 0x200f) continue;   // zero-width, LTR/RTL marks
    if (code === 0x2028 || code === 0x2029) continue; // line/paragraph separators
    if (code >= 0x202a && code <= 0x202e) continue;   // bidi embedding/overrides
    if (code === 0x2060 || code === 0xfeff) continue; // word joiner, BOM
    out += ch;
  }
  return out;
}

function isSafeUrl(value, tag, attr) {
  const cleaned = stripUrlNoise(value);
  if (!cleaned) return false;

  // Protocol-relative and relative URLs are fine.
  if (/^[/#?]/.test(cleaned)) return true;

  // No colon before the first slash means a relative path.
  const colon = cleaned.indexOf(':');
  if (colon === -1) return true;
  const slash = cleaned.indexOf('/');
  if (slash !== -1 && slash < colon) return true;

  const protocol = cleaned.slice(0, colon + 1).toLowerCase();
  if (!SAFE_PROTOCOLS.has(protocol)) return false;

  if (protocol === 'data:') {
    return (tag === 'IMG' || tag === 'SOURCE') && attr !== 'srcset' && SAFE_DATA_IMAGE.test(cleaned);
  }
  return true;
}

// Inline styles are kept because suppliers use them for table alignment, but
// anything that can fetch or execute is removed.
const STYLE_BANNED = /(expression|javascript:|vbscript:|url\s*\(|@import|behavior|-moz-binding|position\s*:\s*fixed)/i;

function cleanStyle(value) {
  const text = String(value);
  if (STYLE_BANNED.test(text)) return null;
  if (text.length > 400) return null;
  return text;
}

function isAllowedAttr(tag, name) {
  if (name.startsWith('on')) return false;          // no event handlers, ever
  if (name.startsWith('data-')) return false;       // no use for them here
  if (name === 'is') return false;                  // customised built-ins
  if (GLOBAL_ATTRS.has(name)) return true;
  return Boolean(TAG_ATTRS[tag]?.has(name));
}

function copyInto(source, target, doc) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(doc.createTextNode(node.data));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    // Only HTML-namespace elements are considered at all.
    if (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;

    const tag = node.tagName.toUpperCase();

    if (!ALLOWED_TAGS.has(tag)) {
      // Drop the element but keep readable children, except where the content
      // is itself script or styling text.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
          tag === 'TEMPLATE' || tag === 'IFRAME' || tag === 'OBJECT' ||
          tag === 'EMBED' || tag === 'TITLE' || tag === 'HEAD') {
        continue;
      }
      copyInto(node, target, doc);
      continue;
    }

    const clean = doc.createElement(tag);

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (!isAllowedAttr(tag, name)) continue;

      let value = attr.value;

      if (URL_ATTRS.has(name)) {
        if (name === 'srcset') {
          // Every candidate in the list has to pass on its own.
          const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
          const ok = parts.length > 0 && parts.every((part) => isSafeUrl(part.split(/\s+/)[0], tag, 'src'));
          if (!ok) continue;
        } else if (!isSafeUrl(value, tag, name)) {
          continue;
        }
      }

      if (name === 'style') {
        const style = cleanStyle(value);
        if (style === null) continue;
        value = style;
      }

      if (name === 'target') value = '_blank';

      try { clean.setAttribute(name, value); } catch { /* invalid name */ }
    }

    // Links that open a new tab must not hand over window.opener.
    if (tag === 'A' && clean.getAttribute('target') === '_blank') {
      clean.setAttribute('rel', 'noopener noreferrer');
    }

    copyInto(node, clean, doc);
    target.append(clean);
  }
}

/**
 * Sanitize an HTML string. Returns HTML that is safe to assign to innerHTML.
 */
export function sanitize(html) {
  if (!html) return '';

  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');

  copyInto(parsed.body, root, doc);
  return root.innerHTML;
}

/** Sanitize and return a live fragment, for direct insertion. */
export function sanitizeToFragment(html) {
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');

  copyInto(parsed.body, root, doc);

  const fragment = document.createDocumentFragment();
  for (const node of Array.from(root.childNodes)) {
    fragment.append(document.importNode(node, true));
  }
  return fragment;
}

/** Replace an element's contents with sanitized HTML. */
export function setSanitizedHTML(element, html) {
  element.replaceChildren(sanitizeToFragment(html));
}
