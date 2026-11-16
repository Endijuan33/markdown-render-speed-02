// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 parser whose output matches
// marked 18.1.3 (default options: gfm on, breaks off, pedantic off, async off).
// Written from the CommonMark spec + GFM spec; verified against the kit oracle.
// Dependency-free ES module. parse() is stateless per call: no cross-call state.

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  src = src.replace(/\r\n?/g, '\n');
  const st = new State(src);
  const blocks = parseBlocks(st);
  return renderBlocks(blocks, st);
}

// ---------------------------------------------------------------------------
// Character classification helpers (ASCII fast paths)
// ---------------------------------------------------------------------------
function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Unicode punctuation (for emphasis flanking rules): ASCII punct + Unicode P/S categories.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isPunctCode(c);
  return UNICODE_PUNCT_RE.test(ch);
}
function isWhitespaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ';
}

// ---------------------------------------------------------------------------
// HTML escaping. marked's rule for '&': an '&' starting something that looks
// like an entity reference (&name; / &#...; / &#x...;) is left alone (named
// entities are NOT decoded, they pass through verbatim); any other '&' becomes
// &amp;. '<' -> &lt;, '>' -> &gt;. '"' is escaped only in attribute values.
// ---------------------------------------------------------------------------
function escapeText(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const r = entityAt(s, i);
      if (r !== null) { out += r.text; i = r.next; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; } // <
    if (c === 62) { out += '&gt;'; i++; continue; } // >
    if (c === 34) { out += '&quot;'; i++; continue; } // "
    if (c === 39) { out += '&#39;'; i++; continue; } // '
    out += s[i]; i++;
  }
  return out;
}
function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const r = entityAt(s, i);
      if (r !== null) { out += r.text; i = r.next; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; } // "
    out += s[i]; i++;
  }
  return out;
}

// Try to read an entity reference at s[i] (s[i] === '&').
// Returns {text, next} or null (not an entity-like sequence).
// Named entities are passed through verbatim (marked does not decode them).
// Numeric references are decoded to the character (0 and surrogates -> U+FFFD);
// out-of-range / malformed numerics return null (caller escapes the '&').
function entityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // #
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const start = j;
    let val = 0;
    let digits = 0;
    if (hex) {
      while (j < n) {
        const c = s.charCodeAt(j);
        let d = -1;
        if (c >= 48 && c <= 57) d = c - 48;
        else if (c >= 97 && c <= 102) d = c - 87;
        else if (c >= 65 && c <= 70) d = c - 55;
        else break;
        if (digits >= 6) return null;
        val = val * 16 + d; digits++; j++;
      }
    } else {
      while (j < n && isDigit(s.charCodeAt(j))) {
        if (digits >= 7) return null;
        val = val * 10 + (s.charCodeAt(j) - 48); digits++; j++;
      }
    }
    if (digits === 0 || j >= n || s.charCodeAt(j) !== 59) return null; // need ';'
    if (val > 0x10ffff) return null;
    let ch;
    if (val === 0 || (val >= 0xd800 && val <= 0xdfff)) ch = '\uFFFD';
    else ch = String.fromCodePoint(val);
    return { text: ch, next: j + 1, numeric: true };
  }
  // Named: &[A-Za-z][A-Za-z0-9]*;  (pattern only; marked does not validate the name)
  if (isAlpha(c1)) {
    let j = i + 1;
    while (j < n && isAlnum(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 59 && j > i + 1) {
      return { text: s.slice(i, j + 1), next: j + 1, numeric: false };
    }
  }
  return null;
}

// Decode entities inside a string that is going to be used as a link destination
// or title after backslash processing: named entities pass through, numerics decode.
// (Same as escapeText's entity handling but returning plain text.)
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) === 38) {
      const r = entityAt(s, i);
      if (r !== null) {
        // Named: keep verbatim; numeric: entityAt already decoded it.
        out += r.text; i = r.next; continue;
      }
      out += '&'; i++; continue;
    }
    out += s[i]; i++;
  }
  return out;
}

// cleanUrl: marked's URL normalization for hrefs.
// encodeURI, then restore %25 -> % (so %20 stays %20). Throws -> null.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// out: array of strings and delimiter objects {d, n, open, close, ot, ct}
// delims: array of indices into out (delimiter objects, in document order)
// brackets: stack of {outPos, bangPos, delimLen, active, srcPos}
function parseInline(text, refs, st) {
  const out = [];
  const delims = [];
  const brackets = [];
  let i = 0;
  const n = text.length;
  let plainStart = 0;
  // O(1) counter replacing a per-char scan:
  // openUnderscore = # of `_` delims with canOpen and n > 0
  // (email-domain `_` handling).
  let openUnderscore = 0;
  // When a link whose text had a failed multi-backtick opener
  // (failedMulti) forms, emphasis delimiters added after it are
  // invalidated by the first code span that follows (doc-09/16/28:
  // `_issue table_`, `*small release **same***`, `__issues most__`
  // stay literal when a `` `...` `` code span follows them). The
  // value is the delims length at link formation, or -1.
  let linkFailedMultiDelimLen = -1;

  const flushPlain = (end) => {
    if (end > plainStart) {
      const s = text.slice(plainStart, end);
      if (s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) {
        out.push(s);
      } else {
        out.push(s.replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
      }
    }
  };
  const pushDelim = (ch, runLen, canOpen, canClose) => {
    const obj = { d: ch, n: runLen, open: canOpen, close: canClose, ot: '', ct: '' };
    out.push(obj);
    delims.push(out.length - 1);
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    // --- backslash ---
    if (c === 92) { // \
      if (i + 1 < n) {
        const nc = text.charCodeAt(i + 1);
        if (nc === 10) { // backslash + newline = hard break
          flushPlain(i);
          out.push('<br>');
          i += 2;
          // after a hard break, leading spaces/tabs of the next line are stripped (cm-636/637)
          while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          plainStart = i;
          continue;
        }
        if (isPunctCode(nc)) {
          flushPlain(i);
          out.push(escapeText(text[i + 1]));
          i += 2; plainStart = i;
          continue;
        }
      }
      i++; // literal backslash stays in the plain run
      continue;
    }
    // --- code span ---
    if (c === 96) { // `
      // A code span opener inside a link text cannot be closed beyond
      // the link text's `]` (doc-09: `` ``url` `` inside
      // `[docs each ...](...)` must not match the `` `` `` on the next
      // line — the backticks stay literal and the link forms). The
      // bracket's close is cached on first use (findBracketClose is
      // O(n) and backticks are frequent). If a multi-backtick opener
      // already failed inside this bracket, a later single backtick
      // may not open a span across the `]` either (doc-28/L1: the
      // `` ` `` after `small`/`url` in `` ``small` `` / `` ``url` ``
      // stays literal and the link forms — only a lone single
      // backtick, cm-525, may cross).
      let limit;
      let noCross = false;
      if (brackets.length > 0 && brackets[brackets.length - 1].active) {
        const b = brackets[brackets.length - 1];
        if (b.closeIdx === undefined) b.closeIdx = findBracketClose(text, b.srcPos + 1);
        if (b.closeIdx !== -1) limit = b.closeIdx;
        noCross = !!b.failedMulti;
      }
      const res = scanCodeSpan(text, i, limit, noCross);
      if (res !== null) {
        flushPlain(i);
        out.push(res.html);
        i = res.next; plainStart = i;
        // A code span after a failedMulti link invalidates the
        // emphasis delimiters added since that link formed (see above).
        // Only clear the flag when at least one delimiter was
        // invalidated: an earlier code span (e.g. `deno`, before the
        // emphasis) must not consume it (doc-09).
        if (linkFailedMultiDelimLen !== -1) {
          let invalidated = false;
          for (let q = linkFailedMultiDelimLen; q < delims.length; q++) {
            const o = out[delims[q]];
            if (o && (o.d === '*' || o.d === '_' || o.d === '~')) {
              if (o.d === '_' && o.open && o.n > 0) openUnderscore--;
              o.open = false; o.close = false;
              invalidated = true;
            }
          }
          if (invalidated) linkFailedMultiDelimLen = -1;
        }
        continue;
      }
      // no matching closer: the whole backtick run is literal text.
      // A failed multi-backtick opener poisons later single backticks
      // in the same bracket (see above).
      let j = i + 1;
      while (j < n && text.charCodeAt(j) === 96) j++;
      if (j - i > 1 && brackets.length > 0 && brackets[brackets.length - 1].active) {
        brackets[brackets.length - 1].failedMulti = true;
      }
      i = j;
      continue;
    }
    // --- emphasis delimiters ---
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      const ch = text[i];
      let j = i + 1;
      while (j < n && text.charCodeAt(j) === c) j++;
      const runLen = j - i;
      // GFM strikethrough: a ~ run of 1 or 2 is a delimiter; a run of 3+
      // is literal text (gfm-493: ~~~not~~~ stays literal).
      if (ch === '~' && runLen > 2) { i = j; continue; }
      const before = i > 0 ? text[i - 1] : '\n';
      const after = j < n ? text[j] : '\n';
      const beforeSpace = isWhitespaceChar(before);
      const afterSpace = isWhitespaceChar(after);
      const beforePunct = isUnicodePunct(before);
      const afterPunct = isUnicodePunct(after);
      const leftFlank = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const rightFlank = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || beforePunct);
        canClose = rightFlank && (!leftFlank || afterPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flushPlain(i);
      pushDelim(ch, runLen, canOpen, canClose);
      if (ch === '_' && canOpen) openUnderscore++;
      i = j; plainStart = i;
      continue;
    }
    // --- [ bracket ---
    if (c === 91) { // [
      flushPlain(i);
      out.push('[');
      brackets.push({ outPos: out.length - 1, bangPos: -1, delimLen: delims.length, active: true, srcPos: i, hasLink: false });
      i++; plainStart = i;
      continue;
    }
    // --- ![ image ---
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) { // ![
      flushPlain(i);
      out.push('!');
      const bangPos = out.length - 1;
      out.push('[');
      brackets.push({ outPos: out.length - 1, bangPos: bangPos, delimLen: delims.length, active: true, srcPos: i + 1, hasLink: false });
      i += 2; plainStart = i;
      continue;
    }
    // --- ] link resolution ---
    if (c === 93) { // ]
      flushPlain(i);
      // record whether the bracket about to resolve had a failed
      // multi-backtick opener (for the emphasis invalidation above)
      let tbFailedMulti = false;
      let tbDelimLen = -1;
      for (let q = brackets.length - 1; q >= 0; q--) {
        if (brackets[q].active) { tbFailedMulti = !!brackets[q].failedMulti; tbDelimLen = brackets[q].delimLen; break; }
      }
      const r = tryLink(text, i, out, delims, brackets, refs);
      if (r === -1) {
        out.push(']');
        i++;
      } else {
        i = r;
        if (tbFailedMulti) linkFailedMultiDelimLen = tbDelimLen;
      }
      plainStart = i;
      // tryLink truncates delims: recompute the O(1) `_`-opener counter
      // (a `]` is rare, so a scan here is cheap).
      openUnderscore = 0;
      for (let q = 0; q < delims.length; q++) {
        const o = out[delims[q]];
        if (o && o.d === '_' && o.open && o.n > 0) openUnderscore++;
      }
      continue;
    }
    // --- < autolink / raw HTML ---
    if (c === 60) { // <
      const auto = scanAutolink(text, i);
      if (auto !== null) {
        flushPlain(i);
        out.push(auto.html);
        i = auto.next; plainStart = i;
        continue;
      }
      const tag = scanHtmlTag(text, i);
      if (tag !== null) {
        // track an inline <a> open/close across blocks: an unclosed
        // <a> suppresses later GFM autolinks until a </a> appears
        const h = tag.html;
        if (h.length >= 2 && h.charCodeAt(1) === 97) { // <a
          const nx = h.length > 2 ? h.charCodeAt(2) : 62;
          if (nx === 32 || nx === 9 || nx === 10 || nx === 62) st.inLink = true;
        } else if (h.length >= 3 && h.charCodeAt(1) === 47 && h.charCodeAt(2) === 97) { // </a
          const nx = h.length > 3 ? h.charCodeAt(3) : 62;
          if (nx === 32 || nx === 9 || nx === 10 || nx === 62) st.inLink = false;
        }
        flushPlain(i);
        out.push(tag.html);
        i = tag.next; plainStart = i;
        continue;
      }
      flushPlain(i);
      out.push('&lt;');
      i++; plainStart = i;
      continue;
    }
    // --- & entity ---
    if (c === 38) { // &
      flushPlain(i);
      const r = entityAt(text, i);
      if (r !== null) {
        out.push(r.numeric ? escapeText(r.text) : r.text);
        i = r.next;
      } else {
        out.push('&amp;');
        i++;
      }
      plainStart = i;
      continue;
    }
    // --- newline: soft / hard break ---
    if (c === 10) { // \n
      // count trailing spaces in the plain run
      let sp = 0;
      let k = i - 1;
      while (k >= plainStart && text.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flushPlain(i - sp);
        out.push('<br>');
        i++;
        // after a hard break, leading spaces/tabs of the next line are stripped (cm-636/637)
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        plainStart = i;
      } else {
        flushPlain(i);
        out.push('\n');
        i++; plainStart = i;
      }
      continue;
    }
    // --- GFM extended autolinks (www. / http(s):// / ftp:// / email) ---
    // suppressed inside an open bracket that could still form a link: a
    // URL in link text stays plain text (doc-01/04/06/09:
    // `[private https://...](...)` must not autolink the inner URL).
    // Once a link has already formed inside a bracket (hasLink), that
    // bracket can never form a link, so URLs inside it DO autolink
    // (doc-08: `https://sub.domain.example.io` inside the outer
    // bracket, after the inner link formed, autolinks).
    if ((c === 119 || c === 104 || c === 102 || isAlnum(c)) && !st.inLink) {
      // Gate the (expensive) autolink scan to word starts: the char
      // before must be start-of-text, whitespace, or punctuation
      // (same check tryGfmAutolink does first). Mid-word alphanumerics
      // can never start a URL/email, so skip the call entirely.
      const prev = i === 0 ? 32 : text.charCodeAt(i - 1);
      if (prev === 32 || prev === 9 || prev === 10 || isPunctCode(prev)) {
      // A URL inside a bracket autolinks unless that bracket will
      // form a link (doc-39). Check every active bracket: the URL is
      // inside all of them, and any one forming a link makes it link
      // text (plain). Cache each bracket's close index and will-form
      // verdict (findBracketClose and the destination parse are O(n),
      // and many URLs can sit inside one bracket).
      let suppress = false;
      for (let q = 0; q < brackets.length; q++) {
        const br = brackets[q];
        if (!br.active || br.hasLink) continue;
        if (br.closeIdx === undefined) br.closeIdx = findBracketClose(text, br.srcPos + 1);
        if (br.willForm === undefined) br.willForm = bracketWillFormLink(text, br, refs);
        if (br.willForm) { suppress = true; break; }
      }
      if (!suppress) {
      // a _ after an email domain is a closing emphasis delimiter (not
      // part of the address) when an unmatched _ opener precedes it
      const allowUnderscore = openUnderscore > 0;
      const auto = tryGfmAutolink(text, i, plainStart, allowUnderscore);
      if (auto !== null) {
        flushPlain(i);
        out.push(auto.html);
        i = auto.next; plainStart = i;
        continue;
      }
      }
      }
    }
    i++;
  }
  flushPlain(n);
  processEmphasis(delims, out, 0);
  // render: convert delim objects to strings in place, then join once
  // (a += loop over many small pieces is measurably slower).
  for (let k = 0; k < out.length; k++) {
    const item = out[k];
    if (typeof item !== 'string') {
      out[k] = item.innerSpan ? item.d.repeat(item.n) + item.ct + item.ot : item.ct + item.d.repeat(item.n) + item.ot;
    }
  }
  return out.join('');
}

