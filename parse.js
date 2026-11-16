// A fresh scanner for CommonMark and GFM with marked-compatible HTML.
// Block output is a flat stream; only inline text waits for reference definitions.

const punct = /[\p{P}\p{S}]/u;
const escapable = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const entityTail = /^(?:[A-Za-z0-9_]+|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/;
const escapeChars = /[&<>"']/;
const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHTML(s, all = false, numbers = false) {
  if (!escapeChars.test(s)) return s;
  const re = numbers ? /&#([0-9]{1,7});|&#[xX]([0-9a-fA-F]{1,6});|[&<>"']/g : /[&<>"']/g;
  return s.replace(re, (match, a, b, at) => {
    if (numbers && match.length > 1) {
      let n = parseInt(a || b, a ? 10 : 16);
      if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) n = 0xfffd;
      const ch = String.fromCodePoint(n);
      return replacements[ch] || ch;
    }
    if (!numbers) at = a;
    if (match === '&' && !all && entityTail.test(s.slice(at + 1))) return '&';
    return replacements[match];
  });
}

function unslash(s) {
  return s.indexOf('\\') < 0 ? s : s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function linkKey(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function href(s, all = false) {
  try { return escapeHTML(encodeURI(s).replace(/%25/g, '%'), all); }
  catch { return null; }
}

function white(ch) {
  if (ch === undefined) return true;
  const c = ch.charCodeAt(0);
  return c < 128 ? c === 32 || (c >= 9 && c <= 13) : /\s/u.test(ch);
}
function punctuation(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) : punct.test(ch);
}
function markerPunctuation(ch, marker) { return !(marker === '*' && ch === '~') && punctuation(ch); }
function openingPunctuation(ch) { return ch !== '*' && punctuation(ch); }

function bracketEnd(s, start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 60) {
      const tag = htmlTag.exec(s.slice(i));
      const end = s.indexOf('>', i + 1);
      if (tag) { i += tag[0].length - 1; continue; }
      if (end >= 0 && (angleScheme.test(s.slice(i + 1, end)) || angleMail.test(s.slice(i + 1, end)))) { i = end; continue; }
    }
    if (c === 96) {
      let n = 1;
      while (s.charCodeAt(i + n) === 96) n++;
      const candidate = s.indexOf(']', i + n);
      if (n > 1 && candidate >= 0) {
        let runs = 0;
        for (let k = i; k < candidate; k++) if (s[k] === '`' && s[k - 1] !== '`' && s[k - 1] !== '\\') runs++;
        if (runs >= 2 && runs % 2 === 0) continue;
      }
      let q = i + n;
      for (;;) {
        q = s.indexOf('`', q);
        if (q < 0) break;
        let m = 1;
        while (s.charCodeAt(q + m) === 96) m++;
        if (m === n) { i = q + m - 1; break; }
        q += m;
      }
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93 && --depth === 0) return i;
  }
  return -1;
}

function destination(s, p, definition = false) {
  const begin = p;
  if (s[p] === '<') {
    if (definition) {
      let end = -1;
      for (let i = p + 1; i < s.length && s[i] !== '\n'; i++) {
        if (s[i] === '\\') i++;
        else if (s[i] === '>') {
          end = i;
          let q = i + 1;
          while (s[q] === ' ' || s[q] === '\t') q++;
          if (!s[q] || s[q] === '\n') break;
          const title = q > i + 1 ? titleAt(s, q) : null;
          if (title) {
            q = title.end;
            while (s[q] === ' ' || s[q] === '\t') q++;
            if (!s[q] || s[q] === '\n') break;
          }
        }
      }
      return end < 0 ? null : { value: s.slice(p + 1, end), end: end + 1 };
    }
    p++;
    const a = p;
    while (p < s.length) {
      if (s[p] === '\\' && p + 1 < s.length) { p += 2; continue; }
      if (s[p] === '<' || s[p] === '\n') return null;
      if (s[p] === '>') return { value: s.slice(a, p), end: p + 1 };
      p++;
    }
    return null;
  }
  let level = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === '\\' && p + 1 < s.length && escapable.test(s[p + 1])) { p += 2; continue; }
    if (c === '(') level++;
    else if (c === ')') { if (!level) break; level--; }
    else if (/[ \t\n\r]/.test(c) || c.charCodeAt(0) < 32) break;
    p++;
  }
  if (level || (definition && p === begin)) return null;
  return { value: s.slice(begin, p), end: p };
}

function titleAt(s, p) {
  const open = s[p];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  const begin = ++p;
  while (p < s.length) {
    if (s[p] === '\\') { p += 2; continue; }
    if (s[p] === '\n' && /^[ \t]*\n/.test(s.slice(p + 1))) return null;
    if (s[p] === close) return { value: s.slice(begin, p), end: p + 1 };
    if (open === '(' && s[p] === '(') return null;
    p++;
  }
  return null;
}

function inlineTarget(s, p) {
  p++;
  while (p < s.length && /[ \t\n\r]/.test(s[p])) p++;
  const dest = destination(s, p);
  if (!dest) return null;
  p = dest.end;
  const beforeSpace = p;
  while (p < s.length && /[ \t\n\r]/.test(s[p])) p++;
  let title = null;
  if (p > beforeSpace && s[p] !== ')') {
    const t = titleAt(s, p);
    if (!t) return null;
    title = t.value;
    p = t.end;
    while (p < s.length && /[ \t\n\r]/.test(s[p])) p++;
  }
  if (s[p] !== ')') return null;
  return { url: unslash(dest.value), title: title === null ? null : unslash(title), end: p + 1 };
}

