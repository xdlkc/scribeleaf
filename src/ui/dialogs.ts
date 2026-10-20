// Modal sheets appended to #overlays: insert table/link/image, preferences,
// quick open palette, about box, and the unsaved-changes confirmation.
// Esc or a backdrop click cancels; closing a sheet refocuses the editor.

import { runCommand } from '../commands';
import { store } from '../store';
import { FileEntry, ThemeName } from '../types';

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gothic', label: 'Gothic' },
  { value: 'night', label: 'Night' },
  { value: 'newsprint', label: 'Newsprint' },
  { value: 'pixyll', label: 'Pixyll' },
  { value: 'whitey', label: 'Whitey' },
];

const QUICK_OPEN_MAX_ROWS = 100;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Sheet {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  close: () => void;
}

function createSheet(overlayClass = '', onClosed?: () => void): Sheet {
  const overlay = el('div', overlayClass ? `overlay ${overlayClass}` : 'overlay');
  const dialog = el('div', 'dialog');
  dialog.setAttribute('role', 'dialog');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (onClosed) onClosed();
    runCommand('focusEditor');
  };
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  overlay.append(dialog);
  (document.getElementById('overlays') ?? document.body).append(overlay);
  return { overlay, dialog, close };
}

function field(labelText: string, control: HTMLElement): HTMLDivElement {
  const row = el('div', 'dialog-field');
  row.append(el('label', 'dialog-label', labelText), control);
  return row;
}

function checkField(labelText: string, input: HTMLInputElement): HTMLDivElement {
  const row = el('div', 'dialog-field dialog-field-check');
  const label = el('label', 'dialog-check-label');
  label.append(input, document.createTextNode(labelText));
  row.append(label);
  return row;
}

function buttons(...btns: HTMLButtonElement[]): HTMLDivElement {
  const row = el('div', 'dialog-buttons');
  row.append(...btns);
  return row;
}

