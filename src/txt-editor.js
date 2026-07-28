import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

function clampPosition(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Math.trunc(number), length));
}

function buildCurrentParagraphEntries(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const entries = [];
  let offset = 0;
  let start = -1;
  let end = -1;
  let entryLines = [];
  const pushEntry = () => {
    if (start < 0 || !entryLines.length) return;
    const label = (entryLines.find(line => line.trim()) || '').replace(/\s+/g, ' ').trim();
    entries.push({ sourceIndex: entries.length, start, end, label, text: entryLines.join('\n'), lineCount: entryLines.length });
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

function resolveCurrentTocEntry(textarea, row, tocStorageKey) {
  const entryId = String(row?.dataset?.tocId || '');
  if (!entryId) return null;
  let state = null;
  try {
    state = tocStorageKey ? JSON.parse(localStorage.getItem(tocStorageKey) || 'null') : null;
  } catch {}
  const storedEntries = [
    ...(Array.isArray(state?.tocEntries) ? state.tocEntries : []),
    ...(Array.isArray(state?.manualTocEntries) ? state.manualTocEntries : [])
  ];
  const stored = storedEntries.find(entry => String(entry?.id || '') === entryId) || null;
  const currentEntries = buildCurrentParagraphEntries(textarea.value);
  if (!currentEntries.length) return null;
  const parsedAutoIndex = /^auto-(\d+)$/.exec(entryId);
  if (!stored) return parsedAutoIndex ? currentEntries[Number(parsedAutoIndex[1])] || null : null;

  const storedText = String(stored.text || '');
  const storedLabel = String(stored.label || '').replace(/…$/, '').trim();
  const storedFirstLine = (storedText.split('\n').find(line => line.trim()) || '').replace(/\s+/g, ' ').trim();
  const storedStart = Number(stored.start) || 0;
  const storedSourceIndex = Number(stored.sourceIndex);
  const resolved = currentEntries.map(entry => {
    let score = -Math.abs(entry.start - storedStart);
    if (storedText && entry.text === storedText) score += 1_000_000_000;
    else if (storedText && (entry.text.startsWith(storedText.slice(0, 80)) || storedText.startsWith(entry.text.slice(0, 80)))) score += 10_000_000;
    if (storedFirstLine && entry.label === storedFirstLine) score += 5_000_000;
    if (storedLabel && entry.label.startsWith(storedLabel)) score += 1_000_000;
    if (Number.isFinite(storedSourceIndex) && entry.sourceIndex === storedSourceIndex) score += 100_000;
    return { entry, score };
  }).sort((left, right) => right.score - left.score)[0]?.entry || null;

  if (resolved && state && tocStorageKey) {
    const updateEntries = entries => {
      if (!Array.isArray(entries)) return;
      entries.forEach(entry => {
        if (String(entry?.id || '') !== entryId) return;
        Object.assign(entry, {
          start: resolved.start,
          end: resolved.end,
          sourceIndex: resolved.sourceIndex,
          lineCount: resolved.lineCount,
          text: resolved.text
        });
      });
    };
    updateEntries(state.tocEntries);
    updateEntries(state.manualTocEntries);
    state.savedAt = Date.now();
    try { localStorage.setItem(tocStorageKey, JSON.stringify(state)); } catch {}
  }
  return resolved;
}

function createTxtEditor(textarea, host, options = {}) {
  if (!textarea || !host) return null;

  const initialValue = textarea.value || '';
  let defaultValue = textarea.defaultValue || initialValue;
  let view = null;
  let suppressInput = 0;
  let pendingNavigationPosition = null;
  let pendingNavigationToken = 0;
  let scrollRequestToken = 0;

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

  define('focus', { value: () => view?.focus() });
  define('setSelectionRange', {
    value: (start, end = start, direction = 'forward') => {
      if (!view) return;
      const length = view.state.doc.length;
      const correctedPosition = pendingNavigationPosition;
      const from = clampPosition(correctedPosition ?? start, length);
      const to = clampPosition(correctedPosition ?? end, length);
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
      let attempts = 0;
      const correctPosition = () => {
        if (requestToken !== scrollRequestToken) return;
        attempts += 1;
        const coords = view.coordsAtPos(at);
        if (coords) {
          const delta = coords.top - preferredMargin;
          if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
        }
        if (attempts < 6) requestAnimationFrame(correctPosition);
      };
      requestAnimationFrame(correctPosition);
    }
  });

  const updateListener = EditorView.updateListener.of(update => {
    if (!update.docChanged || suppressInput) return;
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
  const tocList = document.getElementById('tocList');
  tocList?.addEventListener('click', event => {
    const jumpButton = event.target?.closest?.('[data-role="jump"]');
    const row = jumpButton?.closest?.('[data-toc-id]');
    if (!row) return;
    const resolved = resolveCurrentTocEntry(textarea, row, String(options.tocStorageKey || ''));
    if (!resolved) return;
    pendingNavigationPosition = resolved.start;
    const token = ++pendingNavigationToken;
    window.setTimeout(() => {
      if (token === pendingNavigationToken) pendingNavigationPosition = null;
    }, 1000);
  }, true);
  return textarea;
}

window.createTxtEditor = createTxtEditor;