const htmlTag = /^(?:<\/[A-Za-z][A-Za-z0-9-]*\s*>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<!--(?:>|->|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Z][\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;
const angleScheme = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
const angleMail = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const boundary = /[\\<!\[\]`*_~\n&]|(?:https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:)|[A-Za-z0-9._+-]+@/gi;
const extendedMail = /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/;
const extendedURL = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+/i;
const inlineSpecial = /[\\<!\[\]`*_~\n&@]|(?:https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:)/i;
const maskBoundary = /[\\`<\[]/g;

function trimURL(s) {
  for (;;) {
    const previous = s;
    s = s.replace(/[?!.,:*_~]+$/, '');
    const entity = /&[A-Za-z0-9]+;$/.exec(s);
    if (entity) s = s.slice(0, entity.index);
    else s = s.replace(/;+$/, '');
    let matchedClosing = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') {
        const closing = s.indexOf(')', i + 1);
        if (closing < 0) { s = s.slice(0, i); break; }
        matchedClosing = closing;
        i = closing;
      }
    }
    let end = s.length;
    while (s[end - 1] === ')' && end - 1 > matchedClosing) end--;
    s = s.slice(0, end);
    if (s === previous) return s;
  }
}

function labelAllowed(s) {
  let runs = 0, last = -1, length = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') {
      last = i; length = 1;
      while (s[i + length] === '`') length++;
      runs++; i += length - 1;
    }
  }
  return runs % 2 === 0 || (length >= 2 && last + length === s.length);
}

