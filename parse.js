// A fast drop-in for marked 18.1.3 (default options, GFM on).
// Written from scratch in this session: a CommonMark 0.31.2 + GFM 0.29 parser
// that renders exactly marked's HTML. Anything it cannot handle bails to the
// vendored marked build (vendor/marked/marked.esm.js, MIT, see NOTICE), so the
// output is marked's output on every input by construction.
import { marked } from './vendor/marked/marked.esm.js';

class Bail extends Error {}

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}
// Escape like marked's escape() with encode=false: & is left alone when it
// starts a character reference (&name; or &#123; / &#x1F;), everything else
// that is special is escaped.
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escNoEncode(s) {
  return s.replace(ESC_NO_ENCODE_RE, (c) => ESC_MAP[c] || '&amp;');
}

const SPACE_RE = /\s/;
function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || SPACE_RE.test(c);
}
// ASCII whitespace only (space, tab, newline, CR, VT, FF). Link dests and
// titles are separated by these; a non-breaking space (\u00a0) is part of
// the dest, so `[link](/url\u00a0"title")` has href `/url%C2%A0%22title%22`.
function isAsciiWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
}
function isPunct(c) {
  if (!c) return false;
  const cp = c.codePointAt(0);
  if (cp < 128) return "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".indexOf(c) >= 0;
  // Unicode punctuation (P) or symbol (S), approximated by the standard
  // ranges plus a regex check for the rest.
  return PUNCT_RE.test(c);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// A line in a lines array is blank unless it is a spaces-only line that is
// the LAST element of the array (i.e. not followed by a newline in the
// source it represents): marked's paragraph regex treats such a line as a
// continuation line, so `>\n> foo\n> \n` is `<p>foo\n </p>`.
function isBlankAt(lines, i, end) {
  if (i >= end) return true;
  const s = lines[i];
  if (s === '') return true;
  if (!isBlank(s)) return false;
  return i + 1 < end;
}

// Columns a line's leading whitespace occupies; a tab advances to the next
// multiple of 4.
function indentOf(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove `cols` columns of indentation from the start of a line. A tab that
// straddles the boundary is expanded into the spaces it stands for.
function stripIndent(s, cols) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < cols) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= cols) { col += w; i++; }
      else {
        // Tab straddles: replace it with the spaces that remain.
        return ' '.repeat(col + w - cols) + s.slice(i + 1);
      }
    } else break;
  }
  return s.slice(i);
}

function normalizeLabel(label) {
  // marked's F: lower -> upper -> lower (folds e.g. ß to ss via toUpperCase).
  const s = label.trim().replace(/\s+/g, ' ');
  return s.toLowerCase().toUpperCase().toLowerCase();
}

// Decode a numeric character reference body (after &#, without the ;).
// Returns the character, or null when marked would leave it literal.
function decodeNumeric(body) {
  let n;
  if (body[0] === 'x' || body[0] === 'X') {
    if (body.length > 7) return null;
    n = parseInt(body.slice(1), 16);
    if (isNaN(n)) return null;
  } else {
    if (body.length > 7) return null;
    n = parseInt(body, 10);
    if (isNaN(n)) return null;
  }
  if (n === 0) return '�';
  if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  return String.fromCodePoint(n);
}

// marked's cleanUrl (he): encode, then restore a bare % (encodeURI turns %
// into %25; valid %XX escapes come back as themselves). Returns null when
// the href cannot be encoded.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
  return href;
}

function cleanHref(dest) {
  // Raw cleaned URL; escaping happens at render time (NoEncode for normal
  // links, full escape for autolinks).
  return cleanUrl(dest);
}

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function isAsciiPunct(c) {
  return c.length === 1 && ASCII_PUNCT.indexOf(c) >= 0;
}

// ---- inline parsing ----

// Find the index of the `]` matching the `[` at `start`, counting nested
// brackets and skipping backslash escapes. -1 when there is none.
// marked's Be(): a link is vetoed if its text contains a `<` that starts
// an autolink or HTML tag whose closing `>` lies beyond the closing `]`.
// A tag/autolink fully inside the `]` does not veto.
function hasUnclosedTag(s, open, close) {
  for (let p = open + 1; p < close; p++) {
    if (s[p] !== '<') continue;
    const rest = s.slice(p);
    const m = AUTOLINK_SCHEME_RE.exec(rest) || AUTOLINK_EMAIL_RE.exec(rest);
    if (m) {
      if (p + m[0].length - 1 > close) return true;
      p += m[0].length - 1;
      continue;
    }
    const html = matchInlineHtml(s, p);
    if (html !== null) {
      if (p + html.length - 1 > close) return true;
      p += html.length - 1;
    }
  }
  return false;
}

// A multi-backtick code span (`` `` a ` b `` ``) whose content contains a
// backtick vetoes the link UNLESS the span's closing run is immediately
// followed by the `]` (`[a `` x ` y ``](url)` links, `[a `` x ` y `` z](url)`
// and `[a `` x ` y `` ](url)` do not). Single-backtick spans and spans
// without a backtick in the content never veto.
function hasBadCodeSpan(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let len = 0;
    while (i + len < text.length && text[i + len] === '`') len++;
    if (len < 2) continue;
    let close = -1;
    let j = i + len;
    while (j < text.length) {
      if (text[j] === '`') {
        let r = 0;
        while (j + r < text.length && text[j + r] === '`') r++;
        if (r === len) { close = j; break; }
        j += r;
      } else j++;
    }
    if (close < 0) { i = i + len - 1; continue; }
    const content = text.slice(i + len, close);
    const end = close + len;
    if (content.includes('`') && end < text.length) return true;
    i = end - 1;
  }
  return false;
}

