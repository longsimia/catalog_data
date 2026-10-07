import { Compartment, EditorState, StateField } from '@codemirror/state';
import { insertNewline } from '@codemirror/commands';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import TxtFormat from './txt-format.js';
import { createFormattingUI } from './txt-formatting-ui.js';

const PARAGRAPH_INDENT = '\u3000\u3000';

function clampPosition(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Math.trunc(number), length));
}

function buildParagraphEntries(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const entries = [];
  let offset = 0;
  let start = -1;
  let end = -1;
  let entryLines = [];
  const pushEntry = () => {
    if (start < 0 || !entryLines.length) return;
    entries.push({
      sourceIndex: entries.length,
      start,
      end,
      text: entryLines.join('\n'),
      firstLine: (entryLines.find(line => line.trim()) || '').replace(/\s+/g, ' ').trim()
    });
    start = -1;
    end = -1;
    entryLines = [];
  };
  lines.forEach((line, index) => {
    const lineStart = offset;
    const hasBreak = index < lines.length - 1;
    offset += line.length + (hasBreak ? 1 : 0);
    if (line.trim()) {
      if (start < 0) start = lineStart;
      entryLines.push(line);
      end = offset - (hasBreak ? 1 : 0);
    } else {
      pushEntry();
    }
  });
  pushEntry();
  return entries;
}

function paragraphFingerprint(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 120)}\u0000${normalized.slice(-120)}`;
}

function shouldContinueParagraphIndent(state, from, to, text, composing) {
  if (composing || text !== '\n' || from !== to) return false;
  const line = state.doc.lineAt(from);
  return state.sliceDoc(line.from, from).startsWith(PARAGRAPH_INDENT);
}

function insertContinuedParagraphIndent(view) {
  const selection = view.state.selection.main;
  if (!shouldContinueParagraphIndent(view.state, selection.from, selection.to, '\n', view.composing)) {
    return false;
  }
  const insert = `\n${PARAGRAPH_INDENT}`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.type'
  });
  return true;
}

function insertParagraphBreak(view) {
  if (view.composing) return false;
  return insertContinuedParagraphIndent(view) || insertNewline(view);
}

function insertPlainParagraphBreak(view) {
  return view.composing ? false : insertNewline(view);
}

const paragraphIndentInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (!shouldContinueParagraphIndent(view.state, from, to, text, view.composing)) return false;
  const insert = `\n${PARAGRAPH_INDENT}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    userEvent: 'input.type'
  });
  return true;
});