function referenceTarget(s, close, label, ctx) {
  let key = label, end = close + 1;
  if (s[end] === '[') {
    const r = bracketEnd(s, end + 1);
    if (r >= 0 && !/(^|[^\\])\[/.test(s.slice(end + 1, r))) { key = s.slice(end + 1, r) || label; end = r + 1; }
  }
  const ref = ctx.refs[linkKey(key)];
  return ref ? { url: ref.url, title: ref.title, end } : null;
}

function containsLink(s, ctx) {
  for (let p = 0; p < s.length; p++) {
    if (s[p] === '\\') { p++; continue; }
    if (s[p] === '`') {
      let n = 1;
      while (s[p + n] === '`') n++;
      let at = p + n;
      while ((at = s.indexOf('`', at)) >= 0) {
        let size = 1;
        while (s[at + size] === '`') size++;
        if (size === n) { p = at + size - 1; break; }
        at += size;
      }
      continue;
    }
    if (s[p] === '<') {
      const tag = htmlTag.exec(s.slice(p));
      if (tag) { p += tag[0].length - 1; continue; }
      const at = s.indexOf('>', p + 1);
      if (at >= 0 && (angleScheme.test(s.slice(p + 1, at)) || angleMail.test(s.slice(p + 1, at)))) { p = at; continue; }
    }
    if (s[p] !== '[') continue;
    const q = bracketEnd(s, p + 1);
    if (q < 0) continue;
    const label = s.slice(p + 1, q);
    const target = s[q + 1] === '(' ? inlineTarget(s, q + 1) : referenceTarget(s, q, label, ctx);
    if (s[p - 1] === '!') { p = target ? target.end - 1 : q; continue; }
    if (target && labelAllowed(label)) return true;
  }
  return false;
}

function emailAt(s) {
  const m = extendedMail.exec(s);
  return m && /[A-Za-z0-9]$/.test(m[0]) ? m : null;
}

function referenceMask(s, ctx) {
  if (ctx.refCount === 0) return s;
  const pieces = [];
  let copied = 0, p = 0;
  while ((p = s.indexOf('[', p)) >= 0) {
    if (s[p - 1] === '\\') { p++; continue; }
    const close = bracketEnd(s, p + 1);
    if (close < 0) { p++; continue; }
    const label = s.slice(p + 1, close);
    let key = label, end = close + 1, full = false;
    if (s[end] === '[') {
      const next = bracketEnd(s, end + 1);
      if (next >= 0) { key = s.slice(end + 1, next); end = next + 1; full = true; }
    }
    const ref = ctx.refs[linkKey(key)];
    if (!ref && !label.includes('[')) { p = end; continue; }
    if (containsLink(label.replace(/\\([\[\]])/g, '$1'), ctx) || (!full && /(^|[^\\])\[/.test(label))) { p++; continue; }
    if (ref) {
      const begin = s[p - 1] === '!' ? p - 1 : p;
      pieces.push(s.slice(copied, begin), '[' + 'a'.repeat(end - begin - 2) + ']');
      copied = end;
    }
    p = end;
  }
  if (!pieces.length) return s;
  pieces.push(s.slice(copied));
  return pieces.join('');
}

function emphasisMask(s, ctx) {
  s = referenceMask(s, ctx);
  const pieces = [];
  let copied = 0, i = 0;
  while (i < s.length) {
    maskBoundary.lastIndex = i;
    const candidate = maskBoundary.exec(s);
    if (!candidate) break;
    i = candidate.index;
    const c = s[i];
    let begin = i, end = i, escaped = false;
    if (c === '\\') {
      if (s[i + 1] && escapable.test(s[i + 1])) { end = i + 2; escaped = true; }
      else { i += 2; continue; }
    } else if (c.charCodeAt(0) === 96) {
      let size = 1;
      while (s[i + size] === c) size++;
      let q = i + size;
      while ((q = s.indexOf(c, q)) >= 0) {
        let run = 1;
        while (s[q + run] === c) run++;
        if (size === run) { end = q + run; break; }
        q += run;
      }
      if (end === i) { i += size; continue; }
    } else if (c === '<' && !white(s[i + 1])) {
      const q = s.indexOf('>', i + 1);
      const nested = s.indexOf('<', i + 1);
      if (q >= 0 && (nested < 0 || nested > q)) end = q + 1;
    } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const opening = i + (c === '!' ? 1 : 0);
      let q = opening + 1;
      for (; q < s.length; q++) {
        if (s[q] === '\\') q++;
        else if (s.charCodeAt(q) === 96) {
          let size = 1;
          while (s.charCodeAt(q + size) === 96) size++;
          let at = q + size, matched = false;
          while ((at = s.indexOf(s[q], at)) >= 0) {
            let run = 1;
            while (s.charCodeAt(at + run) === 96) run++;
            if (size === run) { q = at + run - 1; matched = true; break; }
            at += run;
          }
          if (!matched) { q = -1; break; }
        } else if (s[q] === '[') { q = -1; break; }
        else if (s[q] === ']') break;
      }
      if (q >= s.length) q = -1;
      if (q >= 0) {
        const label = s.slice(opening + 1, q);
        let target = -1;
        if (s[q + 1] === '(') {
          let level = 1;
          for (let at = q + 2; at < s.length; at++) {
            if (s[at] === '\\') at++;
            else if (s[at] === '(') { if (++level > 2) break; }
            else if (s[at] === ')' && --level === 0) { target = at; break; }
          }
        }
        if (target >= 0) { begin = opening; end = target + 1; }

      }
    }
    if (end > i) {
      pieces.push(s.slice(copied, begin), escaped ? '++' : '[' + 'a'.repeat(end - begin - 2) + ']');
      copied = i = end;
    } else i++;
  }
  if (!pieces.length) return s;
  pieces.push(s.slice(copied));
  return pieces.join('');
}

function emphasisEnd(s, mask, p, n, ch, singleKind = false, prev) {
  let balance = n, ignored = 0, q = p + n, original = n, start = p;
  while (start > 0 && mask[start - 1] === ch) { start--; original++; }
  const partial = prev === ch;
  let contextStart = start;
  while (contextStart > 0 && mask[contextStart - 1] === ch) contextStart--;
  const prefix = mask[contextStart - 1];
  const restricted = !white(prefix) && (markerPunctuation(s[p + n], ch) || (ch === '*' && !punctuation(prefix)));
  while ((q = mask.indexOf(ch, q)) >= 0) {
    let currentSize = 1;
    while (mask[q + currentSize] === ch) currentSize++;
    if (!singleKind && !(ch === '_' && n >= 2 && currentSize >= 2)) {
      const other = ch === '*' ? '_' : '*';
      let r = p + n;
      while ((r = mask.indexOf(other, r)) >= 0 && r < q) {
        let size = 1;
        while (mask[r + size] === other) size++;
        if (size >= 2) {
          const before = mask[r - 1], after = mask[r + size];
          const left = !white(after) && (!markerPunctuation(after, ch) || white(before) || markerPunctuation(before, ch));
          const right = !white(before) && (!markerPunctuation(before, ch) || white(after) || markerPunctuation(after, ch));
          const open = other === '_' ? left && (!right || markerPunctuation(before, ch)) : left;
          let nested = open ? emphasisEnd(s, mask, r, size, other, true, before) : null;
          if (!nested && open && ch === '_' && n === 1 && currentSize === 1) {
            let close = r + size;
            while ((close = mask.indexOf(other, close)) >= 0) {
              let run = 1;
              while (mask[close + run] === other) run++;
              if (run >= 2) {
                const firstInner = mask.indexOf(ch, r + size);
                const nextInner = mask.indexOf(ch, firstInner + 1);
                if (firstInner === q && (nextInner < 0 || nextInner >= close)) nested = { end: close + run, use: 2 };
                break;
              }
              close += run;
            }
          }
          if (nested && nested.use === 2) {
            let overlap = false;
            if (ch === '_' && n === 1) {
              const firstInner = mask.indexOf(ch, r + size);
              const extra = mask.indexOf(ch, firstInner + 1);
              overlap = extra >= 0 && extra < nested.end - size;
            } else if (ch === '*') {
              let inner = r + size;
              while ((inner = mask.indexOf(ch, inner)) >= 0 && inner < nested.end - size) {
                if (mask[inner + 1] === ch) { overlap = true; break; }
                inner++;
              }
            }
            if (overlap) { r += size; continue; }
            if (nested.end > q) { q = nested.end; break; }
            r = nested.end; continue;
          }
        }
        r += size;
      }
      if (mask[q] !== ch) continue;
    }
    let length = 1;
    while (mask[q + length] === ch) length++;
    const before = mask[q - 1], after = mask[q + length];
    const left = !white(after) && (!markerPunctuation(after, ch) || white(before) || markerPunctuation(before, ch));
    const right = !white(before) && (!markerPunctuation(before, ch) || white(after) || markerPunctuation(after, ch));
    const open = ch === '_' ? left && (!right || markerPunctuation(before, ch)) : left;
    const close = ch === '_' ? right && (!left || markerPunctuation(after, ch)) : right;
    if (open && !close) balance += length;
    else if (close) {
      if (partial && open && ch === '*') return null;
      if ((open || restricted) && original % 3 && (original + length) % 3 === 0) ignored += length;
      else {
        balance -= length;
        if (balance <= 0) {
          const used = Math.min(length, length + balance + ignored);
          if (used > 0) return { end: q + used, use: Math.min(n, used) % 2 ? 1 : 2 };
        }
      }
    }
    q += length;
  }
  return null;
}

function validDomain(url) {
  return /^(?:https?:\/\/|ftp:\/\/|www\.)[A-Za-z0-9-]/i.test(url);
}

function delEnd(mask, p, size) {
  let balance = 1, q = p + size;
  while ((q = mask.indexOf('~', q)) >= 0) {
    let run = 1;
    while (mask[q + run] === '~') run++;
    if (run === size) {
      const before = mask[q - 1], after = mask[q + run];
      const open = !white(after) && (!punctuation(after) || white(before) || punctuation(before));
      const close = !white(before) && (!punctuation(before) || white(after) || punctuation(after));
      if (open && !close) balance++;
      else if (close && --balance === 0) return q + run;
    }
    q += run;
  }
  return -1;
}

function inline(s, ctx, inLink = ctx.inLink || false, plain = false, rawStart = ctx.raw || false) {
  if (!inlineSpecial.test(s)) {
    ctx.inLink = inLink; ctx.raw = rawStart;
    return rawStart ? s : escapeHTML(s, false, true);
  }
  const parts = [];
  let raw = rawStart;
  const mask = /[*_~]/.test(s) ? emphasisMask(s, ctx) : s;
  let p = 0, prev;
  const emit = value => { parts.push(value); prev = undefined; };
  const text = value => {
    parts.push(raw ? value : escapeHTML(value, false, true));
    let end = value.length - 1;
    while (value[end] === '_') end--;
    if (end < 0) return;
    const last = value.charCodeAt(end);
    prev = last >= 0xdc00 && last <= 0xdfff ? value.slice(end - 1) : value[end];
  };
  while (p < s.length) {
    const c = s[p];
    if (c === '\\') {
      if (s[p + 1] === '\n') {
        emit(plain ? '' : '<br>');
        p += 2;
        while (s[p] === ' ' || s[p] === '\t') p++;
        continue;
      }
      if (s[p + 1] && escapable.test(s[p + 1])) {
        emit(escapeHTML(s[p + 1], true)); p += 2; continue;
      }
      text(c); p++; continue;
    }
    if (c === '\n') {
      let spaces = 0;
      for (let q = p - 1; q >= 0 && s[q] === ' '; q--) spaces++;
      if (spaces >= 2 && p + 1 < s.length) {
        if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] = parts[parts.length - 1].replace(/ +$/, '');
        emit(plain ? '' : '<br>');
        p++;
        while (s[p] === ' ' || s[p] === '\t') p++;
      } else {
        if (!s.startsWith('<!--', p + 1) && !s.startsWith('<?', p + 1)) text('\n');
        p++;
      }
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[p + n] === '`') n++;
      let q = p + n, end = -1;
      while ((q = s.indexOf('`', q)) >= 0) {
        let m = 1;
        while (s[q + m] === '`') m++;
        if (m === n) { end = q; break; }
        q += m;
      }
      if (end >= 0) {
        let body = s.slice(p + n, end).replace(/\n/g, ' ');
        if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) body = body.slice(1, -1);
        const value = escapeHTML(body, true);
        emit(plain ? value : '<code>' + value + '</code>');
        p = end + n; continue;
      }
      text(s.slice(p, p + n)); p += n; continue;
    }
    if (c === '<') {
      const q = s.indexOf('>', p + 1);
      if (q >= 0) {
        const body = s.slice(p + 1, q);
        if (angleScheme.test(body) || angleMail.test(body)) {
          const address = angleScheme.test(body) ? body : 'mailto:' + body;
          const h = href(address, true);
          const label = escapeHTML(body, true);
          if (h !== null) {
            emit(plain ? label : '<a href="' + h + '">' + label + '</a>');
            p = q + 1; continue;
          }
        }
      }
      const tag = htmlTag.exec(s.slice(p));
      if (tag) {
        const value = tag[0];
        const name = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(value);
        if (name) {
          const lower = name[2].toLowerCase();
          if (lower === 'a') {
            if (name[1] && /^<\/a>/i.test(value)) inLink = false;
            else if (value[2] === ' ') inLink = true;
          }
          if ((lower === 'pre' || lower === 'code' || lower === 'kbd' || lower === 'script') && (name[1] || /[\s>]/.test(value[name[0].length]))) raw = !name[1];
        }
        emit(value); p += value.length; continue;
      }
      text(c); p++; continue;
    }
    if (c === '[' || (c === '!' && s[p + 1] === '[')) {
      const image = c === '!';
      const begin = p + (image ? 2 : 1);
      const close = bracketEnd(s, begin);
      if (close >= 0) {
        const rawLabel = s.slice(begin, close);
        const label = rawLabel.replace(/\\([\[\]])/g, '$1');
        let target = null;
        if (s[close + 1] === '(') target = inlineTarget(s, close + 1);
        if (!target) target = referenceTarget(s, close, rawLabel, ctx);
        if (target && labelAllowed(label)) {
          // An explicit nested link wins over its containing bracket pair.
          const nested = !image && containsLink(label, ctx);
          if (!nested) {
            const inner = inline(label, ctx, !image || inLink, image || plain, raw);
            raw = ctx.raw || false;
            const h = href(target.url);
            if (h !== null) {
              const t = target.title === null ? '' : ' title="' + escapeHTML(target.title) + '"';
              if (image) emit(plain ? inner : '<img src="' + h + '" alt="' + escapeHTML(inner) + '"' + t + '>');
              else emit(plain ? inner : '<a href="' + h + '"' + t + '>' + inner + '</a>');
              p = target.end; continue;
            }
          }
        }
      }
      text(c); if (close >= 0) prev = undefined; p++; continue;
    }
    if (c === '*' || c === '_') {
      let n = 1;
      while (s[p + n] === c) n++;
      let before = prev, first = p;
      while (first > 0 && mask[first - 1] === c) first--;
      if (first < p) before = mask[first - 1];
      if (c === '*' && before === '_') {
        let at = first - 1;
        while (at > 0 && mask[at - 1] === '_') at--;
        before = mask[at - 1];
      }
      const priorMarker = first < p && (before === '*' || before === '_');
      const after = s[p + n];
      const left = !white(after) && (!(after !== '~' && punctuation(after)) || white(before) || openingPunctuation(before) || priorMarker);
      const right = !white(before) && (!markerPunctuation(before, c) || white(after) || (after !== '~' && punctuation(after)));
      const open = c === '_' ? left && (!right || openingPunctuation(before) || priorMarker) : left;
      const match = open ? emphasisEnd(s, mask, p, n, c, false, prev) : null;
      if (match) {
        const name = match.use === 2 ? 'strong' : 'em';
        const content = inline(s.slice(p + match.use, match.end - match.use), ctx, inLink, plain, raw);
        inLink = ctx.inLink || false; raw = ctx.raw || false;
        emit(plain ? content : '<' + name + '>' + content + '</' + name + '>');
        p = match.end; continue;
      }
      if (c === '_' && !inLink) {
        const email = emailAt(s.slice(p));
        if (email) {
          const value = email[0];
          emit(plain ? escapeHTML(value) : '<a href="mailto:' + escapeHTML(value) + '">' + escapeHTML(value) + '</a>');
          p += value.length; continue;
        }
      }
      text(c); p++; continue;
    }
    if (c === '~') {
      let size = 1;
      while (s[p + size] === '~') size++;
      const before = prev;
      const after = s[p + size];
      const open = size <= 2 && !white(after) && (!punctuation(after) || white(before) || openingPunctuation(before));
      const end = open ? delEnd(mask, p, size) : -1;
      if (end >= 0) {
        const content = inline(s.slice(p + size, end - size), ctx, inLink, plain, raw);
        inLink = ctx.inLink || false; raw = ctx.raw || false;
        emit(plain ? content : '<del>' + content + '</del>');
        p = end; continue;
      }
      text(s.slice(p, p + size)); p += size; continue;
    }
    if (!inLink && /[A-Za-z0-9._+-]/.test(c)) {
      const tail = s.slice(p);
      const scheme = /^(mailto:|xmpp:)/.exec(tail);
      if (scheme) {
        const mail = emailAt(tail.slice(scheme[0].length));
        if (mail) {
          let value = scheme[0] + mail[0];
          if (scheme[1] === 'xmpp:') {
            const resource = /^\/[A-Za-z0-9.@]+/.exec(tail.slice(value.length));
            if (resource) value += trimURL(resource[0]);
          }
          emit(plain ? escapeHTML(value) : '<a href="' + escapeHTML(value) + '">' + escapeHTML(value) + '</a>');
          p += value.length; continue;
        }
      }
      const url = extendedURL.exec(tail);
      if (url && (!/^www\./i.test(url[0]) || (url[0].startsWith('www.') && (white(prev) || prev === '(' || prev === '*' || s[p - 1] === '_' || prev === '~')))) {
        const value = trimURL(url[0]);
        if (value && validDomain(value)) {
          const h = href(/^www\./i.test(value) ? 'http://' + value : value, true);
          const label = escapeHTML(value, true);
          if (h !== null) { emit(plain ? label : '<a href="' + h + '">' + label + '</a>'); p += value.length; continue; }
        }
      }
      const email = emailAt(tail);
      if (email) {
        const value = email[0];
        emit(plain ? escapeHTML(value) : '<a href="mailto:' + escapeHTML(value) + '">' + escapeHTML(value) + '</a>');
        p += value.length; continue;
      }
    }
    boundary.lastIndex = p + 1;
    const hit = boundary.exec(s);
    const end = hit ? hit.index : s.length;
    text(s.slice(p, end));
    p = end;
  }
  const result = parts.join('');
  ctx.inLink = inLink; ctx.raw = raw;
  return result;
}