// Resolve emphasis/strikethrough delimiters in delims[start..].
// delims holds indices into out; delim objects carry ot/ct tag strings.
function processEmphasis(delims, out, start) {
  // spans of emphasis already formed in this call, as [openerOutIdx, closerOutIdx]
  const spans = [];
  // a candidate span partially overlaps a formed span iff it starts inside
  // it and ends outside it (or vice versa); proper nesting is allowed
  const overlaps = (a1, b1) => {
    for (let s = 0; s < spans.length; s++) {
      const a2 = spans[s][0], b2 = spans[s][1];
      if ((a1 < a2 && a2 < b1 && b1 < b2) || (a2 < a1 && a1 < b2 && b2 < b1)) return true;
    }
    return false;
  };
  let k = start;
  while (k < delims.length) {
    const closer = out[delims[k]];
    if (!closer || closer.n <= 0 || !closer.close) { k++; continue; }
    const ch = closer.d;
    // find nearest usable opener before k
    let openerIdx = -1;
    for (let j = k - 1; j >= start; j--) {
      const o = out[delims[j]];
      if (!o || o.n <= 0 || o.d !== ch || !o.open) continue;
      if (ch === '~' && o.n !== closer.n) continue; // counts must match
      if (ch === '*' || ch === '_') {
        const odd = (o.open && o.close) || (closer.open && closer.close);
        if (odd && (o.n + closer.n) % 3 === 0 && (o.n % 3 !== 0 || closer.n % 3 !== 0)) {
          continue; // odd match: try an earlier opener
        }
      }
      // an opener whose span would partly overlap an already-formed span
      // cannot match this closer (cm-469, cm-470)
      if (overlaps(delims[j], delims[k])) continue;
      // A single `*` closer must not steal one delimiter from a `**`
      // opener when a span is already formed strictly inside the
      // candidate span: the `**` pair is reserved for a later `**`
      // closer to form <strong>, and the lone `*` stays literal
      // (doc-01: `**public as *so*other* option html**` — the `*`
      // after `other` stays literal, the outer pair forms <strong>).
      if (ch === '*' && closer.n === 1 && o.n >= 2) {
        const oPos = delims[j], cPos = delims[k];
        let inner = false;
        for (let s = 0; s < spans.length; s++) {
          if (spans[s][0] > oPos && spans[s][1] < cPos) { inner = true; break; }
        }
        if (inner) continue;
      }
      // A single `*` match is blocked when a formed <strong> span sits
      // strictly inside the candidate span, its opener can only open
      // (not close) and its closer can also open (left-flanking, i.e.
      // followed by an alphanumeric): marked then leaves the outer `*`
      // literal (doc-01/doc-07: `*...**change**in*`). If the strong
      // opener can also close (intraword, cm-411 `*foo**bar**baz*`) the
      // outer still forms <em>; a strong closer followed by space or
      // punctuation does not block either (`*foo **bar** baz*`). The
      // block applies only to `**` strong spans: a `__` strong span
      // whose closer follows a code span does not block (F3/doc-18/29:
      // `*foo __bar `x`__*` forms the outer <em>).
      if (ch === '*' && !(o.n >= 2 && closer.n >= 2)) {
        const oPos = delims[j], cPos = delims[k];
        let blocked = false;
        for (let s = 0; s < spans.length; s++) {
          const sOp = spans[s][0], sCl = spans[s][1];
          if (spans[s][2] === 'strong' && spans[s][3] === '*' && sOp > oPos && sCl < cPos) {
            const sOpener = out[sOp], sCloser = out[sCl];
            if (sOpener && sCloser && !sOpener.close && sCloser.open) { blocked = true; break; }
          }
        }
        if (blocked) continue;
      }
      openerIdx = j;
      break;
    }
    if (openerIdx === -1) { k++; continue; }
    const opener = out[delims[openerIdx]];
    let use, tag;
    if (ch === '~') {
      use = opener.n; tag = 'del';
    } else {
      use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
      tag = use === 2 ? 'strong' : 'em';
    }
    opener.ot = '<' + tag + '>' + opener.ot;
    closer.ct = closer.ct + '</' + tag + '>';
    // When the span just formed contains another formed span, a
    // partially-used closer renders its leftover delimiters BEFORE the
    // closing tag — but only for <strong> (W1/doc-30:
    // `**...*tool*one***` renders `one*` inside the <strong>). For
    // <em> the leftover renders after the tag (doc-04/20:
    // `*...*else*returns**` renders `</em>*`).
    let hasInner = false;
    if (tag === 'strong') {
      for (let s = 0; s < spans.length; s++) {
        if (spans[s][0] > delims[openerIdx] && spans[s][1] < delims[k]) { hasInner = true; break; }
      }
    }
    if (hasInner) closer.innerSpan = true;
    spans.push([delims[openerIdx], delims[k], tag, ch]);
    opener.n -= use;
    closer.n -= use;
    if (closer.n <= 0) k++;
    // else: same closer may match another opener; stay at k
  }
}

// Code span: text[i] === '`'. Returns {content, next} or null (no closing run).
// content has newlines -> spaces and the one-space strip rule applied (not escaped).
function codeSpanContent(text, i, limit, noCross) {
  const n = text.length;
  let j = i;
  while (j < n && text.charCodeAt(j) === 96) j++;
  const m = j - i; // opening run length
  let k = j;
  while (k < n) {
    const b = text.indexOf('`', k);
    if (b === -1) return null;
    let e = b;
    while (e < n && text.charCodeAt(e) === 96) e++;
    if (e - b === m) {
      // A closer beyond the link text's `]` (limit) is only usable for
      // a single-backtick opener whose span does not cross a newline,
      // and whose content is not a complete inline link `](...)`
      // preceded by other text: a multi-backtick span cannot cross a
      // link boundary (doc-09: `` ``url` `` inside
      // `[docs each ...](...)` must not match the `` `` `` on the next
      // line — the backticks stay literal and the link forms), and
      // neither can a multi-line span, nor a span whose content is
      // `text](dest)` (doc-16: the `` ` `` after `guide` in
      // `[values ``guide` in](#should)` must not swallow the link).
      // A single-backtick span may cross it when its content starts
      // with `]` (cm-525: `` `](/uri)` `` forms) or has `](` but no
      // closing `)` (cm-342: `` `link](/foo` `` forms, cm-537).
      if (limit !== undefined && b >= limit) {
        if (noCross) return null;
        if (m > 1 || text.slice(j, b).indexOf('\n') !== -1) return null;
        if (text.charCodeAt(j) !== 93) {
          const seg = text.slice(j, b);
          const lp = seg.indexOf('](');
          if (lp !== -1 && seg.indexOf(')', lp + 2) !== -1) return null;
        }
      }
      let content = text.slice(j, b);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      return { content: content, next: e };
    }
    k = e;
  }
  return null;
}

// Find the `]` that closes the innermost active bracket, starting the
// scan at `from`. Tracks nested `[`/`]` depth and skips escaped `\]`.
function findBracketClose(text, from) {
  const n = text.length;
  let depth = 1;
  let k = from;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === 92 && k + 1 < n) { k += 2; continue; } // backslash escape
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return k;
    }
    k++;
  }
  return -1;
}

function scanCodeSpan(text, i, limit, noCross) {
  const r = codeSpanContent(text, i, limit, noCross);
  if (r === null) return null;
  return { html: '<code>' + escapeCode(r.content) + '</code>', next: r.next };
}

function escapeCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function normalizeLabel(s) {
  // In a label only \] and \\ are unescaped (cm-194, cm-550); any other
  // backslash escape stays literal, so `foo\!` does not match `foo!` (cm-545).
  // Then collapse whitespace, trim, lowercase, and fold ß/ẞ to ss (cm-540).
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length) {
      const nc = s.charCodeAt(i + 1);
      if (nc === 93 || nc === 92) { out += s[i + 1]; i++; continue; }
    }
    out += s[i];
  }
  return out.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

function skipSpacesNewlines(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link destination starting at text[i]. Returns {dest, next} or null.
// dest is the raw destination with backslash escapes processed.
function parseLinkDestination(text, i) {
  const n = text.length;
  if (i >= n) return { dest: '', next: i };
  if (text.charCodeAt(i) === 60) { // <...>
    let j = i + 1;
    let dest = '';
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 62) return { dest: dest, next: j + 1 }; // >
      if (c === 10 || c === 60) return null; // newline or < not allowed
      if (c === 92 && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j]; j++;
    }
    return null;
  }
  // bare destination
  let j = i;
  let dest = '';
  let depth = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92 && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
    if (c === 40) { depth++; dest += '('; j++; continue; } // (
    if (c === 41) { // )
      if (depth === 0) break;
      depth--; dest += ')'; j++; continue;
    }
    dest += text[j]; j++;
  }
  return { dest: dest, next: j };
}

// Parse a link title starting at text[i]. Returns {title, next} or null.
function parseLinkTitle(text, i) {
  const n = text.length;
  if (i >= n) return null;
  const c = text.charCodeAt(i);
  let close;
  if (c === 34) close = 34; // "
  else if (c === 39) close = 39; // '
  else if (c === 40) close = 41; // (...)
  else return null;
  let j = i + 1;
  let title = '';
  while (j < n) {
    const ch = text.charCodeAt(j);
    if (ch === close) return { title: title, next: j + 1 };
    if (ch === 92 && j + 1 < n && isPunctCode(text.charCodeAt(j + 1))) { title += text[j + 1]; j += 2; continue; }
    if (close === 41 && (ch === 40 || ch === 41)) return null; // no parens inside (...) title
    title += text[j]; j++;
  }
  return null;
}

function makeHref(dest) {
  const cleaned = cleanUrl(decodeEntities(dest));
  if (cleaned === null) return null;
  return escapeAttr(cleaned);
}
function makeTitleAttr(title) {
  return ' title="' + escapeAttr(decodeEntities(title)) + '"';
}

