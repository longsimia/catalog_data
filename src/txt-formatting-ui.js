import TxtFormat from './txt-format.js';

const ICONS = {
  bold: '<path d="M7 4h6a4 4 0 0 1 0 8H7V4Zm0 8h7a4 4 0 0 1 0 8H7v-8Z" stroke-width="2.3"/>',
  italic: '<path d="M11 4h8M5 20h8M15 4 9 20"/>',
  underline: '<path d="M6 4v8a6 6 0 0 0 12 0V4M5 21h14"/>',
  strike: '<path d="M18 6c-1-1.5-3-2-5-2-3 0-5 1.4-5 3.5 0 1.5 1.2 2.5 3 3.2M7 17c1.2 2 3.2 3 5.5 3 3 0 5.5-1.5 5.5-4 0-1.8-1.5-3-4-3.7M3 12h18"/>',
  link: '<path d="m10 14 4-4M9 16l-2 2a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0M15 8l2-2a4.2 4.2 0 0 1 6 6l-4 4a4.2 4.2 0 0 1-6 0"/>',
  quote: '<path d="M4 6h6v7H6c0 2 1 3 3 4M14 6h6v7h-4c0 2 1 3 3 4"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  unlink: '<path d="m3 3 18 18M10 14l4-4M8 17l-1 1a4 4 0 0 1-6-6l3-3M16 7l1-1a4 4 0 0 1 6 6l-3 3"/>'
};
const ITEMS = [
  ['bold', '粗體', 'Ctrl+B'], ['italic', '斜體', 'Ctrl+I'],
  ['underline', '底線', 'Ctrl+U'], ['strike', '刪除線', ''],
  ['link', '超連結', 'Ctrl+K'], ['quote', '引用', '']
];
function icon(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

export function createFormattingUI(controller) {
  const { view, host } = controller;
  const toolbar = document.createElement('div');
  toolbar.id = 'txtFormatToolbar';
  toolbar.className = 'txt-format-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '文字格式');
  toolbar.setAttribute('aria-hidden', 'true');
  toolbar.innerHTML = '<div class="txt-format-buttons">' + ITEMS.map(([command, label, shortcut]) =>
    (command === 'quote' ? '<span class="txt-format-separator" aria-hidden="true"></span>' : '') +
    '<button type="button" class="txt-format-button" data-format-command="' + command +
    '" aria-label="' + label + '" aria-pressed="false" data-format-hint="' + label +
    (shortcut ? ' · ' + shortcut : '') + '">' + icon(command) + '</button>'
  ).join('') + '</div><form class="txt-link-form" hidden>' +
    '<button type="button" class="txt-format-button" data-link-action="cancel" aria-label="取消" data-format-hint="取消 · Esc">' + icon('back') + '</button>' +
    '<input type="text" class="txt-link-input" inputmode="url" autocomplete="off" spellcheck="false" aria-label="超連結網址" placeholder="貼上網址，Enter 套用">' +
    '<button type="button" class="txt-format-button" data-link-action="remove" aria-label="移除超連結" data-format-hint="移除超連結">' + icon('unlink') + '</button>' +
    '<button type="submit" class="txt-format-button" aria-label="套用超連結" data-format-hint="套用 · Enter">' + icon('check') + '</button></form>';
  document.body.append(toolbar);
  const hint = document.createElement('div');
  hint.className = 'txt-format-hint';
  hint.setAttribute('role', 'tooltip');
  hint.hidden = true;
  document.body.append(hint);
  const preview = document.createElement('div');
  preview.className = 'txt-link-preview';
  preview.hidden = true;
  preview.innerHTML = '<a target="_blank" rel="noopener noreferrer"></a>' +
    '<button type="button" data-link-preview="edit">修改</button>' +
    '<button type="button" data-link-preview="remove">移除</button>';
  document.body.append(preview);
  const buttons = toolbar.querySelector('.txt-format-buttons');
  const form = toolbar.querySelector('form');
  const input = form.querySelector('input');
  let savedSelection = null, editingLink = false, activeLink = null, frame = 0;

  const modeButton = document.getElementById('displayModeToggleBtn');
  const modeLabel = document.getElementById('displayModeToggleLabel');
  const modeMenu = document.getElementById('displayModeMenu');
  const modeItems = Array.from(modeMenu?.querySelectorAll('[data-display-mode]') || []);

  function hide() {
    toolbar.classList.remove('is-open', 'is-below');
    toolbar.setAttribute('aria-hidden', 'true');
    form.hidden = true; buttons.hidden = false; editingLink = false;
    hint.hidden = true;
  }
  function closeModeMenu() {
    modeMenu?.classList.remove('is-open');
    modeButton?.setAttribute('aria-expanded', 'false');
  }
  function positionModeMenu() {
    if (!modeButton || !modeMenu) return;
    const rect = modeButton.getBoundingClientRect();
    modeMenu.style.setProperty('--encoding-menu-width', Math.ceil(rect.width) + 'px');
    modeMenu.style.left = Math.round(rect.left) + 'px';
    modeMenu.style.top = Math.round(rect.bottom + 6) + 'px';
  }
  function syncModeMenu() {
    const mode = controller.getMode();
    if (modeLabel) modeLabel.textContent = mode === 'markdown' ? 'Markdown 模式' : '純文字模式';
    modeItems.forEach(item => {
      const active = item.dataset.displayMode === mode;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-checked', String(active));
    });
  }
  function position() {
    const selection = savedSelection || view.state.selection.main;
    let from = view.coordsAtPos(selection.from, 1), to = view.coordsAtPos(selection.to, -1);
    if (!from || !to) { hide(); return; }
    const model = controller.getModel();
    const visibleFrom = TxtFormat.visibleAt(model, selection.from);
    const visibleTo = TxtFormat.visibleAt(model, selection.to);
    const range = TxtFormat.sourceRange(model, visibleFrom, visibleTo);
    from = view.coordsAtPos(range.from, 1) || from;
    to = view.coordsAtPos(range.to, -1) || to;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    if (from.bottom < viewportTop || from.top > viewportBottom) { hide(); return; }
    const width = toolbar.offsetWidth, height = toolbar.offsetHeight;
    const mobile = window.matchMedia('(max-width:720px)').matches;
    let below = mobile || from.top - height - 10 < viewportTop + 8;
    const sameLine = Math.abs(from.top - to.top) < 3;
    const x = sameLine ? (from.left + to.right) / 2 : from.left + width / 2;
    const center = Math.max(width / 2 + 10, Math.min(window.innerWidth - width / 2 - 10, x));
    let top = below ? Math.min(to.bottom, from.bottom) + 10 : from.top - height - 10;
    if (top + height > viewportBottom - 8) { below = false; top = from.top - height - 10; }
    toolbar.style.left = Math.round(center) + 'px';
    toolbar.style.top = Math.round(Math.max(viewportTop + 8, top)) + 'px';
    toolbar.classList.toggle('is-below', below);
  }
  function updateButtons(model, selection) {
    const runs = TxtFormat.selectedRuns(model, selection.from, selection.to);
    for (const button of buttons.querySelectorAll('[data-format-command]')) {
      const command = button.dataset.formatCommand;
      let active = false;
      if (command === 'link') active = runs.length > 0 && runs.every(run => !!run.href);
      else if (command === 'quote') {
        const start = TxtFormat.visibleAt(model, selection.from), end = TxtFormat.visibleAt(model, selection.to);
        const lines = model.lines.filter(line => line.text.trim() && line.visibleTo > start && line.visibleFrom < end);
        active = lines.length > 0 && lines.every(line => line.quote);
      } else active = runs.length > 0 && runs.every(run => run.marks.includes(command));
      button.setAttribute('aria-pressed', String(active));
    }
  }
  function update() {
    frame = 0;
    syncModeMenu();
    if (controller.getMode() !== 'markdown' || view.composing) { hide(); return; }
    if (editingLink) { position(); return; }
    const selection = view.state.selection.main;
    const model = controller.getModel();
    const start = TxtFormat.visibleAt(model, selection.from), end = TxtFormat.visibleAt(model, selection.to);
    if (selection.empty || !model.text.slice(start, end).trim() || !view.hasFocus) { hide(); return; }
    savedSelection = { from: selection.from, to: selection.to };
    updateButtons(model, savedSelection);
    toolbar.classList.add('is-open');
    toolbar.setAttribute('aria-hidden', 'false');
    position();
  }
  function scheduleUpdate() { if (!frame) frame = requestAnimationFrame(update); }
  function restoreSelection() {
    if (!savedSelection) return;
    controller.select(savedSelection.from, savedSelection.to);
    view.focus();
  }
  function openLink(link = null) {
    activeLink = link || controller.getModel().links.find(node =>
      savedSelection && savedSelection.from >= node.contentFrom && savedSelection.to <= node.contentTo
    ) || null;
    if (activeLink) savedSelection = { from: activeLink.contentFrom, to: activeLink.contentTo };
    if (!savedSelection || savedSelection.from === savedSelection.to) return;
    restoreSelection();
    editingLink = true;
    input.value = activeLink?.href || '';
    form.querySelector('[data-link-action="remove"]').hidden = !activeLink;
    buttons.hidden = true; form.hidden = false; preview.hidden = true; hint.hidden = true;
    toolbar.classList.add('is-open');
    toolbar.setAttribute('aria-hidden', 'false');
    position();
    input.focus({ preventScroll: true });
    input.select();
  }
  function applyLink(remove = false) {
    const href = remove ? null : TxtFormat.safeUrl(input.value, true);
    if (!remove && !href) { input.setCustomValidity('請輸入有效的 http、https 或 mailto 網址。'); input.reportValidity(); return; }
    input.setCustomValidity('');
    restoreSelection();
    controller.format('link', href);
    editingLink = false; activeLink = null;
    form.hidden = true; buttons.hidden = false;
    preview.hidden = true;
    update();
  }

  toolbar.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  buttons.addEventListener('click', event => {
    const button = event.target.closest('[data-format-command]');
    if (!button) return;
    const command = button.dataset.formatCommand;
    restoreSelection();
    if (command === 'link') openLink();
    else controller.format(command);
    if (command !== 'link') update();
  });
  form.addEventListener('submit', event => { event.preventDefault(); applyLink(); });
  input.addEventListener('input', () => input.setCustomValidity(''));
  form.querySelector('[data-link-action="cancel"]').addEventListener('click', () => {
    restoreSelection(); editingLink = false; form.hidden = true; buttons.hidden = false; update();
  });
  form.querySelector('[data-link-action="remove"]').addEventListener('click', () => applyLink(true));
  host.addEventListener('click', event => {
    const element = event.target.closest('a.txt-format-link');
    if (!element || controller.getMode() !== 'markdown') return;
    event.preventDefault();
    const position = view.posAtDOM(element, 0);
    activeLink = controller.getModel().links.find(link => position >= link.contentFrom && position <= link.contentTo);
    if (!activeLink) return;
    savedSelection = { from: activeLink.contentFrom, to: activeLink.contentTo };
    const anchor = preview.querySelector('a');
    anchor.href = activeLink.href; anchor.textContent = activeLink.href;
    preview.hidden = false;
    const rect = element.getBoundingClientRect();
    preview.style.left = Math.round(Math.max(12, Math.min(window.innerWidth - preview.offsetWidth - 12, rect.left))) + 'px';
    preview.style.top = Math.round(rect.bottom + 10) + 'px';
  });
  preview.querySelector('[data-link-preview="edit"]').addEventListener('click', () => openLink(activeLink));
  preview.querySelector('[data-link-preview="remove"]').addEventListener('click', () => {
    if (!activeLink) return;
    savedSelection = { from: activeLink.contentFrom, to: activeLink.contentTo };
    restoreSelection(); controller.format('link', null); activeLink = null; preview.hidden = true;
  });

  modeButton?.addEventListener('click', event => {
    event.preventDefault();
    const wasOpen = modeMenu.classList.contains('is-open');
    closeModeMenu();
    document.getElementById('encodingMenu')?.classList.remove('is-open');
    document.getElementById('encodingToggleBtn')?.setAttribute('aria-expanded', 'false');
    if (!wasOpen) {
      positionModeMenu();
      modeMenu.classList.add('is-open');
      modeButton.setAttribute('aria-expanded', 'true');
    }
  });
  modeItems.forEach(item => item.addEventListener('click', () => {
    controller.setMode(item.dataset.displayMode);
    closeModeMenu(); hide(); preview.hidden = true; syncModeMenu();
  }));
  document.addEventListener('pointerdown', event => {
    if (!toolbar.contains(event.target) && !host.contains(event.target)) hide();
    if (!preview.contains(event.target) && !event.target.closest('a.txt-format-link')) preview.hidden = true;
    if (modeMenu && !modeMenu.contains(event.target) && !modeButton.contains(event.target)) closeModeMenu();
    hint.hidden = true;
  });
  document.addEventListener('keydown', event => {
    if (editingLink && event.target === input && (event.ctrlKey || event.metaKey) &&
        ['z', 'y'].includes(event.key.toLowerCase())) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === 'Escape') {
      if (modeMenu?.classList.contains('is-open')) {
        event.preventDefault(); event.stopImmediatePropagation(); closeModeMenu(); return;
      }
      if (editingLink) {
        event.preventDefault(); event.stopImmediatePropagation(); restoreSelection(); hide(); return;
      }
      hide(); preview.hidden = true;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing ||
        !view.hasFocus || controller.getMode() !== 'markdown') return;
    const command = { b: 'bold', i: 'italic', u: 'underline', k: 'link' }[event.key.toLowerCase()];
    if (!command) return;
    event.preventDefault();
    const selection = view.state.selection.main;
    if (selection.empty) return;
    savedSelection = { from: selection.from, to: selection.to };
    command === 'link' ? openLink() : controller.format(command);
    if (command !== 'link') update();
  }, true);
  toolbar.addEventListener('mouseover', event => {
    const button = event.target.closest('[data-format-hint]');
    if (!button || button.contains(event.relatedTarget)) return;
    hint.textContent = button.dataset.formatHint; hint.hidden = false;
    const rect = button.getBoundingClientRect();
    const center = Math.max(hint.offsetWidth / 2 + 8, Math.min(window.innerWidth - hint.offsetWidth / 2 - 8, rect.left + rect.width / 2));
    hint.style.left = Math.round(center) + 'px';
    hint.style.top = Math.round(rect.bottom + 8) + 'px';
  });
  toolbar.addEventListener('mouseout', event => {
    const button = event.target.closest('[data-format-hint]');
    if (button && !button.contains(event.relatedTarget)) hint.hidden = true;
  });
  host.addEventListener('focusout', () => {
    requestAnimationFrame(() => { if (!toolbar.contains(document.activeElement) && !view.hasFocus) hide(); });
  });
  window.addEventListener('scroll', () => {
    hint.hidden = true; preview.hidden = true;
    if (toolbar.classList.contains('is-open')) position();
    if (modeMenu?.classList.contains('is-open')) positionModeMenu();
  }, { passive: true });
  window.addEventListener('resize', () => { scheduleUpdate(); if (modeMenu?.classList.contains('is-open')) positionModeMenu(); });
  window.visualViewport?.addEventListener('resize', scheduleUpdate);
  const formatModal = document.getElementById('formatModal');
  if (formatModal) new MutationObserver(() => {
    if (!formatModal.classList.contains('on')) closeModeMenu();
  }).observe(formatModal, { attributes: true, attributeFilter: ['class'] });
  syncModeMenu();
  return {
    scheduleUpdate, hide, closeModeMenu, openLink,
    handleUpdate(update) {
      if (update.docChanged) {
        if (editingLink) hide();
        activeLink = null;
        preview.hidden = true;
      }
      scheduleUpdate();
    }
  };
}