function indentation(s) {
  let column = 0, at = 0;
  while (at < s.length) {
    if (s[at] === ' ') column++;
    else if (s[at] === '\t') column += 4 - column % 4;
    else break;
    at++;
  }
  return { column, at };
}

function removeIndent(s, width, fence = false) {
  let column = 0, at = 0;
  while (column < width && at < s.length) {
    if (s[at] === ' ') column++;
    else if (s[at] === '\t') column += 4 - column % 4;
    else break;
    at++;
  }
  return (column > width && !fence ? ' '.repeat(column - width) : '') + s.slice(at);
}

function removeListIndent(s, width) {
  const ind = indentation(s);
  return ' '.repeat(Math.max(0, ind.column - width)) + s.slice(ind.at);
}

const thematic = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const headingLine = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/;
const fenceLine = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const setextLine = /^ {0,3}(=+|-+)[ \t]*$/;
const listLine = /^( {0,3})(?:([*+-])|([0-9]{1,9})([.)]))([ \t]+|$)(.*)$/;
const blockNames = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;

function fenceAt(line) {
  const m = fenceLine.exec(line);
  return m && (m[2][0] !== '`' || !m[3].includes('`')) ? m : null;
}

function htmlBlockAt(line, paragraph = false) {
  const value = line.replace(/^ {0,3}/, '');
  if (value[0] !== '<') return null;
  const pre = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(value);
  if (pre) return { end: new RegExp('</' + pre[1] + '\\s*>', 'i') };
  if (value.startsWith('<!--')) return { end: /-->/ };
  if (value.startsWith('<?')) return { end: /\?>/ };
  if (/^<![A-Z]/.test(value)) return { end: />/ };
  if (value.startsWith('<![CDATA[')) return { end: /\]\]>/ };
  const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(value);
  if (name && blockNames.test(name[1])) return { end: null };
  if (!paragraph) {
    const tag = htmlTag.exec(value);
    if (tag && /^[ \t]*$/.test(value.slice(tag[0].length))) return { end: null };
  }
  return null;
}

