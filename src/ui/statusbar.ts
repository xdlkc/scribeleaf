// Status bar: sidebar toggle and current file name (with dirty marker) on the
// left; selection/word counts (click to cycle unit) and theme label on the right.

import { runCommand } from '../commands';
import { store } from '../store';
import { Prefs } from '../types';
import { uiText, usesSimplifiedChinese } from '../i18n';

let inited = false;

const UNIT_ORDER: Prefs['wordCountUnit'][] = ['words', 'characters', 'paragraphs'];

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

export function initStatusbar(): void {
  if (inited) return;
  inited = true;
  const left = document.getElementById('status-left');
  const right = document.getElementById('status-right');
  if (!left || !right) return;

  const toggle = el('button', 'status-btn status-toggle', '☰');
  toggle.type = 'button';
  toggle.title = uiText('Toggle Sidebar');
  toggle.addEventListener('click', () => runCommand('toggleSidebar'));
  const name = el('span', 'status-filename');
  left.append(toggle, name);

  const count = el('button', 'status-btn status-count');
  count.type = 'button';
  count.title = uiText('Click to change count unit');
  count.addEventListener('click', () => {
    const next = UNIT_ORDER[(UNIT_ORDER.indexOf(store.prefs.wordCountUnit) + 1) % UNIT_ORDER.length];
    store.setPrefs({ wordCountUnit: next });
  });
  const sep = el('span', 'status-sep', '·');
  const theme = el('button', 'status-btn status-theme');
  theme.type = 'button';
  theme.title = uiText('Preferences');
  theme.addEventListener('click', () => runCommand('preferences'));
  right.append(count, sep, theme);

  const renderFile = () => {
    name.textContent = store.currentName + (store.dirty ? ' ●' : '');
  };
  const renderStats = () => {
    const s = store.stats;
    let main: string;
    switch (store.prefs.wordCountUnit) {
      case 'characters':
        main = usesSimplifiedChinese ? `${s.chars} 字符` : `${s.chars} characters`;
        break;
      case 'paragraphs':
        main = usesSimplifiedChinese ? `${s.paragraphs} 段` : `${s.paragraphs} paragraphs`;
        break;
      default:
        main = usesSimplifiedChinese ? `${s.words} 词` : `${s.words} words`;
        break;
    }
    const prefix = s.selChars > 0 ? (usesSimplifiedChinese ? `已选 ${s.selWords} 词 · ` : `${s.selWords} words selected · `) : '';
    count.textContent = prefix + main;
  };
  const renderTheme = () => {
    const t = store.prefs.theme;
    theme.textContent = t.charAt(0).toUpperCase() + t.slice(1);
  };

  renderFile();
  renderStats();
  renderTheme();
  store.on('file', renderFile);
  store.on('dirty', renderFile);
  store.on('stats', renderStats);
  store.on('prefs', () => {
    renderStats();
    renderTheme();
  });
}
