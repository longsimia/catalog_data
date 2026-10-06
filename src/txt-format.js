'use strict';

// This intentionally supports only the six TXT formats, not arbitrary HTML
// or the block structures of general-purpose Markdown.
const TOKENS = [
  { token: '***', marks: ['bold', 'italic'] },
  { token: '**', marks: ['bold'] },
  { token: '__', marks: ['underline'] },
  { token: '~~', marks: ['strike'] },
  { token: '*', marks: ['italic'] }
];
const MARKS = ['bold', 'italic', 'underline', 'strike'];
const MARK_TOKEN = { bold: '**', italic: '*', underline: '__', strike: '~~' };
const ESCAPABLE = /[\\*_[\]~>()]/;

function normalize(text) { return String(text ?? '').replace(/\r\n?/g, '\n'); }
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeLiteral(text) { return String(text).replace(/[\\*_[\]~>]/g, '\\$&'); }
function safeUrl(value, allowBare = false) {
  let input = String(value || '').trim().replace(/\\([\\()])/g, '$1');
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) return '';
  if (allowBare && !/^[a-z][a-z0-9+.-]*:/i.test(input)) input = 'https://' + input;
  try {
    const url = new URL(input);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function findClosing(text, token, start, limit) {
  for (let i = start; i < limit; i++) {
    if (text[i] === '\\' && ESCAPABLE.test(text[i + 1] || '')) { i++; continue; }
    if (token[0] === '*' && text[i] === '*') {
      let end = i;
      while (end < limit && text[end] === '*') end++;
      const count = end - i;
      if (count >= token.length && (token.length !== 1 || count !== 2)) {
        return end - token.length;
      }
      i = end - 1;
    } else if (text.startsWith(token, i)) return i;
  }
  return -1;
}

function parseInline(text, start = 0, limit = text.length, depth = 0) {
  const nodes = [];
  let plainStart = start;
  function flush(to) {
    if (to > plainStart) nodes.push({ type: 'text', from: plainStart, to, text: text.slice(plainStart, to) });
  }
  for (let i = start; i < limit;) {
    if (text[i] === '\\' && i + 1 < limit && ESCAPABLE.test(text[i + 1])) {
      flush(i);
      nodes.push({ type: 'text', from: i, to: i + 2, text: text[i + 1], escaped: true });
      i += 2; plainStart = i; continue;
    }
    if (depth < 32 && text[i] === '[') {
      let labelEnd = i + 1;
      for (; labelEnd < limit; labelEnd++) {
        if (text[labelEnd] === '\\') { labelEnd++; continue; }
        if (text.startsWith('](', labelEnd)) break;
      }
      if (labelEnd < limit) {
        let level = 1, urlEnd = labelEnd + 2;
        for (; urlEnd < limit; urlEnd++) {
          if (text[urlEnd] === '\\') { urlEnd++; continue; }
          if (text[urlEnd] === '(') level++;
          else if (text[urlEnd] === ')' && --level === 0) break;
        }
        const href = level === 0 ? safeUrl(text.slice(labelEnd + 2, urlEnd)) : '';
        if (href && labelEnd > i + 1) {
          flush(i);
          nodes.push({
            type: 'link', from: i, to: urlEnd + 1, contentFrom: i + 1,
            contentTo: labelEnd, href, children: parseInline(text, i + 1, labelEnd, depth + 1)
          });
          i = urlEnd + 1; plainStart = i; continue;
        }
      }
    }
    let matched = false;
    if (depth < 32) {
      for (const spec of TOKENS) {
        if (!text.startsWith(spec.token, i)) continue;
        const close = findClosing(text, spec.token, i + spec.token.length, limit);
        if (close <= i + spec.token.length) continue;
        const body = text.slice(i + spec.token.length, close);
        if (!body || !/[^*_~]/.test(body)) continue;
        flush(i);
        nodes.push({
          type: 'format', from: i, to: close + spec.token.length,
          contentFrom: i + spec.token.length, contentTo: close,
          marks: spec.marks, children: parseInline(text, i + spec.token.length, close, depth + 1)
        });
        i = close + spec.token.length; plainStart = i; matched = true; break;
      }
    }
    if (!matched) i++;
  }
  flush(limit);
  return nodes;
}

function parse(text) {
  const source = normalize(text);
  const lines = [], segments = [], hidden = [], formats = [], links = [];
  let sourceOffset = 0, visibleOffset = 0;
  function walk(nodes, line, activeMarks = [], href = null) {
    for (const node of nodes) {
      const from = line.bodyStart + node.from, to = line.bodyStart + node.to;
      if (node.type === 'text') {
        if (node.escaped) hidden.push({ from, to: from + 1 });
        const segment = {
          from: from + (node.escaped ? 1 : 0), to, rawFrom: from,
          text: node.text, marks: activeMarks, href,
          visibleFrom: visibleOffset, visibleTo: visibleOffset + node.text.length
        };
        segments.push(segment); line.segments.push(segment); visibleOffset = segment.visibleTo;
      } else {
        const contentFrom = line.bodyStart + node.contentFrom;
        const contentTo = line.bodyStart + node.contentTo;
        hidden.push({ from, to: contentFrom }, { from: contentTo, to });
        if (node.type === 'link') {
          links.push({ from, to, contentFrom, contentTo, href: node.href });
          walk(node.children, line, activeMarks, node.href);
        } else {
          const marks = [...new Set([...activeMarks, ...node.marks])];
          formats.push({ from: contentFrom, to: contentTo, marks: node.marks });
          walk(node.children, line, marks, href);
        }
      }
    }
  }
  const rawLines = source.split('\n');
  rawLines.forEach((raw, index) => {
    const prefix = /^(?:> |>$)/.exec(raw)?.[0] || '';
    const body = raw.slice(prefix.length);
    const line = {
      from: sourceOffset, to: sourceOffset + raw.length, bodyStart: sourceOffset + prefix.length,
      raw, prefix, quote: !!prefix, nodes: parseInline(body), segments: [], visibleFrom: visibleOffset
    };
    if (prefix) hidden.push({ from: line.from, to: line.bodyStart });
    walk(line.nodes, line);
    line.visibleTo = visibleOffset;
    line.text = line.segments.map(segment => segment.text).join('');
    lines.push(line);
    if (index < rawLines.length - 1) {
      segments.push({
        from: line.to, to: line.to + 1, rawFrom: line.to, text: '\n', marks: [], href: null,
        visibleFrom: visibleOffset, visibleTo: ++visibleOffset, newline: true
      });
    }
    sourceOffset = line.to + 1;
  });
  hidden.sort((a, b) => a.from - b.from || a.to - b.to);
  const mergedHidden = [];
  for (const range of hidden) {
    const last = mergedHidden[mergedHidden.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else if (range.to > range.from) mergedHidden.push({ ...range });
  }
  return {
    source, lines, segments, hidden: mergedHidden, formats, links,
    text: segments.map(segment => segment.text).join('')
  };
}

function renderNodes(nodes) {
  return nodes.map(node => {
    if (node.type === 'text') return escapeHtml(node.text);
    let body = renderNodes(node.children);
    if (node.type === 'link') {
      return '<a class="txt-format-link" href="' + escapeHtml(node.href) +
        '" target="_blank" rel="noopener noreferrer">' + body + '</a>';
    }
    for (const mark of [...node.marks].reverse()) {
      const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' }[mark];
      body = '<' + tag + '>' + body + '</' + tag + '>';
    }
    return body;
  }).join('');
}

function render(text) {
  const model = parse(text);
  const groups = [];
  for (const line of model.lines) {
    let group = groups[groups.length - 1];
    if (!group || group.quote !== line.quote) { group = { quote: line.quote, lines: [] }; groups.push(group); }
    group.lines.push(renderNodes(line.nodes));
  }
  return groups.map(group => {
    const tag = group.quote ? 'blockquote' : 'div';
    return '<' + tag + ' class="' + (group.quote ? 'txt-format-quote' : 'txt-format-lines') + '">' +
      group.lines.join('\n') + '</' + tag + '>';
  }).join('');
}

function visibleAt(model, sourcePosition) {
  const position = Math.max(0, Math.min(model.source.length, Number(sourcePosition) || 0));
  for (const segment of model.segments) {
    if (position <= segment.from) return segment.visibleFrom;
    if (position <= segment.to) return segment.visibleFrom + position - segment.from;
  }
  return model.text.length;
}

function sourceAt(model, visiblePosition, association = 1) {
  const position = Math.max(0, Math.min(model.text.length, Number(visiblePosition) || 0));
  if (association < 0) {
    for (const segment of model.segments) {
      if (position > segment.visibleFrom && position <= segment.visibleTo) return segment.from + position - segment.visibleFrom;
    }
  } else {
    for (const segment of model.segments) {
      if (position >= segment.visibleFrom && position < segment.visibleTo) return segment.from + position - segment.visibleFrom;
    }
  }
  const lastLine = model.lines[model.lines.length - 1];
  if (position === model.text.length && lastLine && lastLine.visibleFrom === lastLine.visibleTo) return lastLine.bodyStart;
  if (position === 0) return model.segments[0]?.from ?? model.lines[0]?.bodyStart ?? 0;
  return model.segments[model.segments.length - 1]?.to ?? model.source.length;
}

function sourceRange(model, visibleFrom, visibleTo) {
  const from = sourceAt(model, visibleFrom, 1);
  return { from, to: visibleFrom === visibleTo ? from : sourceAt(model, visibleTo, -1) };
}

function selectedRuns(model, from, to) {
  const start = visibleAt(model, from), end = visibleAt(model, to);
  return model.segments.filter(segment => !segment.newline && segment.visibleTo > start && segment.visibleFrom < end);
}

function serializeRuns(runs) {
  let result = '', stack = [];
  const descriptor = run => [
    ...(run.href ? [{ key: 'link:' + run.href, token: '[', close: '](' + run.href.replace(/[\\()]/g, '\\$&') + ')' }] : []),
    ...MARKS.filter(mark => run.marks.includes(mark)).map(mark => ({ key: mark, token: MARK_TOKEN[mark], close: MARK_TOKEN[mark] }))
  ];
  for (const run of runs) {
    if (!run.text) continue;
    const next = descriptor(run);
    let shared = 0;
    while (shared < stack.length && shared < next.length && stack[shared].key === next[shared].key) shared++;
    for (let i = stack.length - 1; i >= shared; i--) result += stack[i].close;
    for (let i = shared; i < next.length; i++) result += next[i].token;
    result += escapeLiteral(run.text);
    stack = next;
  }
  for (let i = stack.length - 1; i >= 0; i--) result += stack[i].close;
  return result;
}

function applyChanges(text, changes) {
  let result = text;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  }
  return result;
}

function formatSelection(text, from, to, command, href = null) {
  const model = parse(text), start = visibleAt(model, from), end = visibleAt(model, to);
  if (start === end) return null;
  const selected = selectedRuns(model, from, to);
  const remove = command !== 'link' && selected.length && selected.every(run => run.marks.includes(command));
  const changes = [];
  for (const line of model.lines) {
    if (line.visibleTo <= start || line.visibleFrom >= end) continue;
    const runs = [];
    for (const segment of line.segments) {
      const a = Math.max(0, Math.min(segment.text.length, start - segment.visibleFrom));
      const b = Math.max(a, Math.min(segment.text.length, end - segment.visibleFrom));
      if (a) runs.push({ ...segment, text: segment.text.slice(0, a) });
      if (b > a) {
        const next = { ...segment, text: segment.text.slice(a, b), marks: [...segment.marks] };
        if (command === 'link') next.href = href;
        else next.marks = remove ? next.marks.filter(mark => mark !== command) : [...new Set([...next.marks, command])];
        runs.push(next);
      }
      if (b < segment.text.length) runs.push({ ...segment, text: segment.text.slice(b) });
    }
    const insert = serializeRuns(runs);
    if (insert !== model.source.slice(line.bodyStart, line.to)) changes.push({ from: line.bodyStart, to: line.to, insert });
  }
  const result = applyChanges(model.source, changes);
  return { text: result, changes, ...sourceRange(parse(result), start, end) };
}

function quoteSelection(text, from, to) {
  const model = parse(text), start = visibleAt(model, from), end = visibleAt(model, to);
  let first = model.lines.findIndex(line => line.visibleTo >= start);
  let last = model.lines.findIndex(line => line.visibleTo >= Math.max(start, end - 1));
  if (first < 0) first = model.lines.length - 1;
  if (last < 0) last = model.lines.length - 1;
  while (first > 0 && model.lines[first - 1].text.trim()) first--;
  while (last + 1 < model.lines.length && model.lines[last + 1].text.trim()) last++;
  const selected = model.lines.slice(first, last + 1);
  const remove = selected.filter(line => line.text.trim()).every(line => line.quote);
  const changes = selected.map(line => ({ from: line.from, to: line.bodyStart, insert: remove ? '' : '> ' }));
  const result = applyChanges(model.source, changes);
  return { text: result, changes, ...sourceRange(parse(result), start, end) };
}

function replaceVisible(text, visibleFrom, visibleTo, replacement) {
  const model = parse(text);
  const start = Math.max(0, Math.min(model.text.length, visibleFrom));
  const end = Math.max(start, Math.min(model.text.length, visibleTo));
  let first = model.lines.findIndex(line => line.visibleTo >= start);
  let last = model.lines.findIndex(line => line.visibleTo >= end);
  if (first < 0) first = model.lines.length - 1;
  if (last < 0) last = model.lines.length - 1;
  const inherited = model.segments.find(segment => !segment.newline && segment.visibleFrom <= start && segment.visibleTo > start) ||
    model.segments.find(segment => !segment.newline && segment.visibleTo === start) || { marks: [], href: null };
  const runs = [];
  for (const segment of model.segments) {
    if (segment.visibleFrom < model.lines[first].visibleFrom || segment.visibleTo > model.lines[last].visibleTo) continue;
    const a = Math.max(0, Math.min(segment.text.length, start - segment.visibleFrom));
    if (a) runs.push({ ...segment, text: segment.text.slice(0, a) });
  }
  runs.push({ text: normalize(replacement), marks: inherited.marks, href: inherited.href });
  for (const segment of model.segments) {
    if (segment.visibleFrom < model.lines[first].visibleFrom || segment.visibleTo > model.lines[last].visibleTo) continue;
    const b = Math.max(0, Math.min(segment.text.length, end - segment.visibleFrom));
    if (b < segment.text.length) runs.push({ ...segment, text: segment.text.slice(b) });
  }
  const rebuilt = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, i) => { if (i) rebuilt.push([]); if (part) rebuilt[rebuilt.length - 1].push({ ...run, text: part }); });
  }
  const quote = model.lines[first].quote;
  const insert = rebuilt.map(lineRuns => (quote ? '> ' : '') + serializeRuns(lineRuns)).join('\n');
  const changes = [{ from: model.lines[first].from, to: model.lines[last].to, insert }];
  const result = applyChanges(model.source, changes);
  const mark = sourceRange(parse(result), start + normalize(replacement).length, start + normalize(replacement).length);
  return { text: result, changes, ...mark };
}