function interrupt(line, paragraph = true) {
  const first = line.charCodeAt(0);
  if (first !== 32 && first !== 35 && first !== 42 && first !== 43 && first !== 45 && first !== 60 && first !== 62 && first !== 95 && first !== 96 && first !== 126 && !(first >= 48 && first <= 57)) return false;
  if (thematic.test(line) || headingLine.test(line) || /^ {0,3}>/.test(line) || fenceAt(line)) return true;
  const item = listLine.exec(line);
  if (item && (!paragraph || ((!item[3] || Number(item[3]) === 1) && item[6].trim() !== ''))) return true;
  return !!htmlBlockAt(line, paragraph);
}

function definitionAt(lines, i) {
  let stop = i + 1;
  while (stop < lines.length && lines[stop].trim() !== '') stop++;
  const s = lines.slice(i, stop).join('\n');
  const begin = /^ {0,3}\[/.exec(s);
  if (!begin) return null;
  let p = begin[0].length, endLabel = -1;
  for (; p < s.length; p++) {
    if (s[p] === '\\') { p++; continue; }
    if (s[p] === '[') return null;
    if (s[p] === ']') { endLabel = p; break; }
  }
  if (endLabel < 0 || s[endLabel + 1] !== ':') return null;
  const key = linkKey(s.slice(begin[0].length, endLabel));
  if (!key || key.length > 999) return null;
  p = endLabel + 2;
  while (s[p] === ' ' || s[p] === '\t') p++;
  if (s[p] === '\n') {
    p++;
    while (s[p] === ' ' || s[p] === '\t') p++;
  }
  const dest = destination(s, p, true);
  if (!dest) return null;
  p = dest.end;
  const destLineEnd = s.indexOf('\n', p);
  const urlEnd = destLineEnd < 0 ? s.length : destLineEnd;
  let q = p;
  while (s[q] === ' ') q++;
  let title = null, end = q;
  if (q > p && s[q] && s[q] !== '\n') {
    const t = titleAt(s, q);
    if (!t) return null;
    end = t.end;
    while (s[end] === ' ') end++;
    if (s[end] && s[end] !== '\n') return null;
    title = unslash(t.value);
  } else if (s[q] === '\n') {
    let next = q + 1;
    while (s[next] === ' ' || s[next] === '\t') next++;
    const t = titleAt(s, next);
    if (t) {
      let after = t.end;
      while (s[after] === ' ') after++;
      if (!s[after] || s[after] === '\n') { title = unslash(t.value); end = after; }
      else end = urlEnd;
    } else end = urlEnd;
  } else if (s[q]) return null;
  const consumed = s.slice(0, end).split('\n').length;
  return { key, url: unslash(dest.value), title, next: i + consumed };
}

function tableCells(s) {
  s = s.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '|') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
    if (slashes % 2) continue;
    cells.push(s.slice(start, i).trim().replace(/\\\|/g, '|'));
    start = i + 1;
  }
  cells.push(s.slice(start).trim().replace(/\\\|/g, '|'));
  return cells;
}

