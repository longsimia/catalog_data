import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

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
  const tocStorageKey = String(options.tocStorageKey || '');
  const trackedTocAnchors = new Map();

  const readTocState = () => {
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
        removed: false
      });
    });
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
      const insertedEnd = from + inserted.length;
      let selection = null;
      if (selectionMode === 'select') selection = { anchor: from, head: insertedEnd };
      else if (selectionMode === 'start') selection = { anchor: from };
      else if (selectionMode === 'end') selection = { anchor: insertedEnd };
      dispatchSilently({ changes: { from, to, insert: inserted }, ...(selection ? { selection } : {}) });
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
      extensions: [EditorView.lineWrapping, updateListener]
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