function transformText(text, convert) {
  const model = parse(text), changes = [];
  for (const segment of model.segments) {
    if (segment.newline) continue;
    const next = String(convert(segment.text));
    if (next !== segment.text) changes.push({ from: segment.rawFrom, to: segment.to, insert: escapeLiteral(next) });
  }
  return applyChanges(model.source, changes);
}

function addCjkSpacing(text) {
  let source = normalize(text);
  let model = parse(source);
  const spaces = Array.from(model.text.matchAll(/ {2,}/g));
  for (let i = spaces.length - 1; i >= 0; i--) {
    source = replaceVisible(source, spaces[i].index, spaces[i].index + spaces[i][0].length, ' ').text;
  }
  model = parse(source);
  const closes = new Map();
  function collect(nodes, offset) {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      const from = offset + node.contentTo;
      if (!closes.has(from)) closes.set(from, []);
      closes.get(from).push(offset + node.to);
      collect(node.children, offset);
    }
  }
  model.lines.forEach(line => collect(line.nodes, line.bodyStart));
  const boundary = /([\p{Script=Han}])([A-Za-z0-9@#&%+\-=*_\/\\|])|([A-Za-z0-9@#&%+\-=*_\/\\|])([\p{Script=Han}])/gu;
  const changes = [];
  for (const line of model.lines) {
    boundary.lastIndex = 0;
    let match;
    while ((match = boundary.exec(line.text))) {
      const at = line.visibleFrom + match.index + (match[1] || match[3]).length;
      let position = sourceAt(model, at, -1);
      const right = sourceAt(model, at, 1);
      for (let i = 0; i < 32; i++) {
        const endings = (closes.get(position) || []).filter(to => to <= right);
        if (!endings.length) break;
        position = Math.max(...endings);
      }
      changes.push({ from: position, to: position, insert: ' ' });
      boundary.lastIndex = match.index + (match[1] || match[3]).length;
    }
  }
  return applyChanges(source, changes);
}

function indent(text, add, indentation = '\u3000\u3000') {
  const model = parse(text), changes = [];
  for (const line of model.lines) {
    if (!line.text.trim()) continue;
    if (add && !line.text.startsWith(indentation)) changes.push({ from: line.bodyStart, to: line.bodyStart, insert: indentation });
    else if (!add && line.text.startsWith(indentation)) {
      const result = replaceVisible(line.raw, 0, indentation.length, '');
      changes.push({ from: line.from, to: line.to, insert: result.text });
    }
  }
  return applyChanges(model.source, changes);
}

function blankLines(text, add) {
  const model = parse(text);
  if (!add) return model.lines.filter(line => line.text.trim()).map(line => line.raw).join('\n');
  return model.lines.map((line, i) => {
    if (i === model.lines.length - 1) return line.raw;
    return line.raw + '\n' + (line.quote && model.lines[i + 1].quote ? '> ' : '');
  }).join('\n');
}

module.exports = {
  parse, render, safeUrl, escapeHtml, escapeLiteral, visibleAt, sourceAt, sourceRange,
  selectedRuns, formatSelection, quoteSelection, replaceVisible, transformText,
  indent, blankLines, addCjkSpacing, applyChanges
};