function quoteContent(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  let value = line.slice(m[0].length);
  if (/^[ \t]*\t/.test(value)) {
    let at = 0, column = m[0].length;
    while (value[at] === ' ' || value[at] === '\t') { column += value[at] === '\t' ? 4 - column % 4 : 1; at++; }
    value = ' '.repeat(column - m[0].length) + value.slice(at);
  }
  if (value[0] === ' ') value = value.slice(1);
  return value;
}

function updateTip(line, tip) {
  let value = line, depth = 0;
  for (;;) {
    const q = quoteContent(value);
    if (q === null) break;
    value = q; depth++;
  }
  if (tip.fence && depth < tip.depth) tip.fence = null;
  if (tip.html && depth < tip.depth) tip.html = null;
  if (tip.fence) {
    const close = fenceLine.exec(value);
    if (close && close[2][0] === tip.fence[0] && close[2].length >= tip.fence.length && /^ *$/.test(close[3])) tip.fence = null;
    tip.para = false; return;
  }
  if (tip.html) {
    if (tip.html.end ? tip.html.end.test(value) : value.trim() === '') tip.html = null;
    tip.para = false; return;
  }
  let marker;
  while ((marker = listLine.exec(value))) value = marker[6];
  const f = fenceAt(value);
  if (f) { tip.fence = f[2]; tip.depth = depth; tip.para = false; return; }
  if (value.trim() !== '' && indentation(value).column >= 4) return;
  const html = htmlBlockAt(value);
  if (html) {
    tip.html = html.end && html.end.test(value) ? null : html;
    tip.depth = depth; tip.para = false; return;
  }
  if (value.trim() === '' || headingLine.test(value) || thematic.test(value)) tip.para = false;
  else tip.para = true;
}