// Will the bracket b form a link? Uses its cached close index and the
// same destination/label logic as tryLink (without consuming anything).
// A URL inside a bracket autolinks unless the bracket will form a link
// (doc-39: `[text https://...][3]` with no `[3]:` definition autolinks
// the URL; with a definition, or an inline destination, it stays plain).
function bracketWillFormLink(text, b, refs) {
  const closeIdx = b.closeIdx;
  if (closeIdx === undefined || closeIdx === -1) return false;
  const n = text.length;
  const nextCh = closeIdx + 1 < n ? text.charCodeAt(closeIdx + 1) : -1;
  const linkTextStart = b.srcPos + 1;
  const linkTextEnd = closeIdx;
  if (nextCh === 40) { // ( inline link
    let j = skipSpacesNewlines(text, closeIdx + 2);
    const d = parseLinkDestination(text, j);
    if (d !== null) {
      j = skipSpacesNewlines(text, d.next);
      if (j < n && text.charCodeAt(j) === 41) return makeHref(d.dest) !== null;
      const t = parseLinkTitle(text, j);
      if (t !== null) {
        j = skipSpacesNewlines(text, t.next);
        if (j < n && text.charCodeAt(j) === 41) return makeHref(d.dest) !== null;
      }
    }
    // inline failed: shortcut fallback (cm-568)
    return refs.has(normalizeLabel(text.slice(linkTextStart, linkTextEnd)));
  }
  if (nextCh === 91) { // [ full / collapsed reference
    let j = closeIdx + 2;
    let labelEnd = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 93) { labelEnd = j; break; }
      if (c === 91 || c === 10) break;
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      j++;
    }
    if (labelEnd === -1) return false;
    let label;
    if (labelEnd === closeIdx + 2) label = text.slice(linkTextStart, linkTextEnd);
    else label = text.slice(closeIdx + 2, labelEnd);
    return refs.has(normalizeLabel(label));
  }
  // shortcut reference
  return refs.has(normalizeLabel(text.slice(linkTextStart, linkTextEnd)));
}

// Try to resolve a link at text[closeIdx] === ']'. Returns the index just past
// the link construct, or -1 if no link is formed.
function tryLink(text, closeIdx, out, delims, brackets, refs) {
  // find topmost active bracket
  let bi = -1;
  for (let k = brackets.length - 1; k >= 0; k--) {
    if (brackets[k].active) { bi = k; break; }
  }
  if (bi === -1) return -1;
  const b = brackets[bi];
  // a bracket that already contains a link can never form a *link* (cm-518);
  // an image bracket may still form (the link becomes plain alt text)
  if (b.hasLink && b.bangPos === -1) { b.active = false; return -1; }
  const linkTextStart = b.srcPos + 1;
  const linkTextEnd = closeIdx;
  const n = text.length;
  // A multi-backtick code span whose content contains a backtick,
  // followed by any further content in the link text, prevents the
  // link from forming (doc-20: `[but _previous from `` a ` b ``_](...)`
  // stays literal; the inner URL autolinks instead). When the span is
  // the last thing in the link text, the link forms (X1/Y5). A span
  // without an inner backtick never blocks (W2/X4).
  {
    let p = linkTextStart;
    while (p < linkTextEnd) {
      if (text.charCodeAt(p) === 96) {
        let q = p + 1;
        while (q < linkTextEnd && text.charCodeAt(q) === 96) q++;
        const run = q - p;
        if (run >= 2) {
          // find the matching closer run; note any backtick before it
          let r = q;
          let closerEnd = -1;
          let hasInner = false;
          while (r < linkTextEnd) {
            if (text.charCodeAt(r) === 96) {
              let s = r + 1;
              while (s < linkTextEnd && text.charCodeAt(s) === 96) s++;
              if (s - r === run) { closerEnd = s; break; }
              hasInner = true;
              r = s;
            } else {
              r++;
            }
          }
          if (closerEnd !== -1 && hasInner && closerEnd < linkTextEnd) {
            // The link does not form, and the emphasis delimiters
            // inside the link text stay literal too (doc-20: the
            // `_previous from ..._` around the code span is NOT an
            // <em>). Drop them from the delim stack without resolving.
            delims.length = b.delimLen;
            b.active = false;
            return -1;
          }
          break;
        }
        p = q;
      } else {
        p++;
      }
    }
  }
  let dest = null;
  let title = null;
  let end = -1;

  const nextCh = closeIdx + 1 < n ? text.charCodeAt(closeIdx + 1) : -1;
  if (nextCh === 40) { // ( inline link; on failure fall through to shortcut (cm-568)
    let j = skipSpacesNewlines(text, closeIdx + 2);
    const d = parseLinkDestination(text, j);
    if (d !== null) {
      j = skipSpacesNewlines(text, d.next);
      if (j < n && text.charCodeAt(j) === 41) {
        dest = d.dest; end = j + 1;
      } else {
        const t = parseLinkTitle(text, j);
        if (t !== null) {
          j = skipSpacesNewlines(text, t.next);
          if (j < n && text.charCodeAt(j) === 41) {
            dest = d.dest; title = t.title; end = j + 1;
          }
        }
      }
    }
    if (dest === null) { // shortcut fallback
      const label = text.slice(linkTextStart, linkTextEnd);
      const ref = refs.get(normalizeLabel(label));
      if (!ref) { b.active = false; return -1; }
      dest = ref.dest; title = ref.title; end = closeIdx + 1;
    }
  } else if (nextCh === 91) { // [ full / collapsed reference; no shortcut fallback (cm-571)
    let j = closeIdx + 2;
    let labelEnd = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 93) { labelEnd = j; break; } // ]
      if (c === 91 || c === 10) break; // [ or newline ends the label scan
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      j++;
    }
    if (labelEnd === -1) { b.active = false; return -1; }
    let label;
    if (labelEnd === closeIdx + 2) label = text.slice(linkTextStart, linkTextEnd); // collapsed []
    else label = text.slice(closeIdx + 2, labelEnd);
    const ref = refs.get(normalizeLabel(label));
    if (!ref) { b.active = false; return -1; }
    dest = ref.dest; title = ref.title; end = labelEnd + 1;
  } else { // shortcut reference
    const label = text.slice(linkTextStart, linkTextEnd);
    const ref = refs.get(normalizeLabel(label));
    if (!ref) { b.active = false; return -1; }
    dest = ref.dest; title = ref.title; end = closeIdx + 1;
  }

  const href = makeHref(dest);
  if (href === null) { b.active = false; return -1; }
  const titleAttr = title !== null ? makeTitleAttr(title) : '';

  // resolve emphasis inside the link text, then remove those delims from the stack
  processEmphasis(delims, out, b.delimLen);
  delims.length = b.delimLen;

  if (b.bangPos !== -1) {
    // image: alt text is the plain text of the link text
    const alt = plainTextInline(text.slice(linkTextStart, linkTextEnd), refs);
    out[b.bangPos] = '';
    out[b.outPos] = '<img src="' + href + '" alt="' + escapeAttr(alt) + '"' + titleAttr + '>';
    for (let k = b.outPos + 1; k < out.length; k++) out[k] = '';
  } else {
    out[b.outPos] = '<a href="' + href + '"' + titleAttr + '>';
    out.push('</a>');
    // a real link inside any still-open bracket blocks that bracket from
    // ever forming a link (a link cannot contain another link)
    for (let k = 0; k < brackets.length; k++) brackets[k].hasLink = true;
  }
  brackets.splice(bi, 1);
  return end;
}

// ---------------------------------------------------------------------------
// Autolinks (<...>) and raw HTML
// ---------------------------------------------------------------------------

function scanAutolink(text, i) {
  const n = text.length;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  if (i + 1 < n && isAlpha(text.charCodeAt(i + 1))) {
    let j = i + 1;
    while (j < n && (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 43 || text.charCodeAt(j) === 46 || text.charCodeAt(j) === 45)) j++;
    if (j - (i + 1) >= 2 && j - (i + 1) <= 32 && j < n && text.charCodeAt(j) === 58) {
      // found scheme, scan to '>'
      let k = j + 1;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === 62) {
          const url = text.slice(i + 1, k);
          const href = makeHref(url);
          if (href === null) return null;
          return { html: '<a href="' + href + '">' + escapeText(url) + '</a>', next: k + 1 };
        }
        if (c === 32 || c === 60 || c < 32) break;
        k++;
      }
    }
  }
  // email: local@domain
  let j = i + 1;
  let at = -1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 62) break;
    if (c === 64) { at = j; break; }
    if (!isEmailLocalChar(c)) break;
    j++;
  }
  if (at !== -1) {
    const local = text.slice(i + 1, at);
    if (local.length > 0) {
      const d = scanEmailDomain(text, at + 1);
      if (d !== -1 && d < n && text.charCodeAt(d) === 62) {
        const email = text.slice(i + 1, d);
        return { html: '<a href="mailto:' + escapeAttr(email) + '">' + escapeText(email) + '</a>', next: d + 1 };
      }
    }
  }
  return null;
}

function isEmailLocalChar(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
    c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Scan an email domain starting at i. Returns index just past the domain, or -1.
// Domain: labels of [a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])? separated by '.', at least one dot,
// last label all letters.
function scanEmailDomain(text, i, allowUnderscore) {
  const n = text.length;
  let j = i;
  let lastDot = -1;
  let labels = 0;
  let labelStart = j;
  // end of the last complete, valid label (domain may end here)
  let goodEnd = -1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (isAlnum(c)) { j++; continue; }
    if (c === 45) { j++; continue; } // - inside a label
    if (c === 46) { // .
      // an empty label (two dots in a row, or a leading dot): the
      // domain ends at the last complete label (e.g. the `...` after
      // `nova.example.com` is trailing punctuation, not a label).
      // Break out and let the end-of-domain logic return goodEnd.
      if (j === labelStart) break;
      if (text.charCodeAt(j - 1) === 45) return -1; // label ends with -
      labels++; lastDot = j; goodEnd = j; labelStart = j + 1; j++; continue;
    }
    break;
  }
  if (j === labelStart) {
    // domain ends with a dot: the valid domain stops at the last dot
    if (goodEnd === -1 || labels < 2) return -1;
    // last label (before the trailing dot) must be all letters
    let ls = goodEnd - 1;
    while (ls >= i && text.charCodeAt(ls) !== 46) ls--;
    for (let k = ls + 1; k < goodEnd; k++) {
      if (!isAlpha(text.charCodeAt(k))) return -1;
    }
    return goodEnd;
  }
  if (text.charCodeAt(j - 1) === 45) return -1; // last label ends with -
  labels++;
  if (labels < 2) return -1; // need at least one dot
  // a _ right after the domain means the address is part of a longer
  // identifier, not a standalone email (gfm-632: a.b_ has no link) —
  // unless the _ is a closing emphasis delimiter with a matching
  // opener before the email (`__a@b.com__` DOES autolink).
  if (j < n && text.charCodeAt(j) === 95 && !allowUnderscore) return -1;
  // last label must be all letters
  for (let k = lastDot + 1; k < j; k++) {
    if (!isAlpha(text.charCodeAt(k))) return -1;
  }
  return j;
}

// Scan a raw HTML tag starting at text[i] === '<'. Returns {html, next} or null.
// Validate an open/close HTML tag starting at text[i] === '<'.
// Returns the index just past the closing '>' if valid, else -1.
// Rules (CommonMark tag): tag name = letter + alnum/hyphen; after the name
// only whitespace, '>', '/', or EOL; closing tags take no attributes;
// attributes are whitespace-separated, names = [A-Za-z_:][A-Za-z0-9_.:-]*,
// values quoted or unquoted.
// Validate an open/close HTML tag starting at text[i] === '<'.
// Returns the index just past the closing '>' if valid, else -1.
// Rules (CommonMark tag): tag name = letter + alnum/hyphen; after the name
// only whitespace, '>', '/', or EOL; closing tags take no attributes;
// attributes are whitespace-separated, names = [A-Za-z_:][A-Za-z0-9_.:-]*,
// values quoted or unquoted.
function validTagEnd(text, i) {
  const n = text.length;
  let j = i + 1;
  let closing = false;
  if (j < n && text.charCodeAt(j) === 47) { closing = true; j++; } // /
  if (j >= n || !isAlpha(text.charCodeAt(j))) return -1;
  while (j < n && (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 45)) j++;
  // after the tag name: whitespace, '>', '/', or EOL only
  if (j < n) {
    const c = text.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 62 && c !== 47) return -1;
  }
  if (closing) {
    while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10)) j++;
    if (j < n && text.charCodeAt(j) === 62) return j + 1; // >
    return -1;
  }
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 62) return j + 1; // >
    if (c === 47 && j + 1 < n && text.charCodeAt(j + 1) === 62) return j + 2; // />
    if (c === 32 || c === 9 || c === 10) { j++; continue; }
    // attribute name (must follow whitespace)
    if (!(isAlpha(c) || c === 95 || c === 58)) return -1;
    while (j < n) {
      const a = text.charCodeAt(j);
      if (isAlnum(a) || a === 95 || a === 58 || a === 46 || a === 45) j++;
      else break;
    }
    // optional = value
    let k = j;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
    if (k < n && text.charCodeAt(k) === 61) { // =
      k++;
      while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
      if (k >= n) return -1;
      const q = text.charCodeAt(k);
      if (q === 34 || q === 39) {
        const e2 = text.indexOf(String.fromCharCode(q), k + 1);
        if (e2 === -1) return -1;
        j = e2 + 1;
      } else {
        while (k < n) {
          const v = text.charCodeAt(k);
          if (v === 32 || v === 9 || v === 10 || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) break;
          k++;
        }
        if (k === j) return -1; // empty unquoted value
        j = k;
      }
      // after a value, only whitespace, '>', or '/' may follow
      if (j < n) {
        const c2 = text.charCodeAt(j);
        if (c2 !== 32 && c2 !== 9 && c2 !== 10 && c2 !== 62 && c2 !== 47) return -1;
      }
    } else {
      // valueless attribute: j already sits at the next attribute (after
      // the whitespace); loop back and let the top of the loop handle it
      j = k;
    }
  }
  return -1;
}

