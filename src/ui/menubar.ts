// In-browser menu bar: renders MENU_SPEC as a slim macOS-style menu row and
// installs the global keyboard shortcut map. In the native shell the bar is
// hidden (AppKit provides real menus) but the shortcuts stay active.

import { isNative } from '../bridge';
import { runCommand } from '../commands';
import { store } from '../store';
import { MENU_SPEC, MenuItem } from './menuspec';
import { exportMenuItems } from '../export-settings';

let inited = false;
let openIndex = -1;
const menuEls: HTMLElement[] = [];
const checkEls: { item: MenuItem; check: HTMLSpanElement }[] = [];
const dynamicItems: { item: MenuItem; row: HTMLElement }[] = [];

interface ParsedShortcut {
  meta: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string;
}

interface BoundShortcut extends ParsedShortcut {
  command: string;
  payload: unknown;
  enabled?: () => boolean;
}

const boundShortcuts: BoundShortcut[] = [];

// Key names for non-printable shortcut glyphs used in MENU_SPEC.
const NAMED_KEYS: Record<string, string> = {
  '⌫': 'Backspace',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
};

// Physical KeyboardEvent.code for punctuation/digit shortcuts: macOS Option
// and Shift transform event.key for these (⌥= → ≠, ⇧= → +), so matching the
// physical key keeps shortcuts like ⌥⌘T and ⇧⌘= working.
const CODE_FOR_CHAR: Record<string, string> = {
  '=': 'Equal',
  '-': 'Minus',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  '/': 'Slash',
  '`': 'Backquote',
  ',': 'Comma',
  '.': 'Period',
  ';': 'Semicolon',
  "'": 'Quote',
  '0': 'Digit0',
  '1': 'Digit1',
  '2': 'Digit2',
  '3': 'Digit3',
  '4': 'Digit4',
  '5': 'Digit5',
  '6': 'Digit6',
  '7': 'Digit7',
  '8': 'Digit8',
  '9': 'Digit9',
};

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

function parseShortcut(display: string): ParsedShortcut | null {
  let meta = false;
  let shift = false;
  let alt = false;
  let ctrl = false;
  let i = 0;
  for (; i < display.length; i += 1) {
    const c = display[i];
    if (c === '⌘') meta = true;
    else if (c === '⇧') shift = true;
    else if (c === '⌥') alt = true;
    else if (c === '⌃') ctrl = true;
    else break;
  }
  const key = display.slice(i);
  if (!key) return null;
  return { meta, shift, alt, ctrl, key };
}

function keyMatches(want: string, e: KeyboardEvent): boolean {
  const named = NAMED_KEYS[want];
  if (named) return e.key === named || e.code === named;
  if (/^F\d{1,2}$/.test(want)) return e.key === want || e.code === want;
  if (want.length !== 1) return e.key === want;
  if (/[a-z]/i.test(want)) {
    return e.code === `Key${want.toUpperCase()}` || e.key.toLowerCase() === want.toLowerCase();
  }
  if (e.key === want) return true;
  const code = CODE_FOR_CHAR[want];
  return code !== undefined && e.code === code;
}

function menuSpecs() {
  return MENU_SPEC.map(spec => {
    if (spec.label !== 'File') return spec;
    const start = spec.items.findIndex(item => item.command === 'exportHtml');
    const end = spec.items.findIndex(item => item.command === 'exportLast');
    if (start < 0 || end < 0) return spec;
    const entries: MenuItem[] = exportMenuItems(store.exportSettings).map(entry => ({
      label: entry.label, command: 'exportFormat', payload: entry.key,
      disabledInBrowser: !['pdf', 'html', 'html-plain'].includes(entry.key),
      ...(entry.key === 'pdf' ? { shortcut: '⌃⌘P' } : {}),
    }));
    return { ...spec, items: [...spec.items.slice(0, start), ...entries, ...spec.items.slice(end)] };
  });
}