function btn(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = el('button', primary ? 'btn btn-primary' : 'btn', text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function checkbox(checked: boolean, onChange: (value: boolean) => void): HTMLInputElement {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const input = el('input', 'dialog-input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

function numberInput(value: number, min: number): HTMLInputElement {
  const input = el('input', 'dialog-input dialog-input-number');
  input.type = 'number';
  input.min = String(min);
  input.value = String(value);
  return input;
}

function intValue(input: HTMLInputElement, fallback: number, min: number): number {
  const n = Math.round(Number(input.value));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// Enter inside a text/number field submits; checkboxes and buttons keep their
// native Enter behavior.
function submitOnEnter(dialog: HTMLElement, submit: () => void): void {
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (target instanceof HTMLInputElement && target.type !== 'checkbox') {
      e.preventDefault();
      submit();
    }
  });
}

export function openTableDialog(): void {
  const { dialog, close } = createSheet();
  dialog.append(el('div', 'dialog-title', 'Insert Table'));
  const rows = numberInput(3, 1);
  const cols = numberInput(3, 1);
  const header = el('input');
  header.type = 'checkbox';
  header.checked = true;
  dialog.append(field('Rows', rows), field('Columns', cols), checkField('Header row', header));
  const submit = () => {
    close();
    runCommand('insertTable', {
      rows: intValue(rows, 3, 1),
      cols: intValue(cols, 3, 1),
      header: header.checked,
    });
  };
  dialog.append(buttons(btn('Cancel', false, close), btn('OK', true, submit)));
  submitOnEnter(dialog, submit);
  rows.focus();
  rows.select();
}

export function openLinkDialog(selectedText: string): void {
  const { dialog, close } = createSheet();
  dialog.append(el('div', 'dialog-title', 'Insert Link'));
  const text = textInput(selectedText);
  const href = textInput('', 'https://');
  const title = textInput('', 'Optional');
  dialog.append(field('Text', text), field('URL', href), field('Title', title));
  const submit = () => {
    close();
    runCommand('insertLink', { text: text.value, href: href.value.trim(), title: title.value });
  };
  dialog.append(buttons(btn('Cancel', false, close), btn('OK', true, submit)));
  submitOnEnter(dialog, submit);
  // With prefilled text the URL is the field the user needs next.
  (selectedText ? href : text).focus();
}

export function openImageDialog(): void {
  const { dialog, close } = createSheet();
  dialog.append(el('div', 'dialog-title', 'Insert Image'));
  const alt = textInput('');
  const src = textInput('', 'Path or URL');
  const title = textInput('', 'Optional');
  const filePicker = el('input');
  filePicker.type = 'file';
  filePicker.accept = 'image/*';
  filePicker.style.display = 'none';
  filePicker.addEventListener('change', () => {
    const chosen = filePicker.files?.[0];
    if (chosen) src.value = chosen.name;
  });
  const browse = btn('Browse…', false, () => filePicker.click());
  const srcRow = el('div', 'dialog-inline');
  srcRow.append(src, browse);
  dialog.append(field('Alt text', alt), field('Path/URL', srcRow), field('Title', title));
  dialog.append(filePicker);
  const submit = () => {
    close();
    runCommand('insertImage', { alt: alt.value, src: src.value.trim(), title: title.value });
  };
  dialog.append(buttons(btn('Cancel', false, close), btn('OK', true, submit)));
  submitOnEnter(dialog, submit);
  alt.focus();
}

export function openPreferencesDialog(tab?: string): void {
  if (window.webkit?.messageHandlers?.native) {
    window.webkit.messageHandlers.native.postMessage({ type: 'openPreferences', tab: tab ?? 'general' });
    return;
  }
  const url = new URL(location.href);
  url.hash = '#preferences/' + (tab ?? 'general');
  const popup = window.open(url.toString(), 'typora-replica-preferences', 'width=720,height=480,popup=yes');
  if (popup) return;
  location.hash = '#preferences/' + (tab ?? 'general');
  if (!document.body.classList.contains('preferences-route')) openPreferencesSheet();
}

function openPreferencesSheet(): void {
  let unsubscribe: () => void = () => {};
  const { dialog, close } = createSheet('', () => unsubscribe());
  dialog.classList.add('dialog-preferences');
  dialog.append(el('div', 'dialog-title', 'Preferences'));

  dialog.append(el('div', 'dialog-section', 'General'));
  const themeSel = el('select', 'dialog-input');
  for (const t of THEMES) {
    const opt = el('option', '', t.label);
    opt.value = t.value;
    themeSel.append(opt);
  }
  themeSel.value = store.prefs.theme;
  themeSel.addEventListener('change', () => store.setPrefs({ theme: themeSel.value as ThemeName }));
  const autoSave = checkbox(store.prefs.autoSave, (v) => store.setPrefs({ autoSave: v }));
  const delay = numberInput(store.prefs.autoSaveDelayMs, 250);
  delay.step = '250';
  delay.addEventListener('change', () =>
    store.setPrefs({ autoSaveDelayMs: intValue(delay, 3000, 250) }),
  );
  const spellcheck = checkbox(store.prefs.spellcheck, (v) => store.setPrefs({ spellcheck: v }));
  dialog.append(
    field('Theme', themeSel),
    checkField('Auto Save', autoSave),
    field('Auto Save delay (ms)', delay),
    checkField('Spellcheck', spellcheck),
  );

  dialog.append(el('div', 'dialog-section', 'View'));
  const typewriter = checkbox(store.prefs.typewriterMode, (v) =>
    store.setPrefs({ typewriterMode: v }),
  );
  const focusMode = checkbox(store.prefs.focusMode, (v) => store.setPrefs({ focusMode: v }));
  const zoom = numberInput(store.prefs.zoom, 25);
  zoom.step = '5';
  zoom.addEventListener('change', () =>
    store.setPrefs({ zoom: Math.min(400, intValue(zoom, 100, 25)) }),
  );
  dialog.append(
    checkField('Typewriter Mode', typewriter),
    checkField('Focus Mode', focusMode),
    field('Zoom (%)', zoom),
  );

  // Reflect external pref changes without clobbering the focused control.
  const sync = () => {
    const p = store.prefs;
    const active = document.activeElement;
    if (active !== themeSel) themeSel.value = p.theme;
    if (active !== autoSave) autoSave.checked = p.autoSave;
    if (active !== delay) delay.value = String(p.autoSaveDelayMs);
    if (active !== spellcheck) spellcheck.checked = p.spellcheck;
    if (active !== typewriter) typewriter.checked = p.typewriterMode;
    if (active !== focusMode) focusMode.checked = p.focusMode;
    if (active !== zoom) zoom.value = String(p.zoom);
  };
  unsubscribe = store.on('prefs', sync);

  dialog.append(buttons(btn('Close', true, close)));
  themeSel.focus();
}

export function openQuickOpen(): void {
  const { dialog, close } = createSheet('quick-open-overlay');
  dialog.classList.add('quick-open');
  const input = el('input', 'quick-open-input');
  input.type = 'text';
  input.placeholder = 'Type a file name…';
  input.spellcheck = false;
  const list = el('div', 'quick-open-list');
  dialog.append(input, list);

  let matches: FileEntry[] = [];
  let sel = 0;

  const openFile = (f: FileEntry) => {
    close();
    runCommand('openPath', f.path);
  };
  const updateSelection = () => {
    Array.from(list.children).forEach((child, i) => {
      child.classList.toggle('selected', i === sel);
    });
    const selEl = list.children[sel];
    if (selEl instanceof HTMLElement) selEl.scrollIntoView({ block: 'nearest' });
  };
  const renderList = () => {
    list.replaceChildren();
    if (!store.files.length) {
      list.append(el('div', 'quick-open-hint', 'No folder opened'));
      return;
    }
    if (!matches.length) {
      list.append(el('div', 'quick-open-hint', 'No matching files'));
      return;
    }
    matches.forEach((f, i) => {
      const row = el('div', 'quick-open-row');
      if (i === sel) row.classList.add('selected');
      row.append(el('span', 'quick-open-name', f.name));
      row.append(el('span', 'quick-open-path', f.relativePath));
      row.addEventListener('click', () => openFile(f));
      row.addEventListener('mousemove', () => {
        if (sel !== i) {
          sel = i;
          updateSelection();
        }
      });
      list.append(row);
    });
  };
  const applyFilter = () => {
    const q = input.value.trim().toLowerCase();
    matches = store.files
      .filter(
        (f) =>
          !q || f.name.toLowerCase().includes(q) || f.relativePath.toLowerCase().includes(q),
      )
      .slice(0, QUICK_OPEN_MAX_ROWS);
    sel = 0;
    renderList();
  };

  input.addEventListener('input', applyFilter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length) {
        sel = (sel + 1) % matches.length;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length) {
        sel = (sel - 1 + matches.length) % matches.length;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = matches[sel];
      if (f) openFile(f);
    }
  });

  applyFilter();
  input.focus();
}

export function showAboutDialog(): void {
  const { dialog, close } = createSheet();
  dialog.classList.add('dialog-about');
  dialog.append(el('div', 'about-name', 'Scribeleaf'));
  dialog.append(el('div', 'about-version', 'Version 0.1.0'));
  dialog.append(
    el(
      'p',
      'about-line',
      'An independent re-implementation of the Typora Markdown editor for macOS.',
    ),
  );
  const ok = btn('OK', true, close);
  dialog.append(buttons(ok));
  ok.focus();
}

export function confirmUnsaved(name: string): Promise<'save' | 'dontsave' | 'cancel'> {
  return new Promise((resolve) => {
    type Result = 'save' | 'dontsave' | 'cancel';
    let settled = false;
    let finish: (result: Result) => void = () => {};
    const { dialog, close } = createSheet('', () => finish('cancel'));
    finish = (result) => {
      if (settled) return;
      settled = true;
      close();
      resolve(result);
    };
    dialog.append(el('div', 'dialog-title', `Do you want to keep changes to "${name}"?`));
    dialog.append(el('p', 'dialog-message', "If you don't save, your changes will be lost."));
    const saveBtn = btn('Save…', true, () => finish('save'));
    dialog.append(
      buttons(
        btn('Cancel', false, () => finish('cancel')),
        btn("Don't Save", false, () => finish('dontsave')),
        saveBtn,
      ),
    );
    dialog.addEventListener('keydown', (e) => {
      // Enter activates the default (Save) unless a button handles it natively.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        finish('save');
      }
    });
    saveBtn.focus();
  });
}