function scanHtmlTag(text, i) {
  const n = text.length;
  if (i + 1 >= n) return null;
  const c1 = text.charCodeAt(i + 1);
  // comment <!-- ... --> ; <!--> and <!---> are complete (abruptly-closed) comments
  if (c1 === 33 && i + 3 < n && text.charCodeAt(i + 2) === 45 && text.charCodeAt(i + 3) === 45) {
    if (i + 4 < n && text.charCodeAt(i + 4) === 62) return { html: text.slice(i, i + 5), next: i + 5 }; // <!-->
    if (i + 5 < n && text.charCodeAt(i + 4) === 45 && text.charCodeAt(i + 5) === 62) return { html: text.slice(i, i + 6), next: i + 6 }; // <!-->
    const end = text.indexOf('-->', i + 4);
    if (end === -1) return null;
    return { html: text.slice(i, end + 3), next: end + 3 };
  }
  // processing instruction <? ... ?>
  if (c1 === 63) {
    const end = text.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { html: text.slice(i, end + 2), next: end + 2 };
  }
  // declaration <!A ...> or CDATA <![CDATA[ ... ]]>
  if (c1 === 33) {
    if (text.slice(i + 2, i + 9) === '[CDATA[') {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return { html: text.slice(i, end + 3), next: end + 3 };
    }
    if (i + 2 < n && isAlpha(text.charCodeAt(i + 2))) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) return null;
      return { html: text.slice(i, end + 1), next: end + 1 };
    }
    return null;
  }
  // open / close tag
  const e = validTagEnd(text, i);
  if (e === -1) return null;
  return { html: text.slice(i, e), next: e };
}


// ---------------------------------------------------------------------------
// GFM extended autolinks (www. / scheme:// / email)
// ---------------------------------------------------------------------------

function isValidDomain(domain) {
  if (domain.length === 0 || domain.indexOf('.') === -1) return false;
  const labels = domain.split('.');
  for (let li = 0; li < labels.length; li++) {
    const lab = labels[li];
    if (lab.length === 0) return false;
    if (!isAlnum(lab.charCodeAt(0)) || !isAlnum(lab.charCodeAt(lab.length - 1))) return false;
    for (let k = 1; k < lab.length - 1; k++) {
      const c = lab.charCodeAt(k);
      if (!isAlnum(c) && c !== 45) return false;
    }
  }
  // last label (TLD) must be all letters
  const tld = labels[labels.length - 1];
  for (let k = 0; k < tld.length; k++) {
    if (!isAlpha(tld.charCodeAt(k))) return false;
  }
  return true;
}

// Strip trailing punctuation / unbalanced ')' from a candidate autolink.
// Returns the new end index (exclusive).
function trimAutolinkEnd(text, start, end) {
  while (end > start) {
    const c = text.charCodeAt(end - 1);
    if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) { // ? ! . , : * _ ~
      end--;
      continue;
    }
    if (c === 59) { // ; — an entity-like &name; suffix is not part of the link
      let k = end - 2;
      while (k >= start && isAlnum(text.charCodeAt(k))) k--;
      if (k >= start && text.charCodeAt(k) === 38 && k + 1 < end - 1) { end = k; continue; }
      end--;
      continue;
    }
    break;
  }
  // balance parens: strip trailing ')' while there are more ')' than '('.
  // A ')' immediately followed by ']' is not counted: the `)]` is a
  // link-closing sequence, not a URL paren (P4/D08/D22: `a)](b)` keeps
  // both parens, while `a(b))` loses one).
  let open = 0, close = 0;
  for (let k = start; k < end; k++) {
    if (text.charCodeAt(k) === 40) open++;
    else if (text.charCodeAt(k) === 41 && !(k + 1 < end && text.charCodeAt(k + 1) === 93)) close++;
  }
  while (close > open && end > start && text.charCodeAt(end - 1) === 41 && !(end < text.length && text.charCodeAt(end) === 93)) {
    end--; close--;
    // after stripping a ')', more trailing punctuation may appear
    while (end > start) {
      const c = text.charCodeAt(end - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) { end--; continue; }
      break;
    }
  }
  return end;
}

// Scan the end of a bare GFM autolink URL starting at text[i]: advance
// until whitespace, '<', or a control char. A `](` sequence is part of
// the URL only when the `(` group that follows closes without any
// whitespace inside it (Q1/Q4/D22: `a)](https://x.com/y)` is one
// autolink); when the group contains a space (Q2/Q3/Q6/doc-08:
// `a)](https://x.com/y (Most))`), the URL ends right after the `]`
// and the `(` starts a new segment.
function scanGfmUrlEnd(text, i) {
  const n = text.length;
  let end = i;
  while (end < n) {
    const c = text.charCodeAt(end);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
    if (c === 93 && end + 1 < n && text.charCodeAt(end + 1) === 40) {
      // look ahead: does the '(' group close without whitespace?
      let depth = 0, k = end + 1, clean = false;
      while (k < n) {
        const kc = text.charCodeAt(k);
        if (kc === 32 || kc === 9 || kc === 10 || kc < 32) break;
        if (kc === 40) depth++;
        else if (kc === 41) { depth--; if (depth === 0) { clean = true; break; } }
        k++;
      }
      if (!clean) { end++; break; }
    }
    end++;
  }
  return end;
}

// Attempt a GFM extended autolink at text[i]. Returns {html, next} or null.
// The char before i must be start-of-text, whitespace, or one of * _ ~ ( .
function tryGfmAutolink(text, i, plainStart, allowUnderscore) {
  const n = text.length;
  // the char before the autolink must be start-of-text, whitespace, or punctuation
  const prev = i === 0 ? 32 : text.charCodeAt(i - 1);
  if (!(prev === 32 || prev === 9 || prev === 10 || isPunctCode(prev))) return null;

  // --- www. ---
  if (text.charCodeAt(i) === 119 && text.slice(i, i + 4) === 'www.') {
    let end = scanGfmUrlEnd(text, i);
    end = trimAutolinkEnd(text, i, end);
    if (end - i <= 4) return null;
    const linkText = text.slice(i, end);
    // domain = the hostname: labels of alnum / '-' separated by '.'.
    // Stop at the first char that cannot be in a hostname (a '/', '?',
    // '#', ':', ')', ']' or similar) — that char belongs to the URL
    // text but not to the domain (doc-08: the `)]` after
    // `sub.domain.example.io` is part of the autolink, not the domain).
    let dEnd = 0;
    while (dEnd < linkText.length) {
      const c = linkText.charCodeAt(dEnd);
      if (!isAlnum(c) && c !== 45 && c !== 46) break;
      dEnd++;
    }
    const domain = linkText.slice(0, dEnd).replace(/\.+$/, '');
    if (!isValidDomain(domain)) return null;
    const href = makeHref('http://' + linkText);
    if (href === null) return null;
    return { html: '<a href="' + href + '">' + escapeText(linkText) + '</a>', next: end };
  }
  // --- scheme:// --- (case-insensitive: Https:// and Http:// autolink)
  let scheme = null;
  const low7 = text.slice(i, i + 7).toLowerCase();
  const low8 = text.slice(i, i + 8).toLowerCase();
  if (low7 === 'http://') scheme = 7;
  else if (low8 === 'https://') scheme = 8;
  else if (text.slice(i, i + 6).toLowerCase() === 'ftp://') scheme = 6;
  if (scheme !== null) {
    let end = scanGfmUrlEnd(text, i);
    end = trimAutolinkEnd(text, i, end);
    const linkText = text.slice(i, end);
    let dStart = i + scheme;
    let dEnd = dStart;
    while (dEnd < end) {
      const c = text.charCodeAt(dEnd);
      if (!isAlnum(c) && c !== 45 && c !== 46) break;
      dEnd++;
    }
    // A trailing dot is part of the link text (doc-37/40:
    // `https://img.shields.io.\` keeps the dot) but not of the
    // hostname used for validation.
    const domain = text.slice(dStart, dEnd).replace(/\.+$/, '');
    if (!isValidDomain(domain)) return null;
    const href = makeHref(linkText);
    if (href === null) return null;
    return { html: '<a href="' + href + '">' + escapeText(linkText) + '</a>', next: end };
  }
  // --- generic scheme: mailto: / xmpp: / any [a-zA-Z][a-zA-Z0-9+.-]{1,31}: ---
  {
    let sEnd = i;
    if (sEnd < n && isAlpha(text.charCodeAt(sEnd))) {
      sEnd++;
      while (sEnd < n && (isAlnum(text.charCodeAt(sEnd)) || text.charCodeAt(sEnd) === 43 || text.charCodeAt(sEnd) === 46 || text.charCodeAt(sEnd) === 45)) sEnd++;
      if (sEnd - i >= 2 && sEnd - i <= 32 && sEnd < n && text.charCodeAt(sEnd) === 58) {
        // scan authority + at most one path segment + optional ?query/#fragment
        let end = sEnd + 1;
        let aEnd = end;
        while (aEnd < n) {
          const c = text.charCodeAt(aEnd);
          if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32 || c === 47 || c === 63 || c === 35) break;
          aEnd++;
        }
        if (aEnd > end) {
          // an authority ending in _ is not a valid domain (gfm-633);
          // it invalidates the link instead of being trimmed off
          if (text.charCodeAt(aEnd - 1) === 95) return null;
          let pEnd = aEnd;
          if (pEnd < n && text.charCodeAt(pEnd) === 47) {
            let q = pEnd + 1;
            while (q < n) {
              const c = text.charCodeAt(q);
              if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32 || c === 47 || c === 63 || c === 35) break;
              q++;
            }
            if (q > pEnd + 1) pEnd = q;
          }
          end = pEnd;
          if (end < n && (text.charCodeAt(end) === 63 || text.charCodeAt(end) === 35)) {
            let q = end;
            while (q < n) {
              const c = text.charCodeAt(q);
              if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) break;
              q++;
            }
            end = q;
          }
          end = trimAutolinkEnd(text, i, end);
          const linkText = text.slice(i, end);
          // domain: after the last @ in the authority, else the authority.
          // The scheme colon must survive trimming: a `word.word:` whose
          // authority is only punctuation (doc-31: `renderer.code:.`)
          // trims to just `renderer.code` — that is not a scheme link.
          const colon = linkText.indexOf(':');
          if (colon === -1) return null;
          let authEnd = linkText.length;
          for (let k = colon + 1; k < linkText.length; k++) {
            const c = linkText.charCodeAt(k);
            if (c === 47 || c === 63 || c === 35) { authEnd = k; break; }
          }
          const auth = linkText.slice(colon + 1, authEnd);
          const atIdx = auth.lastIndexOf('@');
          const domain = atIdx !== -1 ? auth.slice(atIdx + 1) : auth;
          if (domain.length > 0 && isValidDomain(domain)) {
            const href = makeHref(linkText);
            if (href !== null) {
              return { html: '<a href="' + href + '">' + escapeText(linkText) + '</a>', next: end };
            }
          }
        }
      }
    }
  }
  // --- email ---
  if (isAlnum(text.charCodeAt(i)) || text.charCodeAt(i) === 46) {
    let j = i;
    while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
    if (j > i && j < n && text.charCodeAt(j) === 64) { // @
      const local = text.slice(i, j);
      if (local.charCodeAt(0) === 46 || local.charCodeAt(local.length - 1) === 46 || local.indexOf('..') !== -1) return null;
      const dEnd = scanEmailDomain(text, j + 1, allowUnderscore);
      if (dEnd !== -1) {
        const email = text.slice(i, dEnd);
        return { html: '<a href="mailto:' + escapeAttr(email) + '">' + escapeText(email) + '</a>', next: dEnd };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plain-text rendering of inline content (image alt text)
// ---------------------------------------------------------------------------

// Resolve the link suffix at text[closeIdx] === ']' for the bracket that
// opened at bracketSrcPos. Returns the index just past the link construct,
// or null if no link forms. Plain-text twin of tryLink's suffix logic.
function resolveLinkEnd(text, closeIdx, bracketSrcPos, refs) {
  const n = text.length;
  const linkTextStart = bracketSrcPos + 1;
  const linkTextEnd = closeIdx;
  const nextCh = closeIdx + 1 < n ? text.charCodeAt(closeIdx + 1) : -1;
  if (nextCh === 40) { // ( inline
    let j = skipSpacesNewlines(text, closeIdx + 2);
    const d = parseLinkDestination(text, j);
    if (d === null) return null;
    j = skipSpacesNewlines(text, d.next);
    if (j < n && text.charCodeAt(j) === 41) return j + 1;
    const t = parseLinkTitle(text, j);
    if (t === null) return null;
    j = skipSpacesNewlines(text, t.next);
    if (j >= n || text.charCodeAt(j) !== 41) return null;
    return j + 1;
  } else if (nextCh === 91) { // [ full / collapsed
    let j = closeIdx + 2;
    let labelEnd = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 93) { labelEnd = j; break; }
      if (c === 91 || c === 10) break;
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      j++;
    }
    if (labelEnd === -1) return null;
    let label;
    if (labelEnd === closeIdx + 2) label = text.slice(linkTextStart, linkTextEnd);
    else label = text.slice(closeIdx + 2, labelEnd);
    if (!refs.get(normalizeLabel(label))) return null;
    return labelEnd + 1;
  } else { // shortcut
    const label = text.slice(linkTextStart, linkTextEnd);
    if (!refs.get(normalizeLabel(label))) return null;
    return closeIdx + 1;
  }
}

// Plain text of inline content (image alt text). Resolves links
// innermost-first with the same no-link-in-link rule as the main parser,
// so nested brackets render correctly (cm-520).
function plainTextInline(s, refs) {
  const out = [];
  const brackets = [];
  let i = 0;
  const n = s.length;
  const pushStr = (t) => { if (t !== '') out.push(t); };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && isPunctCode(s.charCodeAt(i + 1))) { pushStr(s[i + 1]); i += 2; continue; }
      if (i + 1 < n && s.charCodeAt(i + 1) === 10) { pushStr(' '); i += 2; continue; }
      pushStr('\\'); i++; continue;
    }
    if (c === 96) { // code span -> literal content
      const r = codeSpanContent(s, i);
      if (r !== null) { pushStr(r.content); i = r.next; continue; }
      pushStr('`'); i++; continue;
    }
    if (c === 42 || c === 95 || c === 126) { // emphasis markers removed
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      i = j; continue;
    }
    if (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91) { i++; continue; } // ! before [
    if (c === 91) { // [
      out.push('[');
      brackets.push({ outPos: out.length - 1, active: true, srcPos: i, hasLink: false });
      i++; continue;
    }
    if (c === 93) { // ] try to resolve as link
      let bi = -1;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active) { bi = k; break; }
      }
      if (bi === -1) { pushStr(']'); i++; continue; }
      const b = brackets[bi];
      if (b.hasLink) { b.active = false; pushStr(']'); i++; continue; }
      const res = resolveLinkEnd(s, i, b.srcPos, refs);
      if (res === null) { b.active = false; pushStr(']'); i++; continue; }
      // link formed: drop the '[' marker, keep the link text, skip suffix
      out[b.outPos] = '';
      for (let k = 0; k < brackets.length; k++) brackets[k].hasLink = true;
      brackets.splice(bi, 1);
      i = res;
      continue;
    }
    if (c === 60) { // < autolink / tag
      const auto = scanAutolink(s, i);
      if (auto !== null) {
        const m = auto.html.match(/>([^<]*)<\/a>/);
        pushStr(m ? m[1] : '');
        i = auto.next; continue;
      }
      const tag = scanHtmlTag(s, i);
      if (tag !== null) { i = tag.next; continue; }
      pushStr('<'); i++; continue;
    }
    if (c === 38) { // &
      const r = entityAt(s, i);
      if (r !== null) { pushStr(r.text); i = r.next; continue; }
      pushStr('&'); i++; continue;
    }
    if (c === 10) { pushStr(' '); i++; continue; }
    pushStr(s[i]); i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing helpers