function collectShortcuts(): void {
  boundShortcuts.length = 0;
  const browser = !isNative();
  for (const menu of menuSpecs()) {
    for (const item of menu.items) {
      if (!item.command || !item.shortcut) continue;
      // The platform owns these keys. Its paste event carries HTML/files and
      // targets the actual focused editable, including nested table cells.
      if (['cut', 'copy', 'paste', 'pastePlainText'].includes(item.command)) continue;
      if (browser && item.disabledInBrowser) continue;
      const parsed = parseShortcut(item.shortcut);
      if (!parsed) continue;
      boundShortcuts.push({ ...parsed, command: item.command, payload: item.payload, enabled: item.enabled });
    }
  }
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (openIndex >= 0) {
      closeMenus();
      e.preventDefault();
    }
    return;
  }
  if (e.defaultPrevented) return; // CodeMirror already handled it
  const target = e.target;
  if (
    target instanceof Element &&
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  ) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && 'select' in target) {
      e.preventDefault();
      (target as HTMLInputElement).select();
    }
    return; // text controls own selection, typing and their local undo history
  }
  for (const sc of boundShortcuts) {
    if (sc.enabled && !sc.enabled()) continue;
    if (
      sc.meta === e.metaKey &&
      sc.shift === e.shiftKey &&
      sc.alt === e.altKey &&
      sc.ctrl === e.ctrlKey &&
      keyMatches(sc.key, e)
    ) {
      e.preventDefault();
      closeMenus();
      runCommand(sc.command, sc.payload);
      return;
    }
  }
}

function refreshChecks(): void {
  for (const { item, row } of dynamicItems) {
    const disabled = item.enabled?.() === false;
    row.setAttribute('aria-disabled', String(disabled));
    row.style.opacity = disabled ? '0.4' : '';
  }
  for (const { item, check } of checkEls) {
    let checked = false;
    if (item.prefCheck) checked = Boolean(store.prefs[item.prefCheck]);
    else if (item.themeCheck) checked = store.prefs.theme === item.themeCheck;
    check.textContent = checked ? '✓' : '';
  }
}

function closeMenus(): void {
  if (openIndex < 0) return;
  openIndex = -1;
  for (const menuEl of menuEls) menuEl.classList.remove('open');
}

function openMenu(index: number): void {
  openIndex = index;
  menuEls.forEach((menuEl, i) => menuEl.classList.toggle('open', i === index));
  refreshChecks();
}

function buildItem(item: MenuItem): HTMLElement {
  if (item.separator) return el('div', 'menu-separator');
  const row = el('div', 'menu-item');
  if (item.enabled) dynamicItems.push({ item, row });
  const check = el('span', 'menu-check');
  checkEls.push({ item, check });
  row.append(check, el('span', 'menu-label-text', item.label ?? ''));
  if (item.shortcut) row.append(el('span', 'menu-shortcut', item.shortcut));
  row.addEventListener('click', () => {
    if (item.enabled?.() === false) return;
    closeMenus();
    if (item.command) {
      runCommand(item.command, item.payload);
    } else if (item.prefCheck) {
      // Items without a command (Auto Save, Spellcheck) toggle the pref directly.
      const key = item.prefCheck;
      store.setPrefs({ [key]: !store.prefs[key] } as Partial<typeof store.prefs>);
    }
  });
  return row;
}

function renderBar(bar: HTMLElement): void {
  const browser = !isNative();
  menuSpecs().forEach((spec, index) => {
    const menuEl = el('div', 'menu');
    const label = el('button', 'menu-label', spec.label);
    label.type = 'button';
    label.addEventListener('click', () => {
      if (openIndex === index) closeMenus();
      else openMenu(index);
    });
    label.addEventListener('mouseenter', () => {
      if (openIndex >= 0 && openIndex !== index) openMenu(index);
    });
    const dropdown = el('div', 'menu-dropdown');
    for (const item of spec.items) {
      if (browser && item.disabledInBrowser) continue;
      dropdown.append(buildItem(item));
    }
    menuEl.append(label, dropdown);
    bar.append(menuEl);
    menuEls.push(menuEl);
  });
}

export function initMenubar(): void {
  if (inited) return;
  inited = true;
  const bar = document.getElementById('menubar');
  if (!bar) return;
  collectShortcuts();
  window.addEventListener('keydown', onGlobalKeydown);
  store.on('exportSettings', () => {
    collectShortcuts();
    if (!isNative()) {
      closeMenus(); bar.replaceChildren(); menuEls.length = 0; checkEls.length = 0; dynamicItems.length = 0;
      renderBar(bar);
    }
  });
  if (isNative()) {
    bar.style.display = 'none'; // native shell provides real menus
    return;
  }
  renderBar(bar);
  document.addEventListener('mousedown', (e) => {
    if (openIndex >= 0 && e.target instanceof Node && !bar.contains(e.target)) closeMenus();
  });
  window.addEventListener('blur', closeMenus);
  store.on('prefs', refreshChecks);
}
