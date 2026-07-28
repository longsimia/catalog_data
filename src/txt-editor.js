import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

function clampPosition(value, length) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(Math.trunc(number), length));
}

function createTxtEditor(textarea, host) {
  if (!textarea || !host) return null;

  const initialValue = textarea.value || '';
  let defaultValue = textarea.defaultValue || initialValue;
  let view = null;
  let suppressInput = 0;
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
      const from = clampPosition(start, length);
      const to = clampPosition(end, length);
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
      const at = clampPosition(position, view.state.doc.length);
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
  return textarea;
}

window.createTxtEditor = createTxtEditor;