// ---------------------------------------------------------------------------

// Line cursor: { s, i, col, pend }
// s = original line string; i = string index; col = visual column at i;
// pend = pending spaces from a tab that straddled an indent boundary.
function curIsBlank(cur) {
  let i = cur.i;
  while (i < cur.s.length) {
    const c = cur.s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}
function curIndent(cur) {
  // the logical column is cur.col - cur.pend (pend = columns of a
  // partially-consumed tab still ahead of the next character)
  let col = cur.col;
  let i = cur.i;
  while (i < cur.s.length) {
    const c = cur.s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col = ((col / 4) | 0) * 4 + 4; i++; }
    else break;
  }
  return col - (cur.col - cur.pend);
}
function curChar(cur) {
  if (cur.pend > 0) return 32;
  if (cur.i >= cur.s.length) return -1;
  return cur.s.charCodeAt(cur.i);
}
// Advance over up to `cols` columns of whitespace. Returns columns advanced.
function curAdvance(cur, cols) {
  // First consume the pending tab remainder: `pend` counts columns of a
  // partially-consumed tab that are already included in cur.col but have
  // no character left to consume. Advancing through them just reduces
  // pend (doc-14: a tab continuation inside a nested list item must
  // lose the tab remainder when the item's content indent is consumed,
  // not leave it as leading spaces in the paragraph text).
  if (cur.pend > 0) {
    const use = cur.pend < cols ? cur.pend : cols;
    cur.pend -= use;
    cols -= use;
    if (cols <= 0) return use;
  }
  let adv = 0;
  while (adv < cols && cur.i < cur.s.length) {
    const c = cur.s.charCodeAt(cur.i);
    if (c === 32) { cur.i++; cur.col++; adv++; }
    else if (c === 9) {
      const next = ((cur.col / 4) | 0) * 4 + 4;
      const w = next - cur.col;
      if (w <= cols - adv) { cur.i++; cur.col = next; adv += w; }
      else { cur.pend = w - (cols - adv); cur.i++; cur.col = next; adv = cols; }
    } else break;
  }
  return adv;
}
function curText(cur) {
  return (cur.pend > 0 ? ' '.repeat(cur.pend) : '') + cur.s.slice(cur.i);
}
function curSkipSpaces(cur, maxCols) {
  let adv = 0;
  while (adv < maxCols) {
    const c = curChar(cur);
    if (c === 32) {
      // consuming pend moves the logical column forward, but cur.col is
      // already at the tab stop, so col does not move
      if (cur.pend > 0) { cur.pend--; adv++; }
      else { cur.i++; cur.col++; adv++; }
    } else if (c === 9) {
      // a tab advances to the next multiple of 4 columns, not 1: a
      // leading tab is 4 columns of indent, which exceeds the 3-column
      // limit for a block start (doc-14: `\t<div>` is indented code,
      // not an HTML block). Only skip the tab if its full width fits.
      const w = ((cur.col / 4) | 0) * 4 + 4 - cur.col;
      if (adv + w > maxCols) break;
      cur.i++; cur.col += w; adv += w;
    } else break;
  }
  return adv;
}
// Consume one char (handling pending spaces).
function curConsume(cur) {
  if (cur.pend > 0) { cur.pend--; cur.col++; return 32; }
  const c = cur.s.charCodeAt(cur.i);
  cur.i++; cur.col++;
  return c;
}

// Is the line (raw) blank?
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}


// Paragraph line text: strip up to 3 leading spaces (the block indent).
function paraLineText(cur) {
  curSkipSpaces(cur, 3);
  return curText(cur);
}


// Does the line at the cursor start with a blockquote marker ('>' after <=3 spaces)?
function startsWithBlockquote(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  curSkipSpaces(cur, 3);
  const ok = curChar(cur) === 62;
  cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
  return ok;
}

// Parse a list marker at the cursor. Returns null or
// { bullet, ordered, start, markerWidth, contentIndent, markerIndent }.
// contentIndent is measured from the cursor's starting column.
function parseListMarker(cur) {
  const startCol = cur.col;
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  const indent = curSkipSpaces(cur, 3);
  if (indent >= 4 && curChar(cur) !== -1) {
    // more than 3 spaces: not a list marker (unless the line is blank)
  }
  const c = curChar(cur);
  if (c === -1) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
  let bullet = false, ordered = false, start = null, markerWidth = 0;
  let markerChar = null, delim = null;
  if (c === 45 || c === 43 || c === 42) { // - + *
    bullet = true; markerWidth = 1; markerChar = String.fromCharCode(c);
    curConsume(cur);
  } else if (isDigit(c)) {
    let j = cur.i;
    let digits = 0;
    let num = 0;
    while (j < cur.s.length && isDigit(cur.s.charCodeAt(j)) && digits < 9) { num = num * 10 + (cur.s.charCodeAt(j) - 48); digits++; j++; }
    if (digits === 0 || digits > 9) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
    if (j < cur.s.length && (cur.s.charCodeAt(j) === 46 || cur.s.charCodeAt(j) === 41)) {
      ordered = true; start = num; markerWidth = digits + 1; delim = String.fromCharCode(cur.s.charCodeAt(j));
      while (cur.i < j) curConsume(cur);
      curConsume(cur); // . or )
    } else { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
  } else {
    cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
    return null;
  }
  // after the marker: need 1+ spaces/tabs or end of line
  const afterC = curChar(cur);
  if (afterC !== -1 && afterC !== 32 && afterC !== 9) {
    cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
    return null;
  }
  const markerIndent = (cur.col - startCol) - markerWidth; // columns of indent before marker
  // count whitespace after the marker
  let spaces = 0;
  let k = cur.i;
  let kcol = cur.col;
  let kpend = cur.pend;
  while (k < cur.s.length) {
    const ch = cur.s.charCodeAt(k);
    if (ch === 32) { spaces++; k++; kcol++; }
    else if (ch === 9) { const nx = ((kcol / 4) | 0) * 4 + 4; spaces += nx - kcol; k++; kcol = nx; }
    else break;
  }
  const atEol = k >= cur.s.length;
  let contentIndent;
  if (atEol) {
    contentIndent = markerIndent + markerWidth + 1;
  } else if (spaces >= 5) {
    contentIndent = markerIndent + markerWidth + 1;
  } else {
    contentIndent = markerIndent + markerWidth + spaces;
  }
  return { bullet, ordered, start, markerWidth, contentIndent, markerIndent, spacesAfter: spaces, atEol, markerChar, delim };
}

// ATX heading at cursor: returns level (1-6) or 0. Cursor is left at the content.
function parseAtxHeading(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  curSkipSpaces(cur, 3);
  let level = 0;
  while (curChar(cur) === 35 && level < 7) { curConsume(cur); level++; }
  if (level === 0 || level > 6) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 0; }
  const c = curChar(cur);
  if (c !== -1 && c !== 32 && c !== 9) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 0; }
  return level;
}

// Setext underline at cursor: returns 1 (=), 2 (-), or 0.
// A setext underline is a run of = or - with only leading/trailing spaces
// (no spaces between the characters).
function parseSetextUnderline(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  curSkipSpaces(cur, 3);
  const c = curChar(cur);
  if (c !== 61 && c !== 45) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 0; }
  let j = cur.i;
  while (j < cur.s.length && cur.s.charCodeAt(j) === c) j++;
  while (j < cur.s.length && (cur.s.charCodeAt(j) === 32 || cur.s.charCodeAt(j) === 9)) j++;
  if (j !== cur.s.length) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 0; }
  return c === 61 ? 1 : 2;
}

// Thematic break at cursor: 3+ of the same char (-, _, *) with only spaces.
function parseThematicBreak(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  curSkipSpaces(cur, 3);
  const c = curChar(cur);
  if (c !== 45 && c !== 95 && c !== 42) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return false; }
  let count = 0;
  let j = cur.i;
  while (j < cur.s.length) {
    const ch = cur.s.charCodeAt(j);
    if (ch === c) { count++; j++; }
    else if (ch === 32 || ch === 9) j++;
    else { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return false; }
  }
  if (count < 3) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return false; }
  return true;
}

// Fenced code start at cursor: returns {char, len, indent} or null. Cursor left after the fence.
function parseFence(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  const indent = curSkipSpaces(cur, 3);
  const c = curChar(cur);
  if (c !== 96 && c !== 126) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
  let len = 0;
  while (curChar(cur) === c) { curConsume(cur); len++; }
  if (len < 3) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
  // a backtick fence's info string may not contain a backtick (a line
  // like ```inner backticks``` is paragraph text / a code span, not a
  // fence — doc-05). Tilde fences have no such restriction.
  if (c === 96) {
    const rest = cur.s.slice(cur.i);
    if (rest.indexOf('`') !== -1) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return null; }
  }
  return { char: String.fromCharCode(c), len, indent };
}