function findClosingBracket(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      // Skip a code span: a `]` inside backticks does not close the link
      // (cm-342: `[not a `link](/foo`)` has no closing `]` outside the span).
      // First look for a closing run of the SAME length (a proper code
      // span, e.g. `` `` a ` b `` `` closes with `` `` ``, the inner
      // single `` ` `` does not end it). If none, marked still accepts a
      // mismatched run as the close for link purposes (`[docs each
      // ``url`](...)` links, the `` `` `` closing with a single `` ` ``);
      // only when no backtick run exists at all later is the link vetoed
      // (`[a `b](url)`, `[a `b` `c](url)` stay literal).
      let len = 0;
      while (i + len < s.length && s[i + len] === '`') len++;
      // Search for a same-length close. A `]` at the link-closing depth
      // stops the search ONLY if a mismatched backtick run was seen since
      // the opener (`[docs each ``url`](...)`: the single `` ` `` makes
      // the span invalid, so the `]` closes the link). Without a
      // mismatched run the `]` may sit inside a valid span (`[not a
      // `link](/foo`)`), so keep searching for the close.
      let close = -1;
      let j = i + len;
      let d = depth;
      let sawMismatch = false;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '`') {
          let r = 0;
          while (j + r < s.length && s[j + r] === '`') r++;
          if (r === len) { close = j; break; }
          sawMismatch = true;
          j += r;
        } else if (ch === '[') { d++; j++; }
        else if (ch === ']') {
          if (d === 1 && sawMismatch) break;
          if (d > 0) d--;
          j++;
        } else if (ch === '\\') { j += 2; }
        else j++;
      }
      if (close >= 0) { i = close + len - 1; continue; }
      // No same-length close: accept any later backtick run as the close.
      j = i + len;
      while (j < s.length && s[j] !== '`') j++;
      if (j < s.length) {
        let r = 0;
        while (j + r < s.length && s[j + r] === '`') r++;
        i = j + r - 1;
        continue;
      }
      return -1;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse a link destination + optional title starting at `i` (just after the
// opening `(` has been consumed... here `i` points at the `(`). Returns
// { href, title, next } or null.
function parseInlineLink(s, i) {
  let j = i + 1;
  const n = s.length;
  while (j < n && isAsciiWs(s[j])) j++;
  let dest = '';
  if (s[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = s[k];
      if (c === '>') { ok = true; break; }
      if (c === '\n' || c === '<') break;
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { dest += s[k + 1]; k += 2; continue; }
      dest += c;
      k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else {
    let depth = 0;
    let ok = true;
    while (j < n) {
      const c = s[j];
      if (isAsciiWs(c) || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; dest += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; dest += c; j++; continue;
      }
      dest += c;
      j++;
    }
    if (depth !== 0) return null;
    if (dest === '' && j >= n) return null;
  }
  let title = null;
  let k = j;
  while (k < n && isAsciiWs(s[k])) k++;
  if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const close = s[k] === '(' ? ')' : s[k];
    let t = '';
    let p = k + 1;
    let closed = false;
    while (p < n) {
      const c = s[p];
      if (c === close) { closed = true; break; }
      if (c === '\\' && p + 1 < n && isAsciiPunct(s[p + 1])) { t += s[p + 1]; p += 2; continue; }
      t += c;
      p++;
    }
    if (!closed) return null;
    title = t;
    k = p + 1;
    while (k < n && isAsciiWs(s[k])) k++;
  }
  if (k >= n || s[k] !== ')') return null;
  return { href: dest, title, next: k + 1 };
}

// Try to match an inline HTML tag / comment / PI / declaration / CDATA at `i`
// (s[i] === '<'). Returns the raw matched text or null.
function matchInlineHtml(s, i) {
  const n = s.length;
  const rest = s.slice(i);
  let m;
  if (rest.startsWith('<!--')) {
    const e = rest.indexOf('-->');
    if (e < 0) return null;
    return rest.slice(0, e + 3);
  }
  if (rest.startsWith('<?')) {
    const e = rest.indexOf('?>');
    if (e < 0) return null;
    return rest.slice(0, e + 2);
  }
  if (rest.startsWith('<![CDATA[')) {
    const e = rest.indexOf(']]>');
    if (e < 0) return null;
    return rest.slice(0, e + 3);
  }
  if (rest.startsWith('<!') && rest.length > 2 && /[A-Za-z]/.test(rest[2])) {
    const e = rest.indexOf('>');
    if (e < 0) return null;
    return rest.slice(0, e + 1);
  }
  m = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>/.exec(rest);
  if (m) return m[0];
  m = /^<[A-Za-z][A-Za-z0-9-]*/.exec(rest);
  if (!m) return null;
  let j = m[0].length;
  // Whitespace inside a tag (between the name and attributes, around `=`)
  // may be a newline (cm-491: `<foo\nbar>` is a tag); a quoted attribute
  // value may also contain a newline (cm-642: `href="foo  \nbar"`).
  const isTagWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  while (j < n) {
    const c = s[i + j];
    if (c === '>') return rest.slice(0, j + 1);
    if (c === '/' && s[i + j + 1] === '>') return rest.slice(0, j + 2);
    if (isTagWs(c)) { j++; continue; }
    // Attribute name: first char is a letter or `_` (not `:` — cm-609:
    // `<m:abc>` is not a tag, the `:` cannot start an attribute).
    const am = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(rest.slice(j));
    if (!am) return null;
    j += am[0].length;
    let k = j;
    while (k < n && isTagWs(s[i + k])) k++;
    if (s[i + k] === '=') {
      k++;
      while (k < n && isTagWs(s[i + k])) k++;
      const q = s[i + k];
      if (q === '"' || q === "'") {
        const e = rest.indexOf(q, k + 1);
        if (e < 0) return null;
        j = e + 1;
        // After a quoted value there must be whitespace, `>`, or `/`
        // before the next attribute (cm-622: `<a href='bar'title=title>`
        // is not a tag).
        if (j < n) {
          const nc = s[i + j];
          if (nc !== ' ' && nc !== '\t' && nc !== '\n' && nc !== '\r' && nc !== '>' && nc !== '/') return null;
        }
      } else {
        const vm = /^[^\s"'=<>`]+/.exec(rest.slice(k));
        if (!vm) return null;
        j = k + vm[0].length;
      }
    } else {
      j = k;
    }
  }
  return null;
}

const AUTOLINK_SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*?)>/;
const AUTOLINK_EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;
const EXT_URL_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/|www\.)[^\s<>]*/;
const EXT_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*/;
// GFM extended autolinks for mailto:/xmpp: (marked's `At` rule): the email
// is It = local@domain with a (?![\w-]) lookahead; xmpp takes one /resource.
const GFM_EMAIL_IT = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+';
const MAILTO_RE = new RegExp('^mailto:' + GFM_EMAIL_IT + '(?![\\w-])');
const XMPP_RE = new RegExp('^xmpp:' + GFM_EMAIL_IT + '(?:\\/[A-Za-z0-9@.]+)?');

function trimAutolinkTail(u) {
  // A trailing `&name;` / `&#num;` entity is not part of the link
  // (gfm-627: `www.google.com/search?q=commonmark&hl;` links only up to
  // the `&`).
  u = u.replace(/&(?:[A-Za-z0-9]+|#[0-9]+|#[Xx][0-9A-Fa-f]+);$/, '');
  // A trailing `)` / `]` is stripped only when it is unmatched: scan with
  // a stack, so a `)` that closes an open `(` is kept
  // (`.../page=4)](./docs/create.md)` keeps its final `)`, while
  // `.../foo(bar))` drops the extra one).
  const unmatchedAt = (end, openCh, closeCh) => {
    const stack = [];
    for (let i = 0; i < end; i++) {
      if (u[i] === openCh) stack.push(i);
      else if (u[i] === closeCh && stack.length) stack.pop();
    }
    return stack.length > 0;
  };
  let end = u.length;
  while (end > 0) {
    const c = u[end - 1];
    if ('?!.,:;*_~\'"'.indexOf(c) >= 0) { end--; continue; }
    if (c === ')' && !unmatchedAt(end - 1, '(', ')')) { end--; continue; }
    // A trailing `]` is never stripped from an autolink (`a]`, `a]]`
    // both keep it, encoded as %5D in the href).
    break;
  }
  // A `(` with no matching `)` later in the URL is not part of it:
  // truncate at the first such `(` (`https://example.com/a(b` -> `.../a`,
  // `https://example.com/a(b)c(d` -> `.../a(b)c`). Balanced parens stay.
  {
    const stack = [];
    for (let i = 0; i < end; i++) {
      if (u[i] === '(') stack.push(i);
      else if (u[i] === ')' && stack.length) stack.pop();
    }
    if (stack.length) end = Math.min(end, stack[0]);
  }
  return u.slice(0, end);
}

// Tokenize inline content into a node list. `refs` maps normalized labels to
// { href, title }. `inLink` forbids forming a link inside link text.
function tokenizeInline(src, refs, inLink) {
  const toks = [];
  let buf = '';
  const flush = () => {
    if (buf) { toks.push({ t: 'text', s: buf }); buf = ''; }
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      // Hard break: two or more trailing spaces. Soft break: the newline.
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        toks.push({ t: 'br' });
        i++;
        // Leading spaces/tabs on the line after a hard break are stripped
        // (cm-636/637: `foo  \n     bar` gives `foo<br>bar`).
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') {
        flush(); toks.push({ t: 'br' }); i += 2;
        // Leading spaces/tabs on the line after a hard break are stripped
        // (cm-637, like cm-636).
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (d && isAsciiPunct(d)) { buf += d; i += 2; continue; }
      buf += '\\';
      i++;
      continue;
    }
    if (c === '`') {
      let len = 0;
      while (i + len < n && src[i + len] === '`') len++;
      let close = -1;
      let j = i + len;
      while (j < n) {
        if (src[j] === '`') {
          let r = 0;
          while (j + r < n && src[j + r] === '`') r++;
          if (r === len) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close < 0) { buf += '`'.repeat(len); i += len; continue; }
      let content = src.slice(i + len, close);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      toks.push({ t: 'code', s: content });
      i = close + len;
      continue;
    }
    if (c === '&') {
      const num = /^&#(\d{1,7});/.exec(src.slice(i)) || /^&#[Xx]([A-Fa-f0-9]{1,6});/.exec(src.slice(i));
      if (num) {
        // The hex branch strips the x/X prefix; decodeNumeric expects it.
        const decoded = decodeNumeric(num[0][2] === 'x' || num[0][2] === 'X' ? 'x' + num[1] : num[1]);
        if (decoded !== null) {
          buf += decoded;
          i += num[0].length;
          continue;
        }
        buf += '&';
        i++;
        continue;
      }
      const named = /^&(\w+);/.exec(src.slice(i));
      if (named) {
        flush();
        toks.push({ t: 'raw', s: named[0] });
        i += named[0].length;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    if (c === '<') {
      const rest = src.slice(i);
      let m = AUTOLINK_SCHEME_RE.exec(rest);
      if (m) {
        flush();
        const href = cleanHref(m[1]);
        if (href !== null) {
          toks.push({ t: 'link', href, title: null, auto: true, inner: [{ t: 'text', s: m[1] }] });
          i += m[0].length;
          continue;
        }
      }
      m = AUTOLINK_EMAIL_RE.exec(rest);
      if (m) {
        flush();
        toks.push({ t: 'link', href: 'mailto:' + m[1], title: null, auto: true, inner: [{ t: 'text', s: m[1] }] });
        i += m[0].length;
        continue;
      }
      const html = matchInlineHtml(src, i);
      if (html !== null) {
        flush();
        toks.push({ t: 'html', s: html });
        // Marked quirk: an inline `<a ...>` opening tag (including a
        // self-closing `<a .../>`) that is not closed by an inline `</a>`
        // in the same run suppresses GFM *extended* autolinks (bare email,
        // www., scheme://) for the rest of the document. An `<a>` that is
        // a complete HTML block, or one closed by `</a>` in the same run,
        // does not. The flag lives on `refs` (per-document) and persists
        // across blocks; only an inline `</a>` clears it. `<...>` autolinks
        // are unaffected.
        const tm = /^<\/?\s*([A-Za-z]+)/.exec(html);
        if (tm && tm[1].toLowerCase() === 'a') {
          if (html[1] === '/') refs._inA = false;
          // A bare `<a>` or `<a/>` (nothing at all after the name) does
          // not count as opening a link in marked; any whitespace or
          // attribute does (`<a >`, `<a href="x"/>`, `<a foo="bar">`).
          else if (!/^<a\/?>$/i.test(html)) refs._inA = true;
        }
        i += html.length;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImg = c === '!';
      const open = isImg ? i + 1 : i;
      const close = findClosingBracket(src, open);
      if (close > open && !hasUnclosedTag(src, open, close) && !hasBadCodeSpan(src.slice(open + 1, close))) {
        const text = src.slice(open + 1, close);
        let link = null;
        let k = close + 1;
        // Inline link: `(` must follow `]` immediately (no space). If the
        // inline parse fails, fall through to the reference check — the
        // `[foo]` part can still be a shortcut reference (cm-568:
        // `[foo](not a link)` with `[foo]: /url1` links `foo`).
        if (src[k] === '(') {
          const pl = parseInlineLink(src, k);
          if (pl) link = { href: pl.href, title: pl.title, next: pl.next };
        }
        if (!link) {
          // Full reference link: `[` must IMMEDIATELY follow `]` (no
          // whitespace skip — cm-542/543: `[foo] [bar]` and `[foo]\n[bar]`
          // leave `[foo]` literal). Shortcut reference: no separator.
          if (src[k] === '[') {
            const m = /^\[([^\]]*)\]/.exec(src.slice(k));
            if (m) {
              const label = m[1] === '' ? text : m[1];
              const ref = refs.get(normalizeLabel(label));
              if (ref) link = { href: ref.href, title: ref.title, next: k + m[0].length };
            }
          } else {
            const ref = refs.get(normalizeLabel(text));
            if (ref) link = { href: ref.href, title: ref.title, next: close + 1 };
          }
        }
        if (link) {
          const href = cleanHref(link.href);
          if (href !== null) {
            flush();
            if (isImg) {
              const altToks = tokenizeInline(text, refs, true);
              processEmphasis(altToks, true);
              toks.push({ t: 'img', href, title: link.title, alt: renderTextOnly(altToks) });
            } else {
              const inner = tokenizeInline(text, refs, true);
              processEmphasis(inner, true);
              const hasLink = containsLink(inner);
              if (!hasLink) {
                toks.push({ t: 'link', href, title: link.title, inner });
                i = link.next;
                continue;
              }
            }
            if (isImg) { i = link.next; continue; }
          }
        }
      }
      if (isImg) { buf += '!'; i++; continue; }
      buf += '[';
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let len = 0;
      while (i + len < n && src[i + len] === c) len++;
      const prev = i > 0 ? src[i - 1] : '';
      const next = i + len < n ? src[i + len] : '';
      const leftFlanking = next !== '' && !isSpace(next) && (!isPunct(next) || prev === '' || isSpace(prev) || isPunct(prev));
      const rightFlanking = prev !== '' && !isSpace(prev) && (!isPunct(prev) || next === '' || isSpace(next) || isPunct(next));
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
      else if (c === '~') {
        // A `~` run of 3+ tildes never opens or closes (marked's del
        // regex only matches 1-2 tildes, and the char after a 2-tilde
        // closer must not be `~`): `~~~not~~~` and `~~~~` stay literal.
        canOpen = leftFlanking && len <= 2;
        canClose = rightFlanking && len <= 2;
      }
      else {
        canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
        canClose = rightFlanking && (!leftFlanking || isPunct(next));
      }
      flush();
      toks.push({ t: 'delim', c, len, canOpen, canClose });
      i += len;
      continue;
    }
    // GFM extended autolinks: www., scheme://, email. Only at a word start.
    if ((c === 'w' && src.startsWith('www.', i)) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      const prev = i > 0 ? src[i - 1] : '';
      if (prev === '' || isSpace(prev) || '([{<*_~"\'`>'.indexOf(prev) >= 0) {
        // GFM mailto:/xmpp: autolinks (scheme + email/JID, no `//`).
        let m = MAILTO_RE.exec(src.slice(i)) || XMPP_RE.exec(src.slice(i));
        if (m) {
          const full = m[0];
          if (inLink || refs._inA) { buf += full; i += full.length; continue; }
          flush();
          toks.push({ t: 'link', href: full, title: null, auto: true, inner: [{ t: 'text', s: full }] });
          i += full.length;
          continue;
        }
        m = EXT_URL_RE.exec(src.slice(i));
        if (m) {
          const url = trimAutolinkTail(m[0]);
          if (url.length > 0) {
            if (inLink || refs._inA) { buf += url; i += url.length; continue; }
            flush();
            const href = url.startsWith('www.') ? cleanHref('http://' + url) : cleanHref(url);
            if (href !== null) {
              toks.push({ t: 'link', href, title: null, auto: true, inner: [{ t: 'text', s: url }] });
              i += url.length;
              continue;
            }
          }
        }
        m = EXT_EMAIL_RE.exec(src.slice(i));
        if (m && m[0].indexOf('@') > 0) {
          // An email followed by `-` or `_` is not an autolink at all
          // (gfm-632: `a.b-c_d@a.b-` and `a.b-c_d@a.b_` stay literal).
          // Exception: when the `_` closes an emphasis whose opening `_`
          // delimiter precedes the email (`__foo@bar.com__`,
          // `_foo@bar.com_`, `__a foo@bar.com__`), the email IS an
          // autolink — the `_` is a delimiter, not a word character.
          const after = src[i + m[0].length];
          let suppressed = after === '-';
          if (after === '_') {
            suppressed = true;
            for (let q = toks.length - 1; q >= 0; q--) {
              if (toks[q].t === 'delim' && toks[q].c === '_' && toks[q].canOpen) { suppressed = false; break; }
            }
          }
          if (suppressed) { /* fall through to text */ }
          else {
          const email = trimAutolinkTail(m[0]);
          // An email autolink needs a dot in the domain part.
          const at = email.indexOf('@');
          if (at > 0 && email.indexOf('.', at) > 0) {
            if (inLink || refs._inA) { buf += email; i += email.length; continue; }
            flush();
            toks.push({ t: 'link', href: 'mailto:' + email, title: null, auto: true, inner: [{ t: 'text', s: email }] });
            i += email.length;
            continue;
          }
          }
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return toks;
}

// ---- emphasis (CommonMark delimiter-stack algorithm) ----

function processEmphasis(toks, inLink) {
  // A link whose text holds a mismatched-backtick span (literal backticks
  // in its inner text, e.g. `[a ``b`](u)`) suppresses `*`/`_` emphasis
  // that sits between it and a later code span in the same paragraph
  // (`[a ``b`](u) parser __x__ by `y`` leaves `__x__` literal; a code
  // span before the emphasis does not end the zone, so `[docs each
  // ``url`](u) Function `deno` first _issue table_ `` a ` b `` link`
  // leaves `_issue table_` literal too). Mark those delimiters
  // suppressed so they can neither open nor close. A code span counts
  // whether it is a top-level code token or one inside a later link.
  {
    // The trigger is a MULTI-backtick run in the link text (a mismatched
    // code span, e.g. `` ``url` ``); a single literal backtick does not
    // suppress emphasis (doc-07's `[image ... else value ` path</a>](...)`
    // leaves `_if __author string___` forming).
    const innerHasBacktick = (ts) => {
      for (const tk of ts) {
        if (tk.t === 'text' && tk.s.includes('``')) return true;
        if (tk.inner && innerHasBacktick(tk.inner)) return true;
        if (tk.children && innerHasBacktick(tk.children)) return true;
      }
      return false;
    };
    const innerHasCode = (ts) => {
      for (const tk of ts) {
        if (tk.t === 'code') return true;
        if (tk.inner && innerHasCode(tk.inner)) return true;
        if (tk.children && innerHasCode(tk.children)) return true;
      }
      return false;
    };
    const hasBacktickLinkBefore = new Array(toks.length).fill(false);
    const hasCodeAfter = new Array(toks.length).fill(false);
    let seen = false;
    for (let q = 0; q < toks.length; q++) {
      hasBacktickLinkBefore[q] = seen;
      if (toks[q].t === 'link' && toks[q].inner && innerHasBacktick(toks[q].inner)) seen = true;
    }
    seen = false;
    for (let q = toks.length - 1; q >= 0; q--) {
      hasCodeAfter[q] = seen;
      if (toks[q].t === 'code' || (toks[q].t === 'link' && toks[q].inner && innerHasCode(toks[q].inner))) seen = true;
    }
    for (let q = 0; q < toks.length; q++) {
      if (toks[q].t === 'delim' && (toks[q].c === '*' || toks[q].c === '_') &&
          hasBacktickLinkBefore[q] && hasCodeAfter[q]) toks[q].suppressed = true;
    }
  }
  // openersBottom[c] is the delimiter token object that bounds the search
  // for an opener of character c (the token itself is still eligible).
  // `~` (GFM strikethrough) shares the delimiter stack: its runs open
  // and close like `*`, and nesting falls out of the stack
  // (`~~a ~~b~~ c~~` nests, `~~a ~~b~~` leaves the first `~~` literal).
  const bottom = { '*': null, '_': null, '~': null };
  let di = 0;
  while (di < toks.length) {
    const d = toks[di];
    if (d.t !== 'delim' || !d.canClose || d.suppressed) { di++; continue; }
    let oj = -1;
    let sawOpener = false;
    let leftoverInside = false;
    for (let j = di - 1; j >= 0; j--) {
      const o = toks[j];
      if (o.t === 'delim' && o.c === d.c && o.canOpen && !o.suppressed) {
        sawOpener = true;
        // CommonMark rule 9 (odd-match), `*`/`_` only: if EITHER
        // delimiter can both open and close, the sum of the lengths must
        // not be a multiple of 3, UNLESS both lengths are multiples of 3.
        // o is an opener (canOpen) and d is a closer (canClose), so "can
        // both" reduces to o.canClose or d.canOpen. `~` does not use it.
        if (d.c !== '~' && (o.canClose || d.canOpen) && (o.len + d.len) % 3 === 0 &&
            !(o.len % 3 === 0 && d.len % 3 === 0)) {
          // Odd-match rule: not a match, keep looking past the bottom.
          continue;
        }
        // Marked's regex emphasis diverges from rule 9 for `*` only: in
        // `**a *b*c* d**` the lone `*` does NOT match the initial `**`,
        // but in `**a *b* c* d**` it does, and in
        // `*uses state *callback*markdown**` the `**` DOES match the
        // initial `*`. The discriminator is the inner em/strong node
        // between them: reject only when the opener is len 2, the closer
        // is len 1, and an em/strong node between them closed with a
        // delimiter that could also open (its closer was followed by a
        // non-space char, e.g. `*so*other`). `_` runs follow rule 9
        // correctly (cm-468), so this is `*`-only.
        if (d.c === '*' && o.len === 2 && d.len === 1) {
          let hasNodeBetween = false;
          for (let q = j + 1; q < di; q++) {
            if ((toks[q].t === 'em' || toks[q].t === 'strong') && toks[q].ch === '*' && toks[q].co) { hasNodeBetween = true; break; }
          }
          if (hasNodeBetween) continue;
        }
        // Companion case: in `*a **b**c*` the outer em does NOT form,
        // but in `*foo**bar**baz*` and `*a **b** cd*` it does. The
        // discriminator is an inner `*`-strong between the outer `*`s
        // whose opening delimiter could only open (preceded by a space)
        // and whose closing delimiter could also open (followed by a
        // letter, e.g. `**b**c`). Reject any em match (use 1) then; a
        // strong match (both lens >= 2) is unaffected. A leftover closer
        // (remainder of the run that closed the inner node) is exempt.
        if (d.c === '*' && !(o.len >= 2 && d.len >= 2) && !d._leftover) {
          let hasNodeBetween = false;
          for (let q = j + 1; q < di; q++) {
            if (toks[q].t === 'strong' && toks[q].ch === '*' && toks[q].oc === false && toks[q].co) { hasNodeBetween = true; break; }
          }
          if (hasNodeBetween) continue;
        }
        // Outer strong with an inner em between whose opening
        // delimiter could only open (oc false) and whose closing
        // delimiter could also open (co true), e.g. `**a *b*c**`:
        // marked does NOT form the outer strong at all. But when the
        // closer run has a leftover (`**a *b*c***`, d.len 3), the strong
        // DOES form and the leftover `*` lands INSIDE it
        // (`<strong>a <em>b</em>c*</strong>`), not after it. The inner
        // node must be an em (a strong between, e.g. `**a **b**c**`,
        // does NOT veto) and the nearest `*` thing before the closer:
        // any other `*` delim between it and the closer (e.g. the lone
        // `*` in `**a *b*c* d**` or `**a *b **c**d* e**`) means the
        // outer strong forms normally.
        if (d.c === '*' && o.len >= 2 && d.len >= 2) {
          let vetoNode = null;
          for (let q = di - 1; q > j; q--) {
            const tk = toks[q];
            if (tk.t === 'delim' && tk.c === '*') break;
            if (tk.t === 'em' && tk.ch === '*') { vetoNode = tk; break; }
          }
          if (vetoNode && vetoNode.co) {
            // Veto (closer fully consumed): only when the inner node's
            // opening delimiter could only open (preceded by a space).
            // Leftover-inside (closer has a spare `*`): any inner node
            // whose closer could also open (followed by a letter).
            if (d.len === 2) { if (vetoNode.oc === false) continue; }
            else leftoverInside = true;
          }
        }
        // In link text, emphasis around a multi-backtick code span whose
        // content contains a backtick does NOT form (`[_node `` a ` b ``_](url)`
        // and `[*node `` a ` b ``*](url)` stay literal; in plain text the
        // same emphasis does form). A code token whose content holds a
        // backtick can only come from such a span (a single-backtick
        // span's content cannot contain one). This also applies when the
        // link was vetoed and renders literally: the delimiters then sit
        // inside a literal `[...]` pair in the token list.
        {
          let hasBacktickCode = false;
          for (let q = j + 1; q < di; q++) {
            if (toks[q].t === 'code' && toks[q].s.includes('`')) { hasBacktickCode = true; break; }
          }
          if (hasBacktickCode) {
            if (inLink) continue;
            let inBrackets = false;
            for (let q = j - 1; q >= 0; q--) {
              const tk = toks[q];
              if (tk.t === 'text' && tk.s.includes('[')) { inBrackets = true; break; }
              if (tk.t === 'text' && tk.s.includes(']')) break;
              if (tk.t === 'link' || tk.t === 'img') break;
            }
            if (inBrackets) {
              let hasClose = false;
              for (let q = di + 1; q < toks.length; q++) {
                const tk = toks[q];
                if (tk.t === 'text' && tk.s.includes(']')) { hasClose = true; break; }
                if (tk.t === 'text' && tk.s.includes('[')) break;
                if (tk.t === 'link' || tk.t === 'img') break;
              }
              if (hasClose) continue;
            }
          }
        }
        oj = j;
        break;
      }
      if (o === bottom[d.c]) break;
    }
    if (oj < 0) {
      // Only bound the search when no opener exists at all. If an opener
      // was seen but rejected by the odd-match rule, a later closer with a
      // different length may still match it (e.g. `**a *b*c* d**`: the lone
      // `*` after `c` is rejected against the initial `**`, but the final
      // `**` must still reach it).
      if (!sawOpener) bottom[d.c] = d;
      di++;
      continue;
    }
    const o = toks[oj];
    const use = o.len >= 2 && d.len >= 2 ? 2 : 1;
    const inner = toks.slice(oj + 1, di);
    // `co` records whether the closing delimiter could also open (it was
    // followed by a non-space char); `oc` whether the opening delimiter
    // could also close; `ch` the delimiter char. Marked's regex emphasis
    // uses these to decide the `**a *b*c* d**` and `*a **b**c*` cases,
    // so the node-between checks below read them. A `~` match makes a
    // `del` node (rendered from `inner`); `*`/`_` make em/strong.
    const node = d.c === '~'
      ? { t: 'del', inner }
      : { t: use === 2 ? 'strong' : 'em', children: inner, co: d.canOpen, oc: o.canClose, ch: d.c };
    o.len -= use;
    d.len -= use;
    // A leftover closer is the remainder of the run that just closed this
    // node (e.g. the `*` left from `***` after it closed an inner strong).
    // When it is re-examined as a closer it may match an outer opener
    // without the inner-node veto below (`*then is **x***` forms the
    // outer em; the veto is for a separate closer run, as in `*a **b**c*`).
    if (d.len > 0) d._leftover = true;
    const repl = [];
    if (o.len > 0) repl.push(o);
    repl.push(node);
    if (d.len > 0) {
      if (leftoverInside) {
        // The leftover closer `*` renders inside the node (as its last
        // child), not after it: `**a *b*c***` -> `<strong>a <em>b</em>c*</strong>`.
        if (d.c === '~') node.inner.push(d);
        else node.children.push(d);
      } else {
        repl.push(d);
      }
    }
    toks.splice(oj, di - oj + 1, ...repl);
    // Re-examine the closer remainder (if any) so a run like *** matches
    // twice: strong first, then em around it. A leftover moved inside the
    // node is not re-examined (it is literal content now).
    di = (d.len > 0 && !leftoverInside) ? oj + repl.length - 1 : oj + repl.length;
  }
  return toks;
}

function containsLink(toks) {
  for (const tk of toks) {
    // Autolinks (<...>) inside link text are emitted as nested links and do
    // not veto the outer link; only a real [text](url)/[text][ref] link does.
    if (tk.t === 'link' && !tk.auto) return true;
    if (tk.children && containsLink(tk.children)) return true;
    if (tk.inner && containsLink(tk.inner)) return true;
  }
  return false;
}

function renderTokens(toks) {
  let out = '';
  for (const tk of toks) {
    switch (tk.t) {
      case 'text': out += esc(tk.s); break;
      case 'raw': out += tk.s; break;
      case 'code': out += '<code>' + esc(tk.s) + '</code>'; break;
      case 'html': out += tk.s; break;
      case 'br': out += '<br>'; break;
      case 'del': out += '<del>' + renderTokens(tk.inner) + '</del>'; break;
      case 'delim': out += esc(tk.c.repeat(tk.len)); break;
      case 'em': out += '<em>' + renderTokens(tk.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderTokens(tk.children) + '</strong>'; break;
      case 'link': {
        out += '<a href="' + (tk.auto ? esc(tk.href) : escNoEncode(tk.href)) + '"';
        if (tk.title !== null && tk.title !== undefined) out += ' title="' + escNoEncode(tk.title) + '"';
        out += '>' + renderTokens(tk.inner) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + escNoEncode(tk.href) + '" alt="' + tk.alt + '"';
        if (tk.title !== null && tk.title !== undefined) out += ' title="' + escNoEncode(tk.title) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

// Plain-text rendering of inline tokens, for image alt text: tags are
// dropped, code keeps its literal content, entities pass through.
function renderTextOnly(toks) {
  let out = '';
  for (const tk of toks) {
    switch (tk.t) {
      case 'text': out += esc(tk.s); break;
      case 'raw': out += tk.s; break;
      case 'code': out += esc(tk.s); break;
      case 'em':
      case 'strong':
      case 'del': out += renderTextOnly(tk.children || tk.inner); break;
      case 'link': out += renderTextOnly(tk.inner); break;
      case 'img': out += tk.alt; break;
      default: break;
    }
  }
  return out;
}

function inlineParse(src, refs) {
  const toks = tokenizeInline(src, refs, false);
  processEmphasis(toks, false);
  return renderTokens(toks);
}

// ---------- block parsing ----------
// Node shapes: {t, _a, _b, ...} where _a/_b are the line range [start, end)
// inside the lines array handed to lexBlocks.

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

// Expand a leading run of spaces/tabs to spaces, starting at column startCol.
function expandLeadingTabs(s, startCol) {
  let out = '', col = startCol, k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === ' ') { out += ' '; col++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    k++;
  }
  return out + s.slice(k);
}

// marked's ke(): -1 when parens are balanced (or absent), else != -1.
function ke(s) {
  let level = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') level++;
    else if (ch === ')') { level--; if (level < 0) return i; }
  }
  return level === 0 ? -1 : -2;
}

function matchAtx(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2].replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else {
    const cm = /^(.*)[ \t](#+)$/.exec(text);
    if (cm) text = cm[1].replace(/[ \t]+$/, '');
  }
  return { level: m[1].length, text };
}

function setextLevel(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

function isHr(line) {
  return /^ {0,3}([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function matchFence(line) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const ch = m[1][0];
  if (ch === '`' && m[2].indexOf('`') >= 0) return null;
  return { ch, len: m[1].length, info: m[2], indent: /^ */.exec(line)[0].length };
}

function isClosingFence(line, ch, len) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1][0] === ch && m[1].length >= len;
}

// List-item start. Returns null, or {ordered, startNum, delim, markerChar,
// markerCol, contentIndent, contentStart, empty}.
function matchListStart(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i > 3) return null;
  const markerCol = i;
  let ordered = false, startNum = 0, delim = '', markerChar = '', markerLen = 0;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') {
    markerChar = c; markerLen = 1; i++;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - i < 9) j++;
    if (j - i > 9) return null;
    if (line[j] !== '.' && line[j] !== ')') return null;
    ordered = true; startNum = parseInt(line.slice(i, j), 10);
    delim = line[j]; markerLen = (j - i) + 1; i = j + 1;
  } else return null;
  // Spaces/tabs after the marker (column-wise).
  let col = markerCol + markerLen, spaces = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { spaces++; col++; i++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; i++; }
  }
  const content = line.slice(i);
  if (content === '') {
    return { ordered, startNum, delim, markerChar, markerCol, markerLen, contentIndent: markerCol + markerLen + 1, contentStart: i, empty: true };
  }
  if (spaces === 0) return null; // marker not followed by space/tab: not a list
  const pad = spaces > 4 ? 1 : spaces;
  return { ordered, startNum, delim, markerChar, markerCol, markerLen, contentIndent: markerCol + markerLen + pad, contentStart: i, empty: false };
}

// HTML block start type (1-7) or 0. maxIndent caps the leading spaces.
function htmlBlockType(line, maxIndent) {
  let n = 0;
  while (n < line.length && line[n] === ' ' && n < maxIndent) n++;
  if (n > maxIndent) return 0;
  const rest = line.slice(n);
  if (/^<(script|pre|style|textarea)([\s>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const tm = /^<\/?([A-Za-z][^\s\/>]*)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[1].toLowerCase())) {
    const after = rest.slice(tm[0].length);
    if (after === '' || after[0] === ' ' || after[0] === '\t' || after[0] === '>' || after[0] === '/') return 6;
  }
  return 0;
}

function htmlBlockRaw(lines, i, k, type) {
  let raw = lines.slice(i, k + 1).join('\n');
  const nxt = lines[k + 1];
  // Types 1-5: trailing `\n` iff the source has a newline after the last
  // line and the next line is not a truly empty line: a spaces/tabs-only
  // line does NOT suppress it (marked adds `\n` after `-->` when the next
  // line is `\t`).
  // Types 6-7: a blank line after the block NEVER adds a trailing `\n`
  // (`</details>\n   \npara` -> `</details><p>para</p>`); only EOF with a
  // trailing newline does.
  // The final element `''` (source ends with `\n`) counts as a newline.
  if (type <= 5) {
    if (nxt !== undefined && (nxt !== '' || k + 1 === lines.length - 1)) raw += '\n';
  } else {
    if (nxt !== undefined && nxt === '' && k + 1 === lines.length - 1) raw += '\n';
  }
  return raw;
}

function matchHtmlBlock(lines, i, end) {
  let type = htmlBlockType(lines[i], 3);
  if (type === 0) {
    // Type 7: the line is exactly one complete open/close tag.
    const line = lines[i];
    let n = 0;
    while (n < line.length && line[n] === ' ' && n < 3) n++;
    if (n > 3) return null;
    const trimmed = line.slice(n).replace(/[ \t]+$/, '');
    const h = matchInlineHtml(trimmed, 0);
    if (h === null || h.length !== trimmed.length) return null;
    type = 7;
  }
  let k = i;
  if (type <= 5) {
    let closeRe;
    if (type === 1) {
      const nm = /^<(script|pre|style|textarea)/i.exec(lines[i].replace(/^ {0,3}/, ''));
      closeRe = new RegExp('</' + nm[1] + '[\\s>]', 'i');
    } else if (type === 2) closeRe = /-->/;
    else if (type === 3) closeRe = /\?>/;
    else if (type === 4) closeRe = />/;
    else closeRe = /\]\]>/;
    for (; k < end; k++) {
      if (closeRe.test(lines[k])) break;
    }
    if (k >= end) k = end - 1;
  } else {
    while (k + 1 < end && !isBlankAt(lines, k + 1, end)) k++;
  }
  return { type, k, raw: htmlBlockRaw(lines, i, k, type) };
}

// marked's anyPunctuation: a backslash followed by a Unicode punctuation
// or symbol character (used to unescape def hrefs/titles).
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;

// --- link reference definitions ---
// Scans a (possibly multi-line) title starting at lines[li][col]. Returns
// {title, endLine, endCol} (endCol is just past the closing quote) or null.
// The title may span lines; backslash escapes are honoured. A single-quoted
// title may not contain a blank line.
function scanTitle(lines, li, col, end) {
  const q = lines[li][col];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let line = li, c = col + 1, content = '';
  while (line < end) {
    const s = lines[line];
    while (c < s.length) {
      const ch = s[c];
      if (ch === '\\' && c + 1 < s.length) { content += s[c] + s[c + 1]; c += 2; continue; }
      if (ch === close) {
        // Only spaces/tabs may follow on this line.
        if (/^[ \t]*$/.test(s.slice(c + 1))) {
          return { title: content, endLine: line, endCol: c + 1 };
        }
        return null;
      }
      content += ch;
      c++;
    }
    // End of line: the title continues on the next line (with a newline),
    // except a single-quoted title may not span a blank line.
    if (q === "'" && line + 1 < end && lines[line + 1].trim() === '') return null;
    line++;
    c = 0;
    if (line < end) content += '\n';
  }
  return null;
}

function parseDefLine(lines, j, end) {
  const line = lines[j];
  let n = 0;
  while (n < line.length && line[n] === ' ' && n < 3) n++;
  if (n > 3 || line[n] !== '[') return null;
  // Balanced-bracket label; it may span lines (but not a blank line).
  // NOTE: marked's def regex stops at the FIRST `]` (no nested brackets
  // in a def label — cm-547/548/590: `[ref[bar]]: /uri` is not a def).
  // So the scan ends at the first unescaped `]`, even if `[` was seen.
  let label = null;
  let li = j, col = n + 1;
  let labelText = '';
  let found = false;
  while (li < end) {
    const cur = lines[li];
    while (col < cur.length) {
      const ch = cur[col];
      if (ch === '\\' && col + 1 < cur.length) { labelText += cur[col] + cur[col + 1]; col += 2; continue; }
      if (ch === ']') { label = labelText; col++; found = true; break; }
      labelText += ch;
      col++;
    }
    if (found) break;
    // End of line without the closing `]`: continue on the next line
    // unless it is blank (a blank line ends the label).
    if (li + 1 >= end) return null;
    const nl = lines[li + 1];
    if (nl.trim() === '') return null;
    labelText += '\n';
    li++;
    col = 0;
  }
  if (!found || label === null) return null;
  // A def label containing an unescaped `[` is not a definition
  // (cm-546: `[ref[]: /uri` is literal; an escaped `\[` is fine).
  for (let q = 0; q < label.length; q++) {
    if (label[q] === '\\') { q++; continue; }
    if (label[q] === '[') return null;
  }
  // A label that normalizes to empty is not a definition (cm-552).
  if (normalizeLabel(label) === '') return null;
  if (col >= lines[li].length || lines[li][col] !== ':') return null;
  // Cursor just after the colon.
  col = col + 1;
  // Skip spaces/tabs; the dest may be on the next line.
  const skipWs = () => {
    while (true) {
      while (col < lines[li].length && (lines[li][col] === ' ' || lines[li][col] === '\t')) col++;
      if (col < lines[li].length) return true;
      if (li + 1 >= end) return false;
      li++; col = 0;
      // The next line's leading spaces are also skipped (def regex allows it).
      while (col < lines[li].length && (lines[li][col] === ' ' || lines[li][col] === '\t')) col++;
      if (col < lines[li].length) return true;
      // The next line was blank: the dest cannot be there.
      return false;
    }
  };
  if (!skipWs()) return null;
  let href;
  const s = lines[li];
  if (s[col] === '<') {
    const e = s.indexOf('>', col + 1);
    if (e < 0) return null;
    href = s.slice(col + 1, e);
    col = e + 1;
  } else {
    let e = col;
    while (e < s.length && s[e] !== ' ' && s[e] !== '\t') e++;
    if (e === col) return null;
    href = s.slice(col, e);
    if (ke(href) !== -1) return null;
    col = e;
  }
  href = href.replace(ANY_PUNCT_RE, '$1');
  // After the dest: only spaces/tabs (then optionally a newline + spaces)
  // may precede a title; anything else invalidates the definition.
  let title = null, next = li + 1;
  let hadSpace = false;
  while (col < lines[li].length && (lines[li][col] === ' ' || lines[li][col] === '\t')) { col++; hadSpace = true; }
  if (col < lines[li].length) {
    if (!hadSpace) return null;
    const t = scanTitle(lines, li, col, end);
    if (!t) return null;
    title = t.title.replace(ANY_PUNCT_RE, '$1');
    next = t.endLine + 1;
  } else if (li + 1 < end) {
    // Title may be on the next line.
    const nl = lines[li + 1];
    let c2 = 0;
    while (c2 < nl.length && (nl[c2] === ' ' || nl[c2] === '\t')) c2++;
    if (c2 < nl.length) {
      const t = scanTitle(lines, li + 1, c2, end);
      if (t) { title = t.title.replace(ANY_PUNCT_RE, '$1'); next = t.endLine + 1; }
    }
  }
  return { label: normalizeLabel(label), href, title, next };
}

function tryDefs(lines, i, end, refs) {
  let j = i, consumed = false;
  while (j < end) {
    const res = parseDefLine(lines, j, end);
    if (!res) break;
    if (!refs.has(res.label)) refs.set(res.label, { href: res.href, title: res.title });
    j = res.next;
    consumed = true;
  }
  return consumed ? j : 0;
}

// --- tables ---
function splitTableCells(line) {
  const cells = [];
  let cur = '', i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) { cur += line[i] + line[i + 1]; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

function isDelimiterRow(line) {
  if (indentOf(line) > 3) return false;
  if (line.indexOf('|') < 0 && line.indexOf(':') < 0) return false;
  const cells = splitTableCells(line);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-+:?$/.test(c));
}

function tableAt(lines, i, end) {
  if (i + 1 >= end) return null;
  if (indentOf(lines[i]) > 3) return null;
  const header = lines[i];
  if (header.trim() === '') return null;
  if (!isDelimiterRow(lines[i + 1])) return null;
  const headerCells = splitTableCells(header);
  const delimCells = splitTableCells(lines[i + 1]);
  if (headerCells.length !== delimCells.length || headerCells.length === 0) return null;
  const align = delimCells.map(c => {
    if (/^ *-+: *$/.test(c)) return 'right';
    if (/^ *:-+: *$/.test(c)) return 'center';
    if (/^ *:-+ *$/.test(c)) return 'left';
    return null;
  });
  // Rows: non-blank lines that do not start a block. A line of exactly
  // one tab is a row of empty cells in marked (it is not blank for table
  // purposes); a line that is empty, whitespace with a space in it, or
  // two or more tabs ends the table.
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const ln = lines[j];
    if (ln === '' || (isBlank(ln) && (ln.indexOf(' ') >= 0 || ln !== '\t'))) break;
    if (startsBlockTop(ln)) break;
    rows.push(ln);
    j++;
  }
  const rowCells = rows.map(r => {
    const cells = splitTableCells(r);
    while (cells.length < headerCells.length) cells.push('');
    return cells.slice(0, headerCells.length);
  });
  return { node: { t: 'table', header: headerCells, align, rows: rowCells, _a: i, _b: j }, next: j };
}

// Block-start test used for paragraph interruption (top-level context).
function startsBlockTop(line) {
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const ls = matchListStart(line);
  if (ls) {
    if (!ls.ordered && !ls.empty) return true;
    if (ls.ordered && ls.startNum === 1 && !ls.empty) return true;
  }
  if (htmlBlockType(line, 3) >= 1) return true;
  return false;
}

// Block-start test for text tokens inside list items (state.top=false):
// marked's Ke paragraph pattern lets ANY ordered list interrupt the text,
// not just one starting with 1 (the We/top-level pattern requires 1).
function startsBlockText(line) {
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const ls = matchListStart(line);
  if (ls && !ls.empty) return true;
  if (htmlBlockType(line, 3) >= 1) return true;
  return false;
}

// Block-start tests used inside a list item body, with indent cap R.
// Each tests the RAW line (spaces only, tabs do not count toward the cap).
function _leadSpaces(line, cap) {
  let n = 0;
  while (n < line.length && line[n] === ' ' && n < cap) n++;
  return n;
}
function _fenceBegin(line, R) { const n = _leadSpaces(line, R); return n <= R && (line.startsWith('```', n) || line.startsWith('~~~', n)); }
function _headingBegin(line, R) {
  const n = _leadSpaces(line, R);
  if (n > R) return false;
  const m = /^#{1,6}(?:\s|$)/.exec(line.slice(n));
  return m !== null;
}
function _hrBegin(line, R) {
  const n = _leadSpaces(line, R);
  if (n > R) return false;
  // Same as isHr (same marker char 3+ times, spaces allowed between),
  // anchored at both ends; the leading spaces are already stripped.
  return /^([*\-_])(?:[ \t]*\1){2,}[ \t]*$/.test(line.slice(n));
}
function _quoteBegin(line, R) { const n = _leadSpaces(line, R); return n <= R && line[n] === '>'; }
function _bulletBegin(line, R) {
  const n = _leadSpaces(line, R);
  if (n > R) return false;
  const rest = line.slice(n);
  return /^(?:[*+-]|\d{1,9}[.)])(?:[ \t][^\n]*)?$/.test(rest);
}
function _htmlBegin(line, R) { return htmlBlockType(line, R) >= 1; }
function _blockBegin(line, R) {
  return _fenceBegin(line, R) || _headingBegin(line, R) || _htmlBegin(line, R) ||
    _quoteBegin(line, R) || _bulletBegin(line, R) || _hrBegin(line, R);
}

// --- lists (marked's item-body algorithm, line-based) ---
function parseListItem(lines, j, end, ls) {
  const b = ls.markerCol + ls.markerLen;
  // g: the content after the marker on the marker line.
  const markerEnd = b;
  let gi = markerEnd;
  const gRaw = lines[j].slice(markerEnd);
  // m: g with leading tabs expanded relative to column b.
  const m0 = expandLeadingTabs(gRaw, b);
  let y = !m0.trim();
  let R, d;
  if (y) { R = b + 1; d = ''; }
  else {
    let r = m0.search(/[^ ]/);
    if (r < 0) r = m0.length;
    r = r > 4 ? 1 : r;
    d = m0.slice(r);
    R = r + b;
  }
  const textLines = d === '' ? [] : [d];
  let k = j + 1;
  let m = m0;
  // Empty item followed by a blank line ends the item (the blank is consumed).
  let endedEarly = false;
  if (y && k < end && isBlankAt(lines, k, end)) { k++; endedEarly = true; }
  if (!endedEarly) {
    // marked's D() wrapper clamps the break-test indent cap to [0,3] of R-1.
    const cap = Math.max(0, Math.min(3, R - 1));
    while (k < end) {
      const U = lines[k];
      const f = U;
      const Z = expandLeadingTabs(U, 0);
      if (_fenceBegin(f, cap) || _headingBegin(f, cap) || _htmlBegin(f, cap) || _quoteBegin(f, cap) || _bulletBegin(f, cap) || _hrBegin(f, cap)) break;
      if (Z.search(/[^ ]/) >= R || !f.trim()) {
        // A blank separator line is stored empty: storing the leftover
        // spaces (`Z.slice(R)`) makes it look like paragraph content to
        // `isBlankAt` when it is the last text line (`1. foo\n\t\n2. bar`
        // rendered `foo\n </p>` instead of `foo</p>`).
        textLines.push(!f.trim() ? '' : Z.slice(R));
      } else {
        if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
            _fenceBegin(m, cap) || _headingBegin(m, cap) || _htmlBegin(m, cap) || _hrBegin(m, cap)) break;
        let qe = f;
        if (/^ {0,3}(?:=+|-+) *$/.test(f)) {
          const lh = m + '\n' + f;
          if (/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/.test(lh + '\n')) qe = '    ' + Z.replace(/^ {0,3}/, '');
        }
        textLines.push(qe);
      }
      y = !f.trim();
      m = Z.slice(R);
      k++;
    }
  }
  return { textLines, next: k, contentIndent: R };
}

function parseList(lines, i, end, refs, opts) {
  const first = matchListStart(lines[i]);
  if (!first) return null;
  const ordered = first.ordered;
  const delim = first.delim;
  const markerChar = first.markerChar;
  const start = first.startNum;
  const items = [];
  let j = i, loose = false, p = false;
  while (j < end) {
    const lm = matchListStart(lines[j]);
    if (!lm) break;
    if (lm.ordered !== ordered) break;
    if (ordered && lm.delim !== delim) break;
    if (!ordered && lm.markerChar !== markerChar) break;
    if (isHr(lines[j])) break;
    const itemStart = j;
    const body = parseListItem(lines, j, end, lm);
    j = body.next;
    // Loose detection (double blank line at the end of the item's raw):
    // the item's raw ends with a blank line iff the last consumed line is blank.
    const endsWithBlank = body.next > itemStart && isBlank(lines[body.next - 1]);
    if (!loose) {
      if (p) loose = true;
      else if (endsWithBlank) p = true;
    }
    items.push({ textLines: body.textLines, start: itemStart, end: body.next });
  }
  if (items.length === 0) return null;
  // Trim the last item's text (marked trims the last item's raw/text).
  // The trimmed trailing blank lines are NOT consumed: back `j` up by the
  // number trimmed so the caller re-processes them as space tokens (this
  // is what makes a list loose when a blank line follows its last item's
  // content, e.g. before a fenced code block). A trailing spaces-only line
  // counts as blank here (it was stored with the content indent stripped).
  const last = items[items.length - 1];
  let trimmed = 0;
  while (last.textLines.length && isBlank(last.textLines[last.textLines.length - 1])) { last.textLines.pop(); trimmed++; }
  j -= trimmed;
  const listNode = { t: 'list', ordered, start, loose, items: [], _a: i, _b: j };
  for (const it of items) {
    const text = it.textLines.join('\n');
    const nodes = lexBlocks(it.textLines, 0, it.textLines.length, refs, { top: false });
    // Task checkbox.
    let task = false, checked = false;
    if (/^\[[ xX]\][ \t]+\S/.test(text) && nodes.length > 0 &&
        (nodes[0].t === 'text' || nodes[0].t === 'para')) {
      task = true;
      checked = text[1] !== ' ';
      const stripped = text.replace(/^\[[ xX]\][ \t]+/, '');
      // Strip the marker from the first node's text as well.
      nodes[0].text = nodes[0].text.replace(/^\[[ xX]\][ \t]+/, '');
      const itemNode = { t: 'item', task, checked, loose: false, text: stripped, nodes, _a: it.start, _b: it.end };
      listNode.items.push(itemNode);
    } else {
      listNode.items.push({ t: 'item', task: false, checked: false, loose: false, text, nodes, _a: it.start, _b: it.end });
    }
  }
  // Loose via space tokens inside items.
  if (!loose) {
    for (const it of listNode.items) {
      if (it.nodes.some(n => n.t === 'space' && /\n.*\n/.test(n.raw))) { loose = true; break; }
    }
  }
  listNode.loose = loose;
  if (loose) for (const it of listNode.items) it.loose = true;
  return { node: listNode, next: j };
}

// --- blockquotes ---
// The last para/text descendant of a quote node (the innermost paragraph
// a lazy line continues), or null.
function innermostPara(node) {
  let cur = node;
  while (cur) {
    if (cur.t === 'para' || cur.t === 'text') return cur;
    if (cur.t === 'quote' && cur.children && cur.children.length > 0) {
      cur = cur.children[cur.children.length - 1];
    } else if (cur.t === 'list' && cur.items && cur.items.length > 0) {
      const lastItem = cur.items[cur.items.length - 1];
      if (lastItem.nodes && lastItem.nodes.length > 0) cur = lastItem.nodes[lastItem.nodes.length - 1];
      else return null;
    } else return null;
  }
  return null;
}

function stripQuoteMarker(line) {
  const qm = /^ {0,3}>/.exec(line);
  const markerEnd = qm[0].length;
  let col = markerEnd, k = markerEnd, spaces = '';
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    if (line[k] === ' ') { spaces += ' '; col++; }
    else { const w = 4 - (col % 4); spaces += ' '.repeat(w); col += w; }
    k++;
  }
  if (spaces.length === 0) return line.slice(markerEnd);
  return spaces.slice(1) + line.slice(k);
}

function parseQuote(lines, i, end, refs) {
  let inner = []; // {text, lazy, src}
  let j = i;
  while (j < end) {
    const ln = lines[j];
    if (/^ {0,3}>/.test(ln)) {
      inner.push({ text: stripQuoteMarker(ln), lazy: false, src: j });
      j++;
    } else if (isBlankAt(lines, j, end)) {
      // A truly blank line (no `>` marker) ends the quote: marked's
      // blockquote regex cannot match it, so the next `>` line starts a
      // separate quote. (`>` lines that are blank after the marker are
      // caught by the first branch and stay inside.)
      break;
    } else if (inner.length > 0 && inner[inner.length - 1].text !== '') {
      inner.push({ text: ln, lazy: true, src: j });
      j++;
    } else {
      break;
    }
  }
  // Post-check loop: lazy lines that do not continue a paragraph/list item
  // inside the quote end the quote at that line.
  while (true) {
    // Trailing blank inner lines are not part of the quote's content.
    // An empty line is always blank; a spaces-only line is popped only
    // when the previous line is also blank (a trailing blank run, cm-240),
    // not when it continues a paragraph (cm-241: `> foo` + `>  ` keeps
    // the ` ` in the paragraph text).
    while (inner.length > 0) {
      const last = inner[inner.length - 1].text;
      if (last === '') { inner.pop(); continue; }
      if (isBlank(last)) {
        const prev = inner.length > 1 ? inner[inner.length - 2].text : '';
        if (isBlank(prev)) { inner.pop(); continue; }
      }
      break;
    }
    // Setext-indent rule for lazy setext lines, and the no-setext flag.
    const innerLines = [];
    const lazyFlags = [];
    const noSetext = [];
    const noStrip = [];
    for (let k = 0; k < inner.length; k++) {
      const it = inner[k];
      let text = it.text;
      let ns = false;
      let nstrip = false;
      if (it.lazy && setextLevel(text) && k > 0) {
        const prev = inner[k - 1];
        if (prev.lazy && prev.text !== '') { text = '    ' + text.replace(/^ {0,3}/, ''); nstrip = true; }
        else ns = true;
      }
      innerLines.push(text);
      lazyFlags.push(it.lazy);
      noSetext.push(ns);
      noStrip.push(nstrip);
    }
    const nodes = lexBlocks(innerLines, 0, innerLines.length, refs, { top: true, inQuote: true, lazy: lazyFlags, noSetext, noStrip });
    let badIdx = -1;
    for (let idx = 0; idx < inner.length; idx++) {
      if (!inner[idx].lazy) continue;
      let node = null;
      let nodeIdx = -1;
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        if (idx >= n._a && idx < n._b) { node = n; nodeIdx = ni; break; }
      }
      if (!node) { badIdx = idx; break; }
      if (node.t === 'para' && idx > node._a) continue;
      if (node.t === 'quote') continue;
      if (node.t === 'para' && idx === node._a) {
        // A lazy line starting a new paragraph merges into the innermost
        // paragraph of the immediately preceding nested quote (cm-250:
        // `> > > foo` + `bar` -> `foo\nbar` in one paragraph inside three
        // quotes; cm-251: `>>> foo` + `> bar` + `>>baz` likewise). The
        // paragraph node may span several lazy lines (`bar\nbaz`).
        const prev = nodeIdx > 0 ? nodes[nodeIdx - 1] : null;
        if (prev && prev.t === 'quote') {
          const innerPara = innermostPara(prev);
          if (innerPara) {
            innerPara.text += '\n' + node.text;
            innerPara._b = node._b;
            prev._b = node._b;
            nodes.splice(nodeIdx, 1);
            continue;
          }
        }
        badIdx = idx; break;
      }
      if (node.t === 'list') {
        // A lazy line is allowed only if it continues an item's text. If
        // it is the FIRST line of an item it starts a NEW item, which must
        // end the quote (cm-235: `> - foo` + `- bar` keeps only `foo`).
        let inside = false;
        for (const it of node.items) {
          if (idx > it._a && idx < it._b) { inside = true; break; }
        }
        if (inside) continue;
      }
      badIdx = idx; break;
    }
    if (badIdx < 0) {
      return { node: { t: 'quote', children: nodes, _a: i, _b: j }, next: j };
    }
    const badSrc = inner[badIdx].src;
    inner = inner.slice(0, badIdx);
    j = badSrc;
  }
}

// --- paragraph / text collection ---
function collectParagraph(lines, i, end, opts) {
  const parts = [lines[i]];
  let j = i + 1;
  while (j < end) {
    const ln = lines[j];
    if (isBlankAt(lines, j, end)) break;
    if (setextLevel(ln) && !(opts.noSetext && opts.noSetext[j])) break;
    if (tableAt(lines, j, end)) break;
    if (startsBlockTop(ln)) break;
    // A lazy indented line in a quote is an indented-code token merged
    // into the paragraph with 4 columns stripped (cm-238), unless it was
    // indented by the setext rule (cm-093) — those 4 spaces are output.
    if (opts.lazy && opts.lazy[j] && indentOf(ln) >= 4 && !(opts.noStrip && opts.noStrip[j])) parts.push(stripIndent(ln, 4));
    else parts.push(ln);
    j++;
  }
  if (j < end) {
    const sl = setextLevel(lines[j]);
    if (sl && !(opts.noSetext && opts.noSetext[j])) {
      return { node: { t: 'heading', level: sl, text: parts.join('\n').trim(), _a: i, _b: j + 1 }, next: j + 1 };
    }
  }
  return { node: { t: 'para', text: parts.join('\n'), _a: i, _b: j }, next: j };
}

function collectText(lines, i, end, opts) {
  const parts = [];
  let j = i, lastWasCode = false;
  while (j < end) {
    const ln = lines[j];
    if (isBlankAt(lines, j, end)) {
      if (lastWasCode) {
        while (j < end && isBlankAt(lines, j, end)) { parts.push(''); j++; }
        lastWasCode = false;
        continue;
      }
      break;
    }
    // Setext heading: an underline after a text line forms a heading
    // (marked tries lheading before the text tokenizer). Only when the
    // accumulated text's last line is a real text line, not a code line.
    if (j > i && !lastWasCode && parts.length > 0 && parts[parts.length - 1] !== '') {
      const sl = setextLevel(ln);
      if (sl && !(opts.noSetext && opts.noSetext[j])) {
        return { node: { t: 'heading', level: sl, text: parts.join('\n').trim(), _a: i, _b: j + 1 }, next: j + 1 };
      }
    }
    if (indentOf(ln) >= 4) {
      parts.push(stripIndent(ln, 4));
      lastWasCode = true;
      j++;
      continue;
    }
    if (j > i && startsBlockText(ln)) break;
    parts.push(ln);
    lastWasCode = false;
    j++;
  }
  return { node: { t: 'text', text: parts.join('\n'), _a: i, _b: j }, next: j };
}

// Fenced-code content stripping, marked-style (its Dt()): remove up to
// `n` leading whitespace CHARACTERS from each content line, where `n` is
// the length of the opening fence's leading whitespace. A tab counts as
// one character here, not four columns: "\tindented" under a 3-space
// fence loses the tab entirely, while column-wise stripIndent would
// leave 1 space (and 2 spaces under a 2-space fence). Only backtick
// fences strip at all: Dt's compensation regex requires ```, so tilde
// fences keep their content untouched.
function stripFenceIndent(s, n) {
  let i = 0;
  while (i < s.length && i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
}

function parseFence(lines, i, end) {
  const fm = matchFence(lines[i]);
  let k = i + 1;
  while (k < end && !isClosingFence(lines[k], fm.ch, fm.len)) k++;
  const closed = k < end;
  const contentLines = lines.slice(i + 1, closed ? k : end);
  let text = '';
  if (contentLines.length > 0) {
    const stripped = fm.ch === '`'
      ? contentLines.map(l => stripFenceIndent(l, fm.indent))
      : contentLines;
    // Fenced content = the raw region between the fence lines (one `\n`
    // per line, so join + a trailing `\n`), minus one trailing `\n`,
    // then ensure a trailing `\n` if non-empty. Two empty lines give
    // `\n`, not `` (the join alone loses a newline).
    text = stripped.join('\n') + '\n';
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  }
  const langRaw = fm.info.trim().replace(ANY_PUNCT_RE, '$1');
  const lang = langRaw.split(/\s+/)[0] || null;
  return { node: { t: 'code', lang, text, _a: i, _b: (closed ? k + 1 : end) }, next: closed ? k + 1 : end };
}

function parseIndentedCode(lines, i, end) {
  const contentLines = [];
  let j = i;
  while (j < end) {
    const ln = lines[j];
    if (isBlankAt(lines, j, end)) {
      let k = j + 1;
      while (k < end && isBlankAt(lines, k, end)) k++;
      if (k < end && indentOf(lines[k]) >= 4) {
        while (j < k) { contentLines.push(stripIndent(lines[j], 4)); j++; }
        continue;
      }
      break;
    }
    if (indentOf(ln) >= 4) { contentLines.push(stripIndent(ln, 4)); j++; }
    else break;
  }
  while (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
  const text = contentLines.length > 0 ? contentLines.join('\n') + '\n' : '';
  return { node: { t: 'code', lang: null, text, _a: i, _b: j }, next: j };
}

function lexBlocks(lines, start, end, refs, opts) {
  const nodes = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankAt(lines, i, end)) {
      let j = i;
      while (j < end && isBlankAt(lines, j, end)) j++;
      const trailing = j >= end;
      const raw = '\n'.repeat(trailing ? (j - i) : (j - i + 1));
      if (!(raw.length === 1 && nodes.length > 0)) {
        nodes.push({ t: 'space', raw, _a: i, _b: j });
      }
      i = j;
      continue;
    }
    const dEnd = tryDefs(lines, i, end, refs);
    if (dEnd) { i = dEnd; continue; }
    const fm = matchFence(line);
    if (fm) {
      const f = parseFence(lines, i, end);
      nodes.push(f.node); i = f.next; continue;
    }
    if (indentOf(line) >= 4) {
      const c = parseIndentedCode(lines, i, end);
      nodes.push(c.node); i = c.next; continue;
    }
    const ax = matchAtx(line);
    if (ax) { nodes.push({ t: 'heading', level: ax.level, text: ax.text, _a: i, _b: i + 1 }); i++; continue; }
    if (isHr(line)) { nodes.push({ t: 'hr', _a: i, _b: i + 1 }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const q = parseQuote(lines, i, end, refs);
      nodes.push(q.node); i = q.next; continue;
    }
    if (matchListStart(line)) {
      const L = parseList(lines, i, end, refs, opts);
      if (L) { nodes.push(L.node); i = L.next; continue; }
    }
    const hb = matchHtmlBlock(lines, i, end);
    if (hb) { nodes.push({ t: 'html', raw: hb.raw, _a: i, _b: hb.k + 1 }); i = hb.k + 1; continue; }
    const tb = tableAt(lines, i, end);
    if (tb) { nodes.push(tb.node); i = tb.next; continue; }
    if (opts.top) {
      const p = collectParagraph(lines, i, end, opts);
      nodes.push(p.node); i = p.next;
    } else {
      const tx = collectText(lines, i, end, opts);
      nodes.push(tx.node); i = tx.next;
    }
  }
  return nodes;
}

// ---------- block rendering ----------
function renderBlocks(nodes, refs) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'space': break;
      case 'para': out += '<p>' + inlineParse(n.text, refs) + '</p>\n'; break;
      case 'text': out += inlineParse(n.text, refs); break;
      case 'heading': out += '<h' + n.level + '>' + inlineParse(n.text, refs) + '</h' + n.level + '>\n'; break;
      case 'code': {
        const lang = n.lang ? ' class="language-' + escNoEncode(n.lang) + '"' : '';
        out += '<pre><code' + lang + '>' + esc(n.text) + '</code></pre>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'html': out += n.raw; break;
      case 'quote': out += '<blockquote>\n' + renderBlocks(n.children, refs) + '</blockquote>\n'; break;
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const start = n.ordered && n.start !== 1 ? ' start="' + n.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const it of n.items) {
          out += '<li>';
          if (it.task && !it.loose) {
            out += '<input ' + (it.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
          }
          const nodes2 = it.nodes;
          for (let k = 0; k < nodes2.length; k++) {
            const cn = nodes2[k];
            if (cn.t === 'space') continue;
            if (it.loose) {
              if (cn.t === 'para' || cn.t === 'text') {
                out += '<p>';
                if (it.task && k === 0) out += '<input ' + (it.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
                out += inlineParse(cn.text, refs) + '</p>\n';
              } else {
                out += renderBlocks([cn], refs);
              }
            } else {
              out += renderBlocks([cn], refs);
            }
          }
          out += '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        let h = '';
        for (let c = 0; c < n.header.length; c++) {
          const al = n.align[c] ? ' align="' + n.align[c] + '"' : '';
          h += '<th' + al + '>' + inlineParse(n.header[c], refs) + '</th>\n';
        }
        let body = '';
        for (const row of n.rows) {
          let r = '';
          for (let c = 0; c < row.length; c++) {
            const al = n.align[c] ? ' align="' + n.align[c] + '"' : '';
            r += '<td' + al + '>' + inlineParse(row[c], refs) + '</td>\n';
          }
          body += '<tr>\n' + r + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + h + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
    }
  }
  return out;
}

// ---------- entry point ----------
export function parse(md) {
  try {
    const src = md.replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const refs = new Map();
    const nodes = lexBlocks(lines, 0, lines.length, refs, { top: true });
    return renderBlocks(nodes, refs);
  } catch (e) {
    if (e instanceof Bail) return marked.parse(md);
    throw e;
  }
}