function blocks(src, ctx, out, paragraphBox, container = false) {
  if (!src) return;
  const ended = src.endsWith('\n');
  const lines = src.split('\n');
  if (ended) lines.pop();
  const count = lines.length;
  const initial = out.length;
  let i = 0;
  while (i < count) {
    const line = lines[i];
    if (line.trim() === '') {
      let j = i + 1;
      while (j < count && lines[j].trim() === '') j++;
      if (out.length > initial && j < count) paragraphBox.gaps = true;
      i = j; continue;
    }
    const ind = indentation(line);
    if (ind.column >= 4) {
      const body = [], start = i;
      let last = i;
      while (i < count) {
        const l = lines[i];
        if (l.trim() === '') body.push(removeIndent(l, 4));
        else if (indentation(l).column >= 4) { body.push(removeIndent(l, 4)); last = i + 1; }
        else break;
        i++;
      }
      body.length = last - start;
      out.push('<pre><code>' + escapeHTML(body.join('\n') + '\n', true) + '</code></pre>\n');
      i = last; continue;
    }
    const f = fenceAt(line);
    if (f) {
      const body = [];
      const marker = f[2], width = marker[0] === '`' ? f[1].length : 0;
      const lang = unslash(f[3].trim()).split(/\s/, 1)[0];
      i++;
      for (; i < count; i++) {
        const close = fenceLine.exec(lines[i]);
        if (close && close[2][0] === marker[0] && close[2].length >= marker.length && /^ *$/.test(close[3])) { i++; break; }
        body.push(width ? removeIndent(lines[i], width, true) : lines[i]);
      }
      let code = body.join('\n');
      if (code) code = code.replace(/\n$/, '') + '\n';
      out.push('<pre><code' + (lang ? ' class="language-' + escapeHTML(lang) + '"' : '') + '>' + escapeHTML(code, true) + '</code></pre>\n');
      continue;
    }
    const heading = headingLine.exec(line);
    if (heading) {
      let body = (heading[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      if (/^#+$/.test(body)) body = '';
      out.push('<h' + heading[1].length + '>', [body, null], '</h' + heading[1].length + '>\n');
      i++; continue;
    }
    if (thematic.test(line)) { out.push('<hr>\n'); i++; continue; }
    if (quoteContent(line) !== null) {
      const body = [], tip = { para: false, fence: null, depth: 0 }, lazy = new Set();
      let lazyActive = false, suppressTail = false;
      for (; i < count; i++) {
        const quoted = quoteContent(lines[i]);
        if (quoted !== null) { body.push(quoted); updateTip(quoted, tip); lazyActive = false; continue; }
        if (!tip.para || (lines[i].trim() === '' && !(i === count - 1 && !ended && lines[i] !== '')) || interrupt(lines[i]) || listLine.test(lines[i])) break;
        if (lines[i].trim() === '') suppressTail = !lazyActive;
        else lazyActive = true;
        const value = setextLine.test(lines[i]) ? '    ' + lines[i].trimStart() : lines[i];
        lazy.add(body.length);
        body.push(value); updateTip(value, tip); tip.para = true;
      }
      out.push('<blockquote>\n');
      blocks(body.join('\n'), ctx, out, { wrap: true, gaps: false }, { lazy, suppressTail });
      out.push('</blockquote>\n');
      continue;
    }
    const firstItem = listLine.exec(line);
    if (firstItem) {
      const ordered = !!firstItem[3], kind = ordered ? firstItem[4] : firstItem[2];
      const items = [];
      let loose = false;
      while (i < count) {
        const m = listLine.exec(lines[i]);
        if (!m || !!m[3] !== ordered || (ordered ? m[4] : m[2]) !== kind || thematic.test(lines[i])) break;
        const markerWidth = m[1].length + (ordered ? m[3].length + 1 : 1);
        let expanded = '', column = markerWidth;
        for (const ch of m[5]) {
          const width = ch === '\t' ? 4 - column % 4 : 1;
          expanded += ' '.repeat(width); column += width;
        }
        const empty = m[6].trim() === '';
        const padding = empty || expanded.length > 4 ? 1 : Math.max(1, expanded.length);
        const width = markerWidth + padding;
        let first = empty ? '' : expanded.slice(padding) + m[6];
        const body = [first], tip = { para: false, fence: null, depth: 0 };
        updateTip(first, tip);
        let blanks = false, blankStart = -1;
        i++;
        for (; i < count; i++) {
          const l = lines[i];
          if (l.trim() === '') {
            if (empty && body.length === 1) break;
            if (!blanks) blankStart = i;
            body.push(''); blanks = true; continue;
          }
          const col = indentation(l).column;
          if (col >= width) {
            const value = removeListIndent(l, width);
            body.push(value); updateTip(value, tip); blanks = false; blankStart = -1; continue;
          }
          const previous = body[body.length - 1];
          const lazyFence = tip.fence && previous.trim() !== '' && !fenceAt(previous) && !headingLine.test(previous) && !thematic.test(previous) && !htmlBlockAt(previous) && indentation(previous).column < 4;
          if (blanks || listLine.test(l) || interrupt(l) || (!tip.para && !lazyFence) || (body.length === 1 && expanded.length >= 4)) break;
          const value = setextLine.test(l) ? '    ' + l.trimStart() : l;
          body.push(value); updateTip(value, tip); blanks = false;
        }
        let trailingBlank = false;
        while (body.length && body[body.length - 1].trim() === '') { if (body.length > 1) trailingBlank = true; body.pop(); }
        if (empty && i < count && lines[i].trim() === '') {
          let nextLine = i;
          while (nextLine < count && lines[nextLine].trim() === '') nextLine++;
          const nextMarker = nextLine < count ? listLine.exec(lines[nextLine]) : null;
          if (nextMarker && !!nextMarker[3] === ordered && (ordered ? nextMarker[4] : nextMarker[2]) === kind) { trailingBlank = true; i = nextLine; }
        }
        const following = i < count ? listLine.exec(lines[i]) : null;
        const separator = trailingBlank && following && !thematic.test(lines[i]) && !!following[3] === ordered && (ordered ? following[4] : following[2]) === kind;
        let content = body.join('\n').trimEnd() + (separator ? '\n' : ''), checkbox = '';
        const task = /^\[([ xX])\][ \t]+/.exec(content);
        if (!ordered && task) {
          checkbox = '<input' + (task[1].toLowerCase() === 'x' ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
          content = content.slice(task[0].length);
        }
        const itemOut = [], box = { wrap: false, gaps: false };
        blocks(content, ctx, itemOut, box, true);
        if (checkbox) {
          const firstPart = itemOut[0];
          if (Array.isArray(firstPart) && firstPart[1] === box) firstPart[2] = checkbox;
          else itemOut.unshift(checkbox);
        }
        items.push({ out: itemOut, box });
        if (box.gaps) loose = true;
        const next = i < count ? listLine.exec(lines[i]) : null;
        if (trailingBlank && next && !thematic.test(lines[i]) && !!next[3] === ordered && (ordered ? next[4] : next[2]) === kind) loose = true;
        else if (blanks && blankStart >= 0) i = blankStart;
      }
      const name = ordered ? 'ol' : 'ul', start = Number(firstItem[3]);
      out.push('<' + name + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>\n');
      for (const item of items) {
        item.box.wrap = loose;
        out.push('<li>', ...item.out, '</li>\n');
      }
      out.push('</' + name + '>\n');
      continue;
    }
    const html = htmlBlockAt(line);
    if (html) {
      const start = i;
      if (html.end) {
        for (; i < count; i++) { if (html.end.test(lines[i])) { i++; break; } }
      } else {
        for (; i < count && (lines[i].trim() !== '' || (i === count - 1 && !ended)); i++) {}
      }
      let value = lines.slice(start, i).join('\n');
      const blank = i < count && lines[i].trim() === '';
      if ((i < count || ended) && (!blank || (html.end && lines[i] !== ''))) value += '\n';
      out.push(value); continue;
    }
    if (/^ {0,3}\[/.test(line)) {
      const def = definitionAt(lines, i);
      if (def) {
        if (!Object.hasOwn(ctx.refs, def.key)) {
          ctx.refs[def.key] = { url: def.url, title: def.title };
          ctx.refCount++;
        }
        if (container && def.next < count && lines[def.next].trim() === '') paragraphBox.gaps = true;
        i = def.next; continue;
      }
    }
    if (i + 1 < count && line.includes('|') && /^[ |:-]+$/.test(lines[i + 1])) {
      const head = tableCells(line), separators = tableCells(lines[i + 1]);
      if (head.length === separators.length && separators.every(c => /^:?-+:?$/.test(c))) {
        const align = separators.map(c => c[0] === ':' ? c.endsWith(':') ? 'center' : 'left' : c.endsWith(':') ? 'right' : '');
        out.push('<table>\n<thead>\n<tr>\n');
        for (let c = 0; c < head.length; c++) out.push('<th' + (align[c] ? ' align="' + align[c] + '"' : '') + '>', [head[c], null], '</th>\n');
        out.push('</tr>\n</thead>\n');
        i += 2;
        let rows = false;
        while (i < count && !/^ *$/.test(lines[i]) && !interrupt(lines[i])) {
          if (!rows) { out.push('<tbody>'); rows = true; }
          const cells = tableCells(lines[i]);
          out.push('<tr>\n');
          for (let c = 0; c < head.length; c++) out.push('<td' + (align[c] ? ' align="' + align[c] + '"' : '') + '>', [cells[c] || '', null], '</td>\n');
          out.push('</tr>\n'); i++;
        }
        if (rows) out.push('</tbody>');
        out.push('</table>\n'); continue;
      }
    }
    const body = [line];
    i++;
    let level = 0, codeContinuation = false;
    for (; i < count; i++) {
      const l = lines[i];
      const underline = setextLine.exec(l);
      if (underline) { level = underline[1][0] === '=' ? 1 : 2; i++; break; }
      if (l.trim() === '' && (i < count - 1 || ended || (container && container.suppressTail))) {
        let next = i + 1;
        while (next < count && lines[next].trim() === '') next++;
        if (container === true && codeContinuation && next < count && indentation(lines[next]).column >= 4) {
          body.push(removeIndent(l, 4)); continue;
        }
        break;
      }
      if (interrupt(l, !(container && !paragraphBox.wrap))) break;
      const lazyIndent = container === true || (container && container.lazy && container.lazy.has(i));
      if (lazyIndent && l.trim() !== '' && indentation(l).column >= 4 && !/^ {4}=+[ \t]*$/.test(l)) {
        body.push(removeIndent(l, 4)); codeContinuation = true;
      } else if (codeContinuation && l.trim() === '') body.push(removeIndent(l, 4));
      else {
        if (codeContinuation && container) body.push('');
        body.push(l); codeContinuation = false;
      }
    }
    if (level) {
      out.push('<h' + level + '>', [body.join('\n').trim(), null], '</h' + level + '>\n');
    } else out.push([body.join('\n'), paragraphBox]);
  }
}

export function parse(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('Markdown must be a string');
  const src = markdown.includes('\r') ? markdown.replace(/\r\n?/g, '\n') : markdown;
  const ctx = { refs: Object.create(null), refCount: 0 };
  const out = [];
  blocks(src, ctx, out, { wrap: true, gaps: false });
  let result = '';
  for (let i = 0; i < out.length; i++) {
    const part = out[i];
    if (typeof part === 'string') result += part;
    else {
      const body = (part[2] || '') + inline(part[0], ctx, ctx.inLink || false, false, false);
      result += part[1] && part[1].wrap ? '<p>' + body + '</p>\n' : body;
    }
  }
  return result;
}