// HTML block start type (1-7) at cursor, or 0. Cursor is not advanced.
function htmlBlockType(cur) {
  const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
  curSkipSpaces(cur, 3);
  if (curChar(cur) !== 60) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 0; } // <
  const s = cur.s;
  const i = cur.i;
  const rest = s.slice(i);
  // type 1: <script, <pre, <style, <textarea (case-insensitive)
  const m1 = rest.match(/^<(script|pre|style|textarea)([\s>]|$)/i);
  if (m1) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 1; }
  // type 2: <!--
  if (rest.startsWith('<!--')) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 2; }
  // type 3: <?
  if (rest.startsWith('<?')) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 3; }
  // type 4: <! + letter
  if (rest.startsWith('<!') && rest.length > 2 && isAlpha(rest.charCodeAt(2))) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 4; }
  // type 5: <![CDATA[
  if (rest.startsWith('<![CDATA[')) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 5; }
  // type 6: block tag (open or close), case-insensitive
  const m6 = rest.match(/^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s>\/]|$)/i);
  if (m6) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 6; }
  // type 7: any other tag, but only when the tag is complete and alone on
  // the line (nothing but whitespace after its closing >)
  const m7 = rest.match(/^<\/?[A-Za-z][A-Za-z0-9-]*/);
  if (m7) {
    const e = validTagEnd(s, i);
    if (e !== -1) {
      let k = e;
      while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k >= s.length) { cur.i = saveI; cur.col = saveCol; cur.pend = savePend; return 7; }
    }
  }
  cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
  return 0;
}

// Table helpers
function splitTableRow(line) {
  // split on unescaped | ; drop empty leading/trailing parts from outer pipes
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < line.length && line.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; } // \|
    if (c === 124) { cells.push(cur); cur = ''; continue; } // |
    cur += line[i];
  }
  cells.push(cur);
  // leading pipe (after optional whitespace) -> the cell before it is
  // empty (drop); trailing pipe (before optional whitespace) -> the
  // cell after it is empty (drop). A row like ` | a | b |` has cells
  // a, b — the whitespace before the first pipe is not a cell.
  let start = 0, end = cells.length;
  let k = 0;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (k < line.length && line.charCodeAt(k) === 124) start = 1;
  let m = line.length - 1;
  while (m >= 0 && (line.charCodeAt(m) === 32 || line.charCodeAt(m) === 9)) m--;
  if (m >= 0 && line.charCodeAt(m) === 124 && !(m > 0 && line.charCodeAt(m - 1) === 92)) end = cells.length - 1;
  return cells.slice(start, end);
}
function parseDelimiterRow(line) {
  // returns array of alignments ('left'|'right'|'center'|null) or null
  if (line.indexOf('|') === -1) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k].trim();
    if (!/^\:?-+\:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':') && cell.length >= 3) aligns.push('center');
    else if (cell.endsWith(':')) aligns.push('right');
    else if (cell.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Link reference definition parsing (operates on a paragraph's lines).
// Returns the remaining lines after removing leading definitions.
// Extract link reference definitions from the start of the paragraph's joined
// text. Returns the remaining text after all leading definitions. A definition
// may span lines (label, destination, and title on following lines); the title
// may span lines too. A title with junk after it invalidates the definition
// only when the title starts on the same line as the destination.
function extractDefinitions(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const res = tryParseDefinition(text, pos, refs);
    if (res === null) break;
    pos = res.nextPos;
  }
  return text.slice(pos);
}

// Parse one link reference definition starting at text[pos]. Returns
// {nextPos} or null. nextPos is the index just past the definition.
function tryParseDefinition(text, pos, refs) {
  const n = text.length;
  let i = pos;
  let sp = 0;
  while (i < n && text.charCodeAt(i) === 32 && sp < 3) { i++; sp++; }
  if (i >= n || text.charCodeAt(i) !== 91) return null; // [
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = text.charCodeAt(j);
    // in a label only \] and \\ are unescaped (cm-194, cm-550); any other
    // backslash escape stays literal (cm-545, cm-549)
    if (c === 92 && j + 1 < n) {
      const nc = text.charCodeAt(j + 1);
      if (nc === 93 || nc === 92) { label += text[j + 1]; j += 2; continue; }
      if (isPunctCode(nc)) { label += text[j]; label += text[j + 1]; j += 2; continue; }
    }
    if (c === 93) break; // ]
    if (c === 91) return null; // [ inside label
    label += text[j]; j++;
  }
  if (j >= n || text.charCodeAt(j) !== 93) return null; // ]
  if (label.length === 0 || label.length > 999) return null;
  // a label that normalizes to empty is not a definition (cm-552)
  if (normalizeLabel(label) === '') return null;
  j++;
  if (j >= n || text.charCodeAt(j) !== 58) return null; // :
  j++;
  j = skipSpacesNewlines(text, j);
  if (j >= n) return null; // no destination
  const d = parseLinkDestination(text, j);
  if (!d) return null;
  // an empty destination is valid only as the angle-bracket form <>
  if (d.dest === '' && d.next === j) return null;
  const dest = d.dest;
  const destEnd = d.next;
  if (destEnd < n) {
    const c = text.charCodeAt(destEnd);
    if (c !== 32 && c !== 9 && c !== 10) return null; // junk right after dest
  }
  let k = destEnd;
  let crossedNewline = false;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === 10) crossedNewline = true;
    if (c === 32 || c === 9 || c === 10) k++;
    else break;
  }
  const store = (title) => {
    const norm = normalizeLabel(label);
    if (!refs.has(norm)) refs.set(norm, { dest: dest, title: title });
  };
  if (k >= n) { store(null); return { nextPos: n }; }
  const qc = text.charCodeAt(k);
  if (qc !== 34 && qc !== 39 && qc !== 40) {
    // not a title: valid without one only when the junk is on a later line
    if (crossedNewline) { store(null); return { nextPos: k }; }
    return null;
  }
  const t = parseLinkTitle(text, k);
  if (!t) {
    // unterminated title: valid without it only when the title is on a later line
    if (crossedNewline) { store(null); return { nextPos: k }; }
    return null;
  }
  // after the title, only spaces/tabs may follow on the same line
  let m = t.next;
  while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
  if (m >= n || text.charCodeAt(m) === 10) {
    // title complete; definition valid; consume through the end of this line
    store(t.title);
    let np = m;
    if (np < n && text.charCodeAt(np) === 10) np++;
    return { nextPos: np };
  }
  // junk on the same line as the title
  if (crossedNewline) { store(null); return { nextPos: k }; }
  return null;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

class State {
  constructor(src) {
    this.endsWithNewline = src.length > 0 && src.charCodeAt(src.length - 1) === 10;
    this.lines = src.split('\n');
    if (this.endsWithNewline) this.lines.pop();
    this.refs = new Map();
    // true while an inline <a> tag (raw HTML) is open without a matching
    // </a>: GFM autolinks are suppressed inside link text, and marked
    // carries this state across blocks (doc-03: an unclosed <a> in one
    // paragraph suppresses the email autolink in a later paragraph).
    // An <a> that is a block-level HTML block does not set it.
    this.inLink = false;
  }
}

function isContainerNode(node) {
  return node.t === 'doc' || node.t === 'quote' || node.t === 'list' || node.t === 'item';
}

// Expand leading tabs in a paragraph line to spaces, using the
// column at which the line starts (doc-40: `> \tindented` inside a
// blockquote renders as 2 spaces, not a raw tab). Only the leading
// whitespace is expanded; tabs later in the line are kept.
function expandLeadingTabs(text, col) {
  let k = 0, out = '';
  while (k < text.length) {
    const c = text.charCodeAt(k);
    if (c === 32) { out += ' '; col++; k++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; k++; }
    else break;
  }
  return out + text.slice(k);
}