function createTxtEditor(textarea, host, options = {}) {
  if (!textarea || !host) return null;

  const initialValue = textarea.value || '';
  let defaultValue = textarea.defaultValue || initialValue;
  let view = null;
  let suppressInput = 0;
  let scrollRequestToken = 0;
  let pendingNavigationPosition = null;
  let tocPersistTimer = 0;
  let tocAnchorsInitialized = false;
  let formattingUI = null;
  let displayMode = 'markdown';
  const modeCompartment = new Compartment();
  const tocStorageKey = String(options.tocStorageKey || '');
  const modeStorageKey = 'preview-txt-display-mode:' + tocStorageKey;
  try { if (sessionStorage.getItem(modeStorageKey) === 'plain') displayMode = 'plain'; } catch {}
  const trackedTocAnchors = new Map();

  function buildFormatting(state) {
    const model = TxtFormat.parse(state.doc.toString());
    const decorations = [], atomic = [];
    for (const range of model.hidden) {
      const hidden = Decoration.replace({ inclusive: false }).range(range.from, range.to);
      decorations.push(hidden); atomic.push(hidden);
    }
    for (const range of model.formats) {
      if (range.from < range.to) decorations.push(Decoration.mark({
        class: range.marks.map(mark => 'txt-format-' + mark).join(' ')
      }).range(range.from, range.to));
    }
    for (const link of model.links) {
      if (link.contentFrom < link.contentTo) decorations.push(Decoration.mark({
        tagName: 'a', class: 'txt-format-link',
        attributes: { href: link.href, target: '_blank', rel: 'noopener noreferrer' }
      }).range(link.contentFrom, link.contentTo));
    }
    for (const line of model.lines) {
      if (line.quote) decorations.push(Decoration.line({ class: 'txt-format-quote' }).range(line.from));
    }
    return { model, decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
  }
  const formattingField = StateField.define({
    create: buildFormatting,
    update(value, transaction) { return transaction.docChanged ? buildFormatting(transaction.state) : value; },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(editorView => editorView.state.field(field).atomic)
    ]
  });
  const getFormatModel = () => view?.state.field(formattingField, false)?.model || TxtFormat.parse(textarea.value);

  function changeFormattedText(result) {
    if (!result || !result.changes.length || result.text === textarea.value) return false;
    textarea.dispatchEvent(new CustomEvent('txt-format-beforechange', { bubbles: false }));
    view.dispatch({
      changes: result.changes,
      selection: { anchor: result.from, head: result.to },
      scrollIntoView: false, userEvent: 'input.format'
    });
    view.focus();
    return true;
  }

  function markdownParagraphBreak(editorView, plainBreak = false) {
    if (editorView.composing) return false;
    const selection = editorView.state.selection.main;
    const model = getFormatModel();
    const line = model.lines[editorView.state.doc.lineAt(selection.head).number - 1];
    if (!line) return false;
    if (line.quote && selection.empty && !line.text.trim()) {
      editorView.dispatch({
        changes: { from: line.from, to: line.bodyStart, insert: '' },
        selection: { anchor: Math.max(line.from, selection.head - line.prefix.length) },
        userEvent: 'input.type', scrollIntoView: true
      });
      return true;
    }
    const visibleFrom = TxtFormat.visibleAt(model, selection.from);
    const visibleTo = TxtFormat.visibleAt(model, selection.to);
    const beforeCaret = model.text.slice(line.visibleFrom, visibleFrom);
    const indentation = !plainBreak && beforeCaret.startsWith(PARAGRAPH_INDENT) ? PARAGRAPH_INDENT : '';
    changeFormattedText(TxtFormat.replaceVisible(model.source, visibleFrom, visibleTo, '\n' + indentation));
    return true;
  }

  function deleteFormattedText(editorView, direction) {
    if (displayMode !== 'markdown' || editorView.composing) return false;
    const selection = editorView.state.selection.main, model = getFormatModel();
    let from = TxtFormat.visibleAt(model, selection.from), to = TxtFormat.visibleAt(model, selection.to);
    const line = model.lines[editorView.state.doc.lineAt(selection.head).number - 1];
    if (selection.empty && direction < 0 && line.quote && from === line.visibleFrom) {
      return changeFormattedText({
        text: TxtFormat.applyChanges(model.source, [{ from: line.from, to: line.bodyStart, insert: '' }]),
        changes: [{ from: line.from, to: line.bodyStart, insert: '' }],
        from: line.from, to: line.from
      });
    }
    if (from === to) {
      if (direction < 0) {
        if (from === 0) return true;
        const before = model.text.slice(0, from);
        if (typeof Intl.Segmenter === 'function') {
          from = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(before).containing(before.length - 1).index;
        } else {
          const last = before.charCodeAt(before.length - 1), previous = before.charCodeAt(before.length - 2);
          from -= last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
        }
      } else {
        if (to === model.text.length) return true;
        const after = model.text.slice(to);
        const first = typeof Intl.Segmenter === 'function'
          ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(after)[Symbol.iterator]().next().value.segment
          : Array.from(after)[0];
        to += first.length;
      }
    }
    changeFormattedText(TxtFormat.replaceVisible(model.source, from, to, ''));
    return true;
  }

  const readTocState = () => {
    const liveState = window.getTxtTocState?.();
    if (liveState) return liveState;
    if (!tocStorageKey) return null;
    try { return JSON.parse(localStorage.getItem(tocStorageKey) || 'null'); } catch { return null; }
  };

  const addTrackedEntries = entries => {
    if (!Array.isArray(entries)) return;
    entries.forEach(entry => {
      const id = String(entry?.id || '');
      if (!id || trackedTocAnchors.has(id)) return;
      trackedTocAnchors.set(id, {
        id,
        start: Number(entry.start) || 0,
        end: Number(entry.end) || 0,
        sourceIndex: Number(entry.sourceIndex) || 0,
        text: String(entry.text || ''),
        anchorBefore: String(entry.anchorBefore || ''),
        anchorAfter: String(entry.anchorAfter || ''),
        liveMapped: false,
        removed: !!entry.removed
      });
    });
  };

  const refreshTrackedTocAnchors = state => {
    trackedTocAnchors.clear();
    addTrackedEntries(state?.tocEntries);
    addTrackedEntries(state?.manualTocEntries);
    tocAnchorsInitialized = !!state;
  };

  const ensureTrackedTocAnchors = (force = false) => {
    if (tocAnchorsInitialized && !force) return null;
    const state = readTocState();
    addTrackedEntries(state?.tocEntries);
    addTrackedEntries(state?.manualTocEntries);
    if (state) tocAnchorsInitialized = true;
    return state;
  };

  const findCurrentParagraph = (anchor, paragraphs) => {
    if (!anchor || !paragraphs.length) return null;
    if (anchor.text) {
      const exact = paragraphs.filter(entry => entry.text === anchor.text);
      if (exact.length) {
        return exact.sort((left, right) =>
          Math.abs(left.start - anchor.start) - Math.abs(right.start - anchor.start)
        )[0];
      }
    }
    if (anchor.removed) return null;
    if (anchor.liveMapped) {
      const mapped = paragraphs.find(entry => anchor.start >= entry.start && anchor.start <= entry.end);
      if (mapped) return mapped;
    }
    if (anchor.anchorBefore || anchor.anchorAfter) {
      const contextual = paragraphs.filter((entry, index) => {
        const before = paragraphFingerprint(paragraphs[index - 1]?.text);
        const after = paragraphFingerprint(paragraphs[index + 1]?.text);
        const beforeMatches = !anchor.anchorBefore || before === anchor.anchorBefore;
        const afterMatches = !anchor.anchorAfter || after === anchor.anchorAfter;
        return beforeMatches && afterMatches;
      });
      if (contextual.length === 1) return contextual[0];
    }
    const sourceCandidate = paragraphs[anchor.sourceIndex];
    const storedFirstLine = (anchor.text.split('\n').find(line => line.trim()) || '').replace(/\s+/g, ' ').trim();
    if (sourceCandidate && (!storedFirstLine || sourceCandidate.firstLine === storedFirstLine)) return sourceCandidate;
    return null;
  };

  const updateAnchorFromParagraph = (anchor, paragraph, paragraphs) => {
    if (!anchor || !paragraph) return;
    anchor.start = paragraph.start;
    anchor.end = paragraph.end;
    anchor.sourceIndex = paragraph.sourceIndex;
    anchor.text = paragraph.text;
    anchor.anchorBefore = paragraphFingerprint(paragraphs[paragraph.sourceIndex - 1]?.text);
    anchor.anchorAfter = paragraphFingerprint(paragraphs[paragraph.sourceIndex + 1]?.text);
    anchor.removed = false;
  };

  const reconcileTrackedTocAnchors = (text, resetMapping = false) => {
    ensureTrackedTocAnchors(true);
    const paragraphs = buildParagraphEntries(text);
    trackedTocAnchors.forEach(anchor => {
      if (resetMapping) {
        anchor.liveMapped = false;
        anchor.removed = false;
      }
      const paragraph = findCurrentParagraph(anchor, paragraphs);
      if (paragraph) updateAnchorFromParagraph(anchor, paragraph, paragraphs);
    });
    return paragraphs;
  };

  const persistTrackedTocAnchors = () => {
    if (!tocStorageKey || !trackedTocAnchors.size) return;
    const latest = readTocState();
    if (!latest) return;
    const mergeEntries = entries => {
      if (!Array.isArray(entries)) return;
      entries.forEach(entry => {
        const anchor = trackedTocAnchors.get(String(entry?.id || ''));
        if (!anchor) return;
        Object.assign(entry, {
          start: anchor.start,
          end: anchor.end,
          sourceIndex: anchor.sourceIndex,
          text: anchor.text,
          anchorBefore: anchor.anchorBefore,
          anchorAfter: anchor.anchorAfter
        });
      });
    };
    mergeEntries(latest.tocEntries);
    mergeEntries(latest.manualTocEntries);
    latest.savedAt = Date.now();
    try { localStorage.setItem(tocStorageKey, JSON.stringify(latest)); } catch {}
    window.updateTxtTocAnchors?.(latest);
  };

  const scheduleTocPersist = (delay = 250) => {
    window.clearTimeout(tocPersistTimer);
    tocPersistTimer = window.setTimeout(persistTrackedTocAnchors, delay);
  };

  const mapTocAnchorsThroughChanges = changes => {
    ensureTrackedTocAnchors();
    if (!trackedTocAnchors.size) return;
    trackedTocAnchors.forEach(anchor => {
      changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (fromA <= anchor.start && toA >= anchor.end && anchor.end > anchor.start && !inserted.toString().trim()) {
          anchor.removed = true;
        }
      });
      anchor.start = changes.mapPos(anchor.start, 1);
      anchor.end = changes.mapPos(anchor.end, 1);
      anchor.liveMapped = true;
    });
    scheduleTocPersist();
  };

  const dispatchSilently = spec => {
    if (!view) return;
    suppressInput += 1;
    try {
      view.dispatch(spec);
    } finally {
      suppressInput -= 1;
    }
  };

  const replaceDocument = value => {
    if (!view) return;
    const text = String(value ?? '');
    const head = Math.min(view.state.selection.main.head, text.length);
    const pageX = window.scrollX;
    const pageY = window.scrollY;
    const restorePageScroll = () => window.scrollTo(pageX, pageY);
    dispatchSilently({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: head }
    });
    reconcileTrackedTocAnchors(text, true);
    scheduleTocPersist();
    restorePageScroll();
    requestAnimationFrame(() => {
      restorePageScroll();
      requestAnimationFrame(restorePageScroll);
    });
  };

  const define = (name, descriptor) => {
    Object.defineProperty(textarea, name, { configurable: true, ...descriptor });
  };

  define('value', {
    get: () => view ? view.state.doc.toString() : initialValue,
    set: value => replaceDocument(value)
  });
  define('defaultValue', {
    get: () => defaultValue,
    set: value => { defaultValue = String(value ?? ''); }
  });
  define('selectionStart', {
    get: () => view?.state.selection.main.from ?? 0,
    set: position => {
      if (!view) return;
      const from = clampPosition(position, view.state.doc.length);
      const to = Math.max(from, view.state.selection.main.to);
      dispatchSilently({ selection: { anchor: from, head: to } });
    }
  });
  define('selectionEnd', {
    get: () => view?.state.selection.main.to ?? 0,
    set: position => {
      if (!view) return;
      const to = clampPosition(position, view.state.doc.length);
      const from = Math.min(view.state.selection.main.from, to);
      dispatchSilently({ selection: { anchor: from, head: to } });
    }
  });
  define('selectionDirection', {
    get: () => {
      const main = view?.state.selection.main;
      return main && main.anchor > main.head ? 'backward' : 'forward';
    }
  });
  define('scrollTop', {
    get: () => view?.scrollDOM.scrollTop || 0,
    set: value => { if (view) view.scrollDOM.scrollTop = Number(value) || 0; }
  });

  define('focus', {
    value: () => {
      if (!view) return;
      try {
        view.contentDOM.focus({ preventScroll: true });
      } catch {
        const pageX = window.scrollX;
        const pageY = window.scrollY;
        view.focus();
        window.scrollTo(pageX, pageY);
      }
    }
  });
  define('setSelectionRange', {
    value: (start, end = start, direction = 'forward') => {
      if (!view) return;
      const length = view.state.doc.length;
      const from = clampPosition(pendingNavigationPosition ?? start, length);
      const to = clampPosition(pendingNavigationPosition ?? end, length);
      const anchor = direction === 'backward' ? to : from;
      const head = direction === 'backward' ? from : to;
      dispatchSilently({ selection: { anchor, head } });
    }
  });
  define('setRangeText', {
    value: (replacement, start, end, selectionMode = 'preserve') => {
      if (!view) return;
      const length = view.state.doc.length;
      const from = clampPosition(start, length);
      const to = Math.max(from, clampPosition(end, length));
      const inserted = String(replacement ?? '');
      if (displayMode === 'markdown' && to > from) {
        const model = getFormatModel();
        const visibleFrom = TxtFormat.visibleAt(model, from), visibleTo = TxtFormat.visibleAt(model, to);
        const result = TxtFormat.replaceVisible(model.source, visibleFrom, visibleTo, inserted);
        const updatedModel = TxtFormat.parse(result.text);
        const range = TxtFormat.sourceRange(updatedModel, visibleFrom, visibleFrom + inserted.length);
        let selection = null;
        if (selectionMode === 'select') selection = { anchor: range.from, head: range.to };
        else if (selectionMode === 'start') selection = { anchor: range.from };
        else if (selectionMode === 'end') selection = { anchor: range.to };
        mapTocAnchorsThroughChanges(view.state.changes(result.changes));
        dispatchSilently({ changes: result.changes, ...(selection ? { selection } : {}) });
        return;
      }
      const insertedEnd = from + inserted.length;
      let selection = null;
      if (selectionMode === 'select') selection = { anchor: from, head: insertedEnd };
      else if (selectionMode === 'start') selection = { anchor: from };
      else if (selectionMode === 'end') selection = { anchor: insertedEnd };
      const change = { from, to, insert: inserted };
      mapTocAnchorsThroughChanges(view.state.changes(change));
      dispatchSilently({ changes: change, ...(selection ? { selection } : {}) });
    }
  });
  define('getBoundingClientRect', {
    value: () => (view?.contentDOM || host).getBoundingClientRect()
  });
  define('scrollPositionIntoView', {
    value: position => {
      if (!view) return;
      const at = clampPosition(pendingNavigationPosition ?? position, view.state.doc.length);
      pendingNavigationPosition = null;
      const requestToken = ++scrollRequestToken;
      const editorHeight = view.dom.getBoundingClientRect().height;
      const preferredMargin = Math.round(window.innerHeight * 0.32);
      const yMargin = Math.max(5, Math.min(preferredMargin, Math.max(5, Math.floor(editorHeight / 2) - 1)));
      view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'start', yMargin }) });
      requestAnimationFrame(() => {
        if (requestToken !== scrollRequestToken) return;
        view.requestMeasure({
          read: measuredView => {
            const coords = measuredView.coordsAtPos(at);
            if (!coords) return null;
            return window.scrollY + coords.top - preferredMargin;
          },
          write: targetScrollY => {
            if (requestToken !== scrollRequestToken || targetScrollY == null) return;
            if (Math.abs(window.scrollY - targetScrollY) > 0.5) {
              window.scrollTo(window.scrollX, targetScrollY);
            }
          }
        });
      });
    }
  });

  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged || update.selectionSet) formattingUI?.handleUpdate(update);
    if (!update.docChanged) return;
    if (!suppressInput) mapTocAnchorsThroughChanges(update.changes);
    if (suppressInput) return;
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: false,
      inputType: update.view.composing ? 'insertCompositionText' : 'insertText',
      data: null,
      isComposing: update.view.composing
    }));
  });

  view = new EditorView({
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        EditorView.lineWrapping,
        modeCompartment.of(displayMode === 'markdown' ? [formattingField] : []),
        keymap.of([
          {
            key: 'Enter',
            run: editorView => displayMode === 'markdown' ? markdownParagraphBreak(editorView) : insertParagraphBreak(editorView),
            shift: editorView => displayMode === 'markdown' ? markdownParagraphBreak(editorView, true) : insertPlainParagraphBreak(editorView)
          },
          { key: 'Backspace', run: editorView => deleteFormattedText(editorView, -1) },
          { key: 'Delete', run: editorView => deleteFormattedText(editorView, 1) }
        ]),
        EditorView.inputHandler.of((editorView, from, to, text) => {
          if (displayMode !== 'markdown' || editorView.composing) return false;
          if (text === '\n' && from === to && getFormatModel().lines[editorView.state.doc.lineAt(from).number - 1]?.quote) {
            return markdownParagraphBreak(editorView);
          }
          if (from >= to) return false;
          const model = getFormatModel();
          const result = TxtFormat.replaceVisible(model.source, TxtFormat.visibleAt(model, from), TxtFormat.visibleAt(model, to), text);
          editorView.dispatch({
            changes: result.changes, selection: { anchor: result.to },
            userEvent: 'input.type', scrollIntoView: true
          });
          return true;
        }),
        paragraphIndentInputHandler,
        updateListener
      ]
    }),
    parent: host
  });

  const forwardEvent = (type, event) => {
    let forwarded;
    if (type === 'keydown') {
      forwarded = new KeyboardEvent(type, {
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        bubbles: false,
        cancelable: true
      });
    } else if (type === 'beforeinput') {
      forwarded = new InputEvent(type, {
        inputType: event.inputType,
        data: event.data,
        isComposing: event.isComposing,
        bubbles: false,
        cancelable: true
      });
    } else {
      forwarded = new CompositionEvent(type, {
        data: event.data || '',
        bubbles: false,
        cancelable: true
      });
    }
    const accepted = textarea.dispatchEvent(forwarded);
    if (!accepted || forwarded.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  ['beforeinput', 'keydown', 'compositionstart', 'compositionend'].forEach(type => {
    view.contentDOM.addEventListener(type, event => forwardEvent(type, event), true);
  });

  textarea.hidden = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  host.hidden = false;
  textarea.codeMirrorView = view;
  textarea.refreshTocAnchors = refreshTrackedTocAnchors;
  textarea.getDisplayMode = () => displayMode;
  textarea.getFormatModel = getFormatModel;
  textarea.getVisibleText = () => displayMode === 'plain' ? textarea.value : getFormatModel().text;
  textarea.getVisibleSelection = () => {
    const selection = view.state.selection.main;
    if (displayMode === 'plain') return { from: selection.from, to: selection.to };
    const model = getFormatModel();
    return { from: TxtFormat.visibleAt(model, selection.from), to: TxtFormat.visibleAt(model, selection.to) };
  };
  textarea.visibleRangeToSource = (from, to) => displayMode === 'plain' ? { from, to } : TxtFormat.sourceRange(getFormatModel(), from, to);
  textarea.replaceAllVisibleMatches = (needle, replacement) => {
    if (displayMode === 'plain') return textarea.value.split(needle).join(replacement);
    const haystack = getFormatModel().text, matches = [];
    for (let at = 0; at <= haystack.length - needle.length;) {
      const found = haystack.indexOf(needle, at);
      if (found < 0) break;
      matches.push(found); at = found + needle.length;
    }
    let result = textarea.value;
    for (let i = matches.length - 1; i >= 0; i--) result = TxtFormat.replaceVisible(result, matches[i], matches[i] + needle.length, replacement).text;
    return result;
  };
  const controller = {
    view, host, getModel: getFormatModel, getMode: () => displayMode,
    select: (from, to) => textarea.setSelectionRange(from, to),
    setMode(next) {
      const normalized = next === 'plain' ? 'plain' : 'markdown';
      if (normalized === displayMode) return;
      let selection = null;
      if (normalized === 'markdown') {
        const current = view.state.selection.main;
        const model = getFormatModel();
        if (model.hidden.some(range =>
          (current.from > range.from && current.from < range.to) ||
          (current.to > range.from && current.to < range.to)
        )) {
          const mapped = TxtFormat.sourceRange(model, TxtFormat.visibleAt(model, current.from), TxtFormat.visibleAt(model, current.to));
          selection = current.anchor > current.head ? { anchor: mapped.to, head: mapped.from } : { anchor: mapped.from, head: mapped.to };
        }
      }
      displayMode = normalized;
      view.dispatch({
        effects: modeCompartment.reconfigure(displayMode === 'markdown' ? [formattingField] : []),
        ...(selection ? { selection } : {})
      });
      host.classList.toggle('txt-markdown-mode', displayMode === 'markdown');
      try { sessionStorage.setItem(modeStorageKey, displayMode); } catch {}
      formattingUI?.scheduleUpdate();
      window.dispatchEvent(new Event('txt-display-mode-change'));
    },
    format(command, href = null) {
      if (displayMode !== 'markdown' || view.composing) return;
      const selection = view.state.selection.main;
      const result = command === 'quote'
        ? TxtFormat.quoteSelection(textarea.value, selection.from, selection.to)
        : TxtFormat.formatSelection(textarea.value, selection.from, selection.to, command, href);
      changeFormattedText(result);
    }
  };
  host.classList.toggle('txt-markdown-mode', displayMode === 'markdown');
  formattingUI = createFormattingUI(controller);
  view.contentDOM.addEventListener('copy', event => {
    if (displayMode !== 'markdown' || !event.clipboardData) return;
    const selection = textarea.getVisibleSelection();
    if (selection.from === selection.to) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', getFormatModel().text.slice(selection.from, selection.to));
  }, true);
  view.contentDOM.addEventListener('cut', event => {
    if (displayMode !== 'markdown' || !event.clipboardData || view.composing) return;
    const selection = textarea.getVisibleSelection();
    if (selection.from === selection.to) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', getFormatModel().text.slice(selection.from, selection.to));
    changeFormattedText(TxtFormat.replaceVisible(textarea.value, selection.from, selection.to, ''));
  }, true);
  reconcileTrackedTocAnchors(initialValue);
  if (trackedTocAnchors.size) scheduleTocPersist(0);

  const tocList = document.getElementById('tocList');
  tocList?.addEventListener('click', event => {
    const jumpButton = event.target?.closest?.('[data-role="jump"]');
    const row = jumpButton?.closest?.('[data-toc-id]');
    if (!row) return;
    ensureTrackedTocAnchors(true);
    const entryId = String(row.dataset.tocId || '');
    const anchor = trackedTocAnchors.get(entryId);
    const paragraphs = buildParagraphEntries(textarea.value);
    const paragraph = findCurrentParagraph(anchor, paragraphs);
    if (!anchor || !paragraph) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.alert('這個目錄項目指向的段落已不存在，請重新整理目錄。');
      return;
    }
    updateAnchorFromParagraph(anchor, paragraph, paragraphs);
    pendingNavigationPosition = paragraph.start;
    scheduleTocPersist(0);
  }, true);
  return textarea;
}

window.createTxtEditor = createTxtEditor;
window.TxtFormat = TxtFormat;
createTxtEditor.formattingVersion = 1;