function parseBlocks(st) {
  const root = { t: 'doc', children: [] };
  const open = [root];
  const lines = st.lines;
  const lastLn = lines.length - 1;

  const tip = () => open[open.length - 1];

  function finalize(node) {
    if (node.t === 'p' || node.t === 'hsetext') {
      const text = node.lines.join('\n');
      const remaining = extractDefinitions(text, st.refs);
      if (remaining.length === 0) { node.dropped = true; return; }
      node.text = remaining;
      if (node.t === 'hsetext') { node.t = 'h'; node.text = node.text.trim(); }
    } else if (node.t === 'code' || node.t === 'html') {
      let lines = node.lines;
      if (node.t === 'code' && !node.fenced) {
        // strip trailing blank lines from indented code
        let end = lines.length;
        while (end > 0 && lines[end - 1].text.trim() === '') end--;
        lines = lines.slice(0, end);
      }
      if (node.t === 'code' && node.fenced) {
        // fenced code drops exactly one trailing empty line (cm-318:
        // `b` + 2 blank lines renders `b\n\n`); a whitespace-only line
        // is content and is kept (cm-129: `  ` stays)
        if (lines.length > 0 && lines[lines.length - 1].text === '') {
          lines = lines.slice(0, lines.length - 1);
        }
      }
      if (node.t === 'html') {
        let lit = lines.map(l => l.text).join('\n');
        if (lines.length > 0) {
          const lastL = lines[lines.length - 1];
          const isLastLine = lastL.ln === lastLn;
          // a block whose next line is blank carries no trailing \n;
          // type 6/7 blocks only carry one when they end the document.
          // Only a TRULY EMPTY next line counts as blank here: a
          // whitespace-only line (spaces, doc-24, or a tab, doc-15)
          // does not suppress the trailing newline.
          const nextBlank = !isLastLine && st.lines[lastL.ln + 1].length === 0;
          const isBlockTag = node.htmlType === 6 || node.htmlType === 7;
          const wantNl = isBlockTag
            ? (isLastLine && st.endsWithNewline)
            : (!nextBlank && (!isLastLine || st.endsWithNewline));
          if (wantNl) lit += '\n';
        }
        node.literal = lit;
      } else {
        let lit = '';
        for (let k = 0; k < lines.length; k++) {
          const l = lines[k];
          lit += l.text;
          if (!(l.ln === lastLn && !st.endsWithNewline)) lit += '\n';
        }
        node.literal = lit;
      }
    }
  }

  function closeTo(idx) {
    while (open.length > idx) {
      const node = open.pop();
      finalize(node);
    }
  }

  function addNode(node) {
    const parent = tip();
    parent.children.push(node);
    open.push(node);
    return node;
  }

  // Mark the list that directly contains the new block as loose (a blank
  // line separated two blocks inside it). Only that list — not every open
  // list — becomes loose (cm-307: blank lines inside the deepest item make
  // only the deepest list loose). The flag is consumed by the first block
  // after the blank line, so clear it on all lists afterwards.
  function markLoose() {
    const t = tip();
    let list = null;
    if (t.t === 'list') list = t;
    else if (t.t === 'item') {
      for (let k = open.length - 2; k >= 0; k--) {
        if (open[k].t === 'list') { list = open[k]; break; }
        if (open[k].t === 'quote' || open[k].t === 'root') break;
      }
    }
    if (list && list.blankPending) list.loose = true;
    for (let k = 0; k < open.length; k++) {
      if (open[k].t === 'list') open[k].blankPending = false;
    }
  }
  function clearBlankPending() {
    for (let k = 0; k < open.length; k++) {
      const node = open[k];
      if (node.t === 'list') node.blankPending = false;
    }
  }
  function setBlankPending() {
    for (let k = 0; k < open.length; k++) {
      const node = open[k];
      if (node.t === 'list') node.blankPending = true;
    }
  }

  function startsWithListMarker(cur) {
    const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
    const m = parseListMarker(cur);
    cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
    return m !== null;
  }

  // Does the line (from the cursor) start a block that can interrupt a
  // paragraph (and is therefore NOT a lazy continuation)?
  function startsInterruptingBlock(cur) {
    const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
    const r = parseThematicBreak(cur) ||
              parseAtxHeading(cur) !== 0 ||
              parseFence(cur) !== null ||
              htmlBlockType(cur) !== 0 ||
              startsWithBlockquote(cur);
    cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
    return r;
  }

  lineLoop: for (let ln = 0; ln <= lastLn; ln++) {
    const line = lines[ln];
    const cur = { s: line, i: 0, col: 0, pend: 0 };
    const blank = isBlankLine(line);

    // ---- blank line ----
    if (blank) {
      // A blank line closes the innermost open blockquote (and everything
      // inside it). Without a quote, it is content inside a fenced code or
      // HTML block, else it closes the open leaf and marks lists loose.
      let qi = -1;
      for (let k = open.length - 1; k >= 1; k--) {
        if (open[k].t === 'quote') { qi = k; break; }
      }
      if (qi !== -1) {
        closeTo(qi);
        setBlankPending();
        continue;
      }
      const t = tip();
      if (t.t === 'code' || (t.t === 'html' && t.htmlType !== 6 && t.htmlType !== 7)) {
        let txt;
        if (t.t === 'code' && !t.fenced) {
          txt = line.replace(/^ {0,4}/, '');
        } else if (t.t === 'code' && t.fenced) {
          // a whitespace-only line inside a fenced code block also
          // loses up to the fence indent (doc-13: `   ` inside a
          // 2-indent backtick fence renders as ` `, not `   `)
          let s = 0;
          while (s < t.fenceIndent && s < line.length && line.charCodeAt(s) === 32) s++;
          txt = line.slice(s);
        } else {
          txt = line;
        }
        t.lines.push({ text: txt, ln });
        clearBlankPending();
      } else if (t.t === 'table' && line.indexOf('\t') !== -1) {
        // marked quirk (probe t1): a whitespace-only line that contains
        // a tab is a table body row (padded with empty cells), NOT a
        // blank line ending the table. A spaces-only line ends the table.
        t.rows.push(line);
        clearBlankPending();
      } else {
        if (!isContainerNode(t)) closeTo(open.length - 1);
        setBlankPending();
      }
      continue;
    }

    // ---- phase 1: match open containers ----
    let idx = 1;
    let container = root;
    let lazy = false;
    while (idx < open.length) {
      const node = open[idx];
      if (node.t === 'quote') {
        const sI = cur.i, sC = cur.col, sP = cur.pend;
        curSkipSpaces(cur, 3);
        if (curChar(cur) === 62) { // >
          curConsume(cur);
          // only a space (not a tab) follows the `>` marker when the
          // tip is a fenced code block: a tab there is code content,
          // not the marker's optional space (doc-30: `>\t` inside a
          // fenced code block must expand from the blockquote base,
          // not lose 1 column to the marker). Otherwise a tab is
          // consumed as the marker's space (cm-006: `>\t\tfoo`).
          const tipFenced = tip().t === 'code' && tip().fenced;
          if (curChar(cur) === 32 || (curChar(cur) === 9 && !tipFenced)) curAdvance(cur, 1);
          container = node; idx++;
          continue;
        }
        cur.i = sI; cur.col = sC; cur.pend = sP;
        // an empty remainder is not a lazy continuation: it closes the
        // paragraph (like a blank line) AND the unmatched quote — the
        // quote whose `>` is missing is over (doc-33: a bare `>`
        // between two `> >` blocks closes the inner quote so the
        // next `> >` opens a fresh one). Containers below the
        // unmatched quote (e.g. a list item) stay open (doc-08).
        // If the paragraph is a direct child of a list item, the line
        // separates two blocks inside that item, so the item's list
        // becomes loose when the next block starts in it (cm-259).
        if (tip().t === 'p' && cur.i >= cur.s.length) {
          if (open.length >= 2 && open[open.length - 2].t === 'item') {
            for (let k = open.length - 3; k >= 0; k--) {
              if (open[k].t === 'list') { open[k].blankPending = true; break; }
              if (open[k].t === 'quote' || open[k].t === 'root') break;
            }
          }
          closeTo(idx); continue lineLoop;
        }
        if (tip().t === 'p' && !startsWithListMarker(cur) && !startsInterruptingBlock(cur)) { lazy = true; }
        else closeTo(idx);
        break;
      }
      if (node.t === 'list') { container = node; idx++; continue; }
      if (node.t === 'item') {
        // A fenced code block owns its lines: when the line is not
        // indented enough for the item, it is still code content (or
        // the closing fence) — the item stays open and the cursor does
        // not advance (doc-02). When it IS indented enough, advance
        // normally so the item indent is stripped from the code line.
        // But only once the block already has content: if the FIRST
        // line after the opening fence is not indented enough, the
        // block is empty — the line is not code content (doc-13:
        // `  ````sh` followed by `print(...)` at column 0 leaves an
        // empty sh block and the line becomes a paragraph). A BLANK
        // line (empty remainder after container markers) is always
        // owned, even with no content yet (doc-10: `>   ~~~shell`
        // followed by a blank `>` line — the blank line is an empty
        // code line, not the end of the block).
        // A code block inside a blockquote cannot own a line that
        // lacks the `>` marker: without it the quote (and the code
        // inside it) is over, and the line becomes a paragraph in
        // the item (doc-36: `const x = 1;` without `>` after a
        // `> ~~~json` block). When the line does carry a `>`, the
        // quote will be matched next and the owns rule still applies.
        let quoteBetween = false;
        for (let q = idx + 1; q < open.length; q++) if (open[q].t === 'quote') { quoteBetween = true; break; }
        let hasQuoteMarker = true;
        if (quoteBetween) {
          const sI2 = cur.i, sC2 = cur.col, sP2 = cur.pend;
          curSkipSpaces(cur, 3);
          hasQuoteMarker = curChar(cur) === 62;
          cur.i = sI2; cur.col = sC2; cur.pend = sP2;
        }
        if (tip().t === 'code' && tip().fenced && curIndent(cur) < node.contentIndent && (tip().lines.length > 0 || cur.i >= cur.s.length) && hasQuoteMarker) { container = node; idx++; continue; }
        const ind = curIndent(cur);
        // An empty item (no children yet) that a blank line has passed
        // does not accept indented content: the list is over and the
        // line belongs outside it (cm-280: `-\n\n  foo`). A same-type
        // list marker still continues the list (cm-315).
        const itemEmpty = node.children.length === 0;
        const listNode = open[idx - 1];
        const blankPassed = listNode && listNode.t === 'list' && listNode.blankPending;
        if (ind >= node.contentIndent && !(itemEmpty && blankPassed)) {
          curAdvance(cur, node.contentIndent);
          container = node; idx++;
          continue;
        }
        // an empty remainder is not a lazy continuation: it closes the
        // paragraph (like a blank line) but leaves the containers open.
        // If the paragraph is a direct child of a list item, the line
        // separates two blocks inside that item, so the item's list
        // becomes loose when the next block starts in it (cm-259).
        if (tip().t === 'p' && cur.i >= cur.s.length) {
          if (open.length >= 2 && open[open.length - 2].t === 'item') {
            for (let k = open.length - 3; k >= 0; k--) {
              if (open[k].t === 'list') { open[k].blankPending = true; break; }
              if (open[k].t === 'quote' || open[k].t === 'root') break;
            }
          }
          closeTo(open.length - 1); continue lineLoop;
        }
        // A line that is only container markers (e.g. a bare `>` line)
        // is a blank line inside the containers: it does NOT close the
        // list item — the item stays open for the next line (doc-08:
        // `>` between a fenced code block and `>     > Path...` must
        // not close the `+` item). Mark the list loose and move on.
        if (cur.i >= cur.s.length) {
          setBlankPending();
          continue lineLoop;
        }
        if (tip().t === 'p' && !startsWithListMarker(cur) && !startsInterruptingBlock(cur)) { lazy = true; }
        else closeTo(idx);
        break;
      }
      break; // leaf node: stop descending
    }

    const lineStartCol = cur.col;

    // ---- lazy continuation: add the line to the open paragraph ----
    if (lazy) {
      let lt = curText(cur);
      // A lazy line inside a list item loses up to the item's content
      // indent of leading whitespace (cm-291: a 4-space continuation of
      // an item whose content indent is 6 loses all 4 spaces) — but
      // only when the item is NOT inside a blockquote: when a quote
      // prefix was already consumed, the remaining leading space is
      // paragraph content and is kept (doc-06: `>  ![commit]...`
      // keeps its 1 leading space).
      for (let k = open.length - 1; k >= 1; k--) {
        if (open[k].t === 'item') {
          let inQuote = false;
          for (let q = k - 1; q >= 1; q--) if (open[q].t === 'quote') { inQuote = true; break; }
          const ci = open[k].contentIndent;
          // count the leading whitespace columns first: a lazy line
          // with fewer spaces than the content indent loses them all
          // only when it has 4+ of them (doc-22: 4 spaces < indent 5
          // are stripped; doc-06: 1 space < indent 2 is kept), and a
          // line with >= the indent loses exactly the indent. The
          // 4-space threshold applies inside a blockquote too (the
          // inQuote exception only protects < 4 spaces there).
          let col = 0, cut = 0;
          while (cut < lt.length) {
            const ch = lt.charCodeAt(cut);
            if (ch === 32) { col++; cut++; }
            else if (ch === 9) { col = ((col / 4) | 0) * 4 + 4; cut++; }
            else break;
          }
          if (inQuote && col < ci && col < 4) {
            // keep the leading spaces (doc-06)
          } else {
            let col2 = 0, cut2 = 0;
            while (cut2 < lt.length) {
              const ch = lt.charCodeAt(cut2);
              if (ch === 32) { col2++; cut2++; }
              else if (ch === 9) { col2 = ((col2 / 4) | 0) * 4 + 4; cut2++; }
              else break;
              if (col2 >= ci) break;
            }
            if (cut2 > 0) lt = lt.slice(cut2);
          }
          break;
        }
        if (open[k].t === 'quote' || open[k].t === 'root') break;
      }
      // A lazy line that is a list marker after stripping its indent loses
      // the indent (cm-238: `    - bar` continues as `- bar`).
      let ls = 0;
      while (ls < lt.length && (lt.charCodeAt(ls) === 32 || lt.charCodeAt(ls) === 9)) ls++;
      if (ls > 0) {
        const probe = { s: lt, i: ls, col: 0, pend: 0 };
        if (parseListMarker(probe) !== null) lt = lt.slice(ls);
      }
      // A lazy setext-underline line is not a heading; it joins the
      // paragraph carrying 4 leading spaces (cm-093).
      const trimmed = lt.trim();
      if (trimmed.length > 0 && (/^=+$/.test(trimmed) || /^-+$/.test(trimmed))) {
        lt = '    ' + trimmed;
      }
      // Leading tabs in a lazy paragraph line expand to spaces from
      // the line's starting column (doc-40: `> \tindented` as a lazy
      // continuation renders as 2 spaces, not a raw tab).
      tip().lines.push(expandLeadingTabs(lt, cur.col - cur.pend));
      continue;
    }

    // ---- tip-specific handling ----
    let t = tip();
    // fenced code: check for closing fence, else add line
    if (t.t === 'code' && t.fenced) {
      const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
      curSkipSpaces(cur, 3);
      let fLen = 0;
      const fc = curChar(cur);
      if (fc === t.fenceChar.charCodeAt(0)) {
        while (curChar(cur) === fc) { curConsume(cur); fLen++; }
        if (fLen >= t.fenceLen) {
          // rest of line must be only spaces
          let ok = true;
          while (cur.i < cur.s.length) {
            const ch = cur.s.charCodeAt(cur.i);
            if (ch !== 32 && ch !== 9) { ok = false; break; }
            cur.i++;
          }
          if (ok) { closeTo(open.length - 1); continue; }
        }
      }
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      // content line: strip up to fenceIndent spaces. A tab that the
      // container matching only partly consumed leaves its remaining
      // width in cur.pend: that becomes spaces. If the block is nested
      // in a container (list/quote) and the remaining text starts with
      // a tab, the tab expands to the next multiple of 4 from the base
      // column of the code content: 2 for a blockquote parent (fixed,
      // however deep the nesting — a tab after `> > ` still expands
      // from column 2, doc-05), the absolute column for a list-item
      // parent; a top-level block keeps a leading tab raw.
      const saveI2 = cur.i, saveCol2 = cur.col, savePend2 = cur.pend;
      let stripped = 0;
      while (stripped < t.fenceIndent && curChar(cur) === 32) { curConsume(cur); stripped++; }
      let txt = curText(cur);
      if (t.nested && txt.length > 0 && (txt.charCodeAt(0) === 9 || txt.charCodeAt(0) === 32)) {
        // expand the leading whitespace run only if it contains a tab
        let hasTab = false;
        for (let q0 = 0; q0 < txt.length && (txt.charCodeAt(q0) === 32 || txt.charCodeAt(q0) === 9); q0++) {
          if (txt.charCodeAt(q0) === 9) { hasTab = true; break; }
        }
        if (hasTab) {
        const parent = open.length >= 2 ? open[open.length - 2] : null;
        const grandparent = open.length >= 3 ? open[open.length - 3] : null;
        // base column of the code content: 2 when the blockquote
        // parent is itself nested (inside a list item or another
        // quote — doc-05, doc-09, doc-19); but a TOP-LEVEL blockquote
        // (grandparent is the document root) expands from the current
        // column, which already includes the fence-indent stripping
        // (doc-26: `>   \t` after a 2-space fence indent expands from
        // column 4 to 4 spaces). A list-item parent expands from
        // the current column.
        let col;
        if (parent && parent.t === 'quote') {
          col = (grandparent && grandparent.t === 'doc') ? cur.col : 2;
        } else {
          col = cur.col;
        }
        let out = '';
        let q = 0;
        while (q < txt.length && (txt.charCodeAt(q) === 32 || txt.charCodeAt(q) === 9)) {
          if (txt.charCodeAt(q) === 9) {
            const nx = ((col / 4) | 0) * 4 + 4;
            out += ' '.repeat(nx - col);
            col = nx;
          } else { out += ' '; col++; }
          q++;
        }
        txt = out + txt.slice(q);
        }
      }
      t.lines.push({ text: txt, ln });
      clearBlankPending();
      continue;
    }
    // indented code: indented line continues, else close and re-process
    if (t.t === 'code' && !t.fenced) {
      if (curIndent(cur) >= 4) {
        curAdvance(cur, 4);
        t.lines.push({ text: curText(cur), ln });
        clearBlankPending();
        continue;
      }
      closeTo(open.length - 1);
      t = tip();
      // fall through to new-block detection (container may have changed)
      container = t;
      // re-run phase-1 matching for the containers that are still open is
      // unnecessary: the line was already matched against them above.
    }
    // html block
    if (t.t === 'html') {
      t.lines.push({ text: curText(cur), ln });
      clearBlankPending();
      let endBlock = false;
      if (t.htmlType === 1) {
        const low = line.toLowerCase();
        if (low.includes('</script') || low.includes('</pre') || low.includes('</style') || low.includes('</textarea')) endBlock = true;
      } else if (t.htmlType === 2) { if (line.includes('-->')) endBlock = true; }
      else if (t.htmlType === 3) { if (line.includes('?>')) endBlock = true; }
      else if (t.htmlType === 4) { if (line.includes('>')) endBlock = true; }
      else if (t.htmlType === 5) { if (line.includes(']]>')) endBlock = true; }
      if (endBlock) closeTo(open.length - 1);
      continue;
    }
    // table: row or end
    if (t.t === 'table') {
      // check for an interrupting new block first
      const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
      const atx = parseAtxHeading(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const fence = parseFence(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const isHr = parseThematicBreak(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const lm = parseListMarker(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const hb = htmlBlockType(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const bq = startsWithBlockquote(cur);
      if (atx === 0 && fence === null && !isHr && lm === null && hb === 0 && !bq) {
        t.rows.push(curText(cur));
        clearBlankPending();
        continue;
      }
      closeTo(open.length - 1);
      t = tip();
      container = t;
    }
    // paragraph: setext / table delimiter / interruption / continuation
    if (t.t === 'p') {
      // A line whose remainder is empty after container matching (e.g. a
      // bare `>` line) contributes no content: it closes the paragraph,
      // like a blank line inside the container. A remainder of only
      // spaces still counts as content (cm-241: `>  ` adds a ` ` line).
      if (cur.i >= cur.s.length) {
        closeTo(open.length - 1);
        continue;
      }
      const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
      const setext = parseSetextUnderline(cur);
      if (setext !== 0) {
        // a paragraph that so far consists only of link reference
        // definitions has no heading text: the underline stays a line (cm-216)
        const remaining = extractDefinitions(t.lines.join('\n'), st.refs);
        if (remaining.trim() !== '') {
          // convert paragraph to setext heading
          t.t = 'hsetext';
          t.level = setext;
          closeTo(open.length - 1);
          continue;
        }
        // else: fall through and add the underline as a paragraph line
      }
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      // table delimiter? (paragraph has exactly 1 line so far)
      if (t.lines.length === 1) {
        const aligns = parseDelimiterRow(curText(cur));
        if (aligns !== null) {
          const headerCells = splitTableRow(t.lines[0]);
          if (headerCells.length === aligns.length && headerCells.length > 0) {
            t.t = 'table';
            t.header = t.lines[0];
            t.aligns = aligns;
            t.rows = [];
            delete t.lines;
            continue;
          }
        }
      }
      // interrupting blocks?
      const atx = parseAtxHeading(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const fence = parseFence(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const isHr = parseThematicBreak(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const hb = htmlBlockType(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const lm = parseListMarker(cur);
      cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      const bq = startsWithBlockquote(cur);
      const interrupts = atx !== 0 || fence !== null || isHr || (hb !== 0 && hb !== 7) || bq ||
        (lm !== null && !lm.atEol && (lm.bullet || lm.start === 1 ||
          // inside a list item any ordered list starts a sub-list,
          // so the "only 1 interrupts" rule does not apply (doc-01
          // `505791.`, doc-04 `382900.`, doc-10 `0)`)
          (open.length >= 2 && open[open.length - 2].t === 'item')));
      if (!interrupts) {
        t.lines.push(expandLeadingTabs(curText(cur), cur.col - cur.pend));
        continue;
      }
      // close the paragraph and fall through to new-block detection
      closeTo(open.length - 1);
      t = tip();
      container = t;
    }

    // ---- phase 2: open new blocks in the current container ----
    // Loop: after opening a container (blockquote / list item), the remainder
    // of the line is processed again as new blocks inside it.
    phase2: while (true) {
      if (curIsBlank(cur)) break phase2;
      // If the tip is a list and the line is not a matching item, close the list.
      if (tip().t === 'list') {
        const sI0 = cur.i, sC0 = cur.col, sP0 = cur.pend;
        const lm0 = parseListMarker(cur);
        cur.i = sI0; cur.col = sC0; cur.pend = sP0;
        const lst = tip();
        const matches = lm0 !== null && ((lm0.bullet && lst.bullet && lm0.markerChar === lst.markerChar) ||
          (lm0.ordered && !lst.bullet && lm0.delim === lst.delim));
        if (!matches || startsInterruptingBlock(cur)) {
          closeTo(open.length - 1);
        }
      }
      // blockquote
      {
        const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
        curSkipSpaces(cur, 3);
        if (curChar(cur) === 62) { // >
          markLoose();
          curConsume(cur);
          if (curChar(cur) === 32 || curChar(cur) === 9) curAdvance(cur, 1);
          const node = { t: 'quote', children: [] };
          addNode(node);
          continue phase2;
        }
        cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      }
      // ATX heading
      {
        const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
        const level = parseAtxHeading(cur);
        if (level !== 0) {
          markLoose();
          let headingText = curText(cur).trim();
          // a closing sequence is trailing #s preceded by a space, or the
          // entire (trimmed) content being #s
          if (/^#+$/.test(headingText)) headingText = '';
          else headingText = headingText.replace(/[ \t]+#+$/, '').trim();
          const node = { t: 'h', level, lines: [headingText] };
          node.text = headingText;
          addNode(node);
          closeTo(open.length - 1);
          continue lineLoop;
        }
        cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      }
      // fenced code
      {
        const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
        const fence = parseFence(cur);
        if (fence !== null) {
          markLoose();
          let info = curText(cur).trim();
          if (fence.char === '`' && info.indexOf('`') !== -1) {
            cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
          } else {
            // Backtick fences strip up to the fence indent from content
            // lines (cm-131/132/133); tilde fences do NOT strip any
            // indent (doc-22, T1–T3, U1–U2: a `~~~ts` fence at indent N
            // keeps all N spaces on its content lines).
            const node = { t: 'code', fenced: true, fenceChar: fence.char, fenceLen: fence.len, info: info, fenceIndent: fence.char === '`' ? fence.indent : 0, nested: tip().t !== 'doc', lines: [] };
            addNode(node);
            continue lineLoop;
          }
        } else {
          cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
        }
      }
      // html block
      {
        const hb = htmlBlockType(cur);
        if (hb !== 0) {
          markLoose();
          const node = { t: 'html', htmlType: hb, lines: [{ text: curText(cur), ln }] };
          addNode(node);
          let endNow = false;
          if (hb === 1) {
            const low = line.toLowerCase();
            if (low.includes('</script') || low.includes('</pre') || low.includes('</style') || low.includes('</textarea')) endNow = true;
          } else if (hb === 2) { if (line.includes('-->')) endNow = true; }
          else if (hb === 3) { if (line.includes('?>')) endNow = true; }
          else if (hb === 4) { if (line.includes('>')) endNow = true; }
          else if (hb === 5) { if (line.includes(']]>')) endNow = true; }
          if (endNow) closeTo(open.length - 1);
          continue lineLoop;
        }
      }
      // thematic break
      {
        const saveI = cur.i, saveCol = cur.col, savePend = cur.pend;
        if (parseThematicBreak(cur)) {
          markLoose();
          const node = { t: 'hr' };
          addNode(node);
          closeTo(open.length - 1);
          continue lineLoop;
        }
        cur.i = saveI; cur.col = saveCol; cur.pend = savePend;
      }
      // list
      {
        const listStartCol = cur.col;
        const lm = parseListMarker(cur);
        if (lm !== null) {
          markLoose();
          const markerChar = lm.markerChar;
          const delim = lm.delim;
          let listNode = null;
          if (tip().t === 'list') {
            const lst = tip();
            if ((lm.bullet && lst.bullet && markerChar === lst.markerChar) ||
                (lm.ordered && !lst.bullet && delim === lst.delim)) {
              listNode = lst;
            }
          }
          if (listNode === null) {
            if (tip().t === 'list') closeTo(open.length - 1);
            listNode = { t: 'list', bullet: lm.bullet, start: lm.ordered ? lm.start : null, markerChar: markerChar, delim: delim, loose: false, blankPending: false, children: [] };
            addNode(listNode);
          }
          const item = { t: 'item', contentIndent: lm.contentIndent, children: [] };
          listNode.children.push(item);
          open.push(item);
          const targetCol = listStartCol + lm.contentIndent;
          curAdvance(cur, targetCol - cur.col);
          continue phase2;
        }
      }
      // indented code (only when not in a paragraph — paragraphs were handled above)
      if (curIndent(cur) >= 4) {
        markLoose();
        curAdvance(cur, 4);
        const node = { t: 'code', fenced: false, info: '', lines: [{ text: curText(cur), ln }] };
        addNode(node);
        clearBlankPending();
        continue lineLoop;
      }
      // paragraph (default)
      markLoose();
      {
        const node = { t: 'p', lines: [expandLeadingTabs(curText(cur), cur.col - cur.pend)] };
        addNode(node);
        continue lineLoop;
      }
    }
  }

  closeTo(1);
  return root.children;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, st) {
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += renderBlock(blocks[k], st, false);
  return html;
}

function renderBlock(node, st, tightParent) {
  switch (node.t) {
    case 'p': {
      if (node.dropped) return '';
      if (tightParent) return parseInline(node.text, st.refs, st);
      return '<p>' + parseInline(node.text, st.refs, st) + '</p>\n';
    }
    case 'h': {
      if (node.dropped) return '';
      return '<h' + node.level + '>' + parseInline(node.text, st.refs, st) + '</h' + node.level + '>\n';
    }
    case 'code': {
      let info = '';
      if (node.info) {
        const first = node.info.split(/\s+/)[0];
        if (first) {
          // backslash escapes are processed in the info string
          const unesc = first.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
          info = ' class="language-' + escapeAttr(unesc) + '"';
        }
      }
      return '<pre><code' + info + '>' + escapeCode(node.literal) + '</code></pre>\n';
    }
    case 'html': {
      return node.literal;
    }
    case 'hr': return '<hr>\n';
    case 'quote': {
      return '<blockquote>\n' + renderBlocks(node.children, st) + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.bullet ? 'ul' : 'ol';
      const startAttr = (!node.bullet && node.start !== null && node.start !== 1) ? ' start="' + node.start + '"' : '';
      let inner = '';
      for (let k = 0; k < node.children.length; k++) inner += renderBlock(node.children[k], st, node.loose);
      return '<' + tag + startAttr + '>\n' + inner + '</' + tag + '>\n';
    }
    case 'item': {
      const loose = tightParent; // tightParent carries the list's loose flag here
      let out = '<li>';
      const kids = node.children;
      for (let k = 0; k < kids.length; k++) {
        const child = kids[k];
        // task list: a leading "[ ] " / "[x] " in the first paragraph becomes
        // a disabled checkbox
        if (k === 0 && child.t === 'p' && !child.dropped) {
          const m = child.text.match(/^\[( |x|X)\] /);
          if (m) {
            const checked = m[1] === 'x' || m[1] === 'X';
            const box = checked
              ? '<input checked="" disabled="" type="checkbox">'
              : '<input disabled="" type="checkbox">';
            const rest = child.text.slice(4);
            if (!loose) out += box + ' ' + parseInline(rest, st.refs, st);
            else out += '<p>' + box + ' ' + parseInline(rest, st.refs, st) + '</p>\n';
            continue;
          }
        }
        out += renderBlock(child, st, !loose);
      }
      out += '</li>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      const headerCells = splitTableRow(node.header);
      for (let k = 0; k < headerCells.length; k++) {
        const align = node.aligns[k];
        out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + parseInline(headerCells[k].trim(), st.refs, st) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (let r = 0; r < node.rows.length; r++) {
          const cells = splitTableRow(node.rows[r]);
          out += '<tr>\n';
          for (let k = 0; k < headerCells.length; k++) {
            const align = node.aligns[k];
            const cell = k < cells.length ? cells[k].trim() : '';
            out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + parseInline(cell, st.refs, st) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
  }
  return '';
}
