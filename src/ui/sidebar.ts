// Sidebar chrome: Files/Outline tabs fed by the store, visibility and width
// preferences, drag resizer, folder file list/tree with filter, and outline list.

import { runCommand } from '../commands';
import { store } from '../store';
import { FileEntry, HeadingItem, Prefs } from '../types';
import { uiText } from '../i18n';
import { fileAllowed, filePathVisible, normalizeFilePreferences } from '../file-preferences';
import './sidebar-tree.css';

let inited = false;
let contentEl: HTMLElement | null = null;
let filesListEl: HTMLElement | null = null;
let outlineListEl: HTMLElement | null = null;
let currentTab: Prefs['sidebarTab'] | null = null;
let currentFilesView: Prefs['filesView'] | null = null;
let filterText = '';
let pendingWidth = 0;
let focusedPath: string | null = null;
let lastOpenedPath: string | null = null;
let lastOpenedRoot: string | null = null;
const expandedByRoot = new Map<string, Set<string>>();
let currentFilePreferences = '';
let currentOutlinePreference: boolean | null = null;
let focusedHeading = '';
const collapsedOutlines = new Map<string, Set<string>>();

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

interface DirNode {
  name: string;
  rel: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileEntry[];
}

interface VisibleRow {
  kind: 'dir' | 'file';
  name: string;
  rel: string;
  path: string;
  depth: number;
  expanded?: boolean;
  file?: FileEntry;
}

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

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function basename(path: string): string {
  const windowsPath = path.includes('\\') && !path.includes('/');
  const trimmed = windowsPath ? path.replace(/[\\]+$/, '') : path.replace(/[/]+$/, '');
  const idx = trimmed.lastIndexOf(windowsPath ? '\\' : '/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function joinPath(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = sep === '\\' ? root.replace(/[\\]+$/, '') : root.replace(/[/]+$/, '');
  return trimmed + sep + rel.split('/').join(sep);
}

function splitRel(rel: string): string[] {
  const windowsRoot = store.rootPath?.includes('\\') && !store.rootPath.includes('/');
  return (windowsRoot ? rel.split(/[/\\]+/) : rel.split('/')).filter(Boolean);
}

function naturalCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function icon(kind: 'folder' | 'file'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('sidebar-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', kind === 'folder'
    ? 'M1 4a1 1 0 0 1 1-1h4l1.5 2H14a1 1 0 0 1 1 1v7H1Z'
    : 'M4 1h5l4 4v10H4ZM9 1v4h4M6 8h5M6 10h5M6 12h4');
  path.setAttribute('fill', kind === 'folder' ? 'currentColor' : 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1');
  svg.append(path);
  return svg;
}

function expandedSet(root: string): Set<string> {
  let set = expandedByRoot.get(root);
  if (!set) {
    set = new Set(['']);
    expandedByRoot.set(root, set);
  }
  return set;
}

function isCollapsed(root: string, rel: string): boolean {
  return !expandedSet(root).has(rel);
}

function toggleCollapsed(root: string, rel: string): void {
  const set = expandedSet(root);
  if (set.has(rel)) set.delete(rel);
  else set.add(rel);
}

function buildTree(rootPath: string, files: FileEntry[]): DirNode {
  const root: DirNode = {
    name: basename(rootPath) || rootPath,
    rel: '',
    path: rootPath,
    dirs: new Map(),
    files: [],
  };
  // Native metadata also includes empty folders and folders containing assets.
  // Inferring directories only from Markdown files loses those visible nodes.
  const preferences = normalizeFilePreferences(store.prefs);
  for (const directory of store.directories.filter(directory => filePathVisible(directory.relativePath, preferences, 'tree'))) {
    let node = root;
    let acc = '';
    for (const part of splitRel(directory.relativePath)) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, rel: acc, path: joinPath(rootPath, acc), dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    if (node !== root) node.path = directory.path;
  }
  for (const src of files) {
    const f: FileEntry = { name: src.name, path: src.path, relativePath: src.relativePath };
    const parts = splitRel(f.relativePath);
    parts.pop();
    let node = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = {
          name: part,
          rel: acc,
          path: joinPath(rootPath, acc),
          dirs: new Map(),
          files: [],
        };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

function sortedDirChildren(node: DirNode): DirNode[] {
  return [...node.dirs.values()].sort((a, b) => naturalCmp(a.name, b.name));
}

function sortedFiles(files: FileEntry[]): FileEntry[] {
  return [...files].sort((a, b) => {
    const byName = naturalCmp(a.name, b.name);
    if (byName !== 0) return byName;
    return a.path.localeCompare(b.path);
  });
}

function nodeMatches(node: DirNode, q: string): boolean {
  if (!q) return true;
  if (node.rel.toLowerCase().includes(q) || node.name.toLowerCase().includes(q)) return true;
  for (const f of node.files) {
    if (f.relativePath.toLowerCase().includes(q)) return true;
  }
  for (const child of node.dirs.values()) {
    if (nodeMatches(child, q)) return true;
  }
  return false;
}

function flattenTree(rootPath: string, node: DirNode, depth: number, q: string, out: VisibleRow[]): void {
  const filtering = q.length > 0;
  const expanded = filtering || !isCollapsed(rootPath, node.rel);
  out.push({
    kind: 'dir',
    name: node.name,
    rel: node.rel,
    path: node.path,
    depth,
    expanded,
  });
  if (!expanded) return;
  for (const child of sortedDirChildren(node)) {
    if (!filtering || nodeMatches(child, q)) flattenTree(rootPath, child, depth + 1, q, out);
  }
  for (const f of sortedFiles(node.files)) {
    if (!filtering || f.relativePath.toLowerCase().includes(q)) {
      out.push({
        kind: 'file',
        name: f.name,
        rel: f.relativePath,
        path: f.path,
        depth: depth + 1,
        file: f,
      });
    }
  }
}

function expandAncestorsOf(filePath: string): void {
  const root = store.rootPath;
  if (!root) return;
  const file = store.files.find((f) => f.path === filePath);
  if (!file) return;
  const set = expandedSet(root);
  set.add('');
  const parts = splitRel(file.relativePath);
  parts.pop();
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    set.add(acc);
  }
}

function visibleRows(): VisibleRow[] {
  const root = store.rootPath;
  if (!root) return [];
  const q = filterText.trim().toLowerCase();
  const preferences = normalizeFilePreferences(store.prefs);
  const tree = buildTree(root, store.files.filter(file => fileAllowed(file.name, file.relativePath, preferences, 'tree')));
  const out: VisibleRow[] = [];
  flattenTree(root, tree, 0, q, out);
  return out;
}

function filesView(): Prefs['filesView'] {
  return store.prefs.filesView === 'list' ? 'list' : 'tree';
}

// ---- files tab ----

function revealCurrentFile(): void {
  if (store.currentPath === lastOpenedPath && store.rootPath === lastOpenedRoot) return;
  lastOpenedPath = store.currentPath;
  lastOpenedRoot = store.rootPath;
  if (store.currentPath) expandAncestorsOf(store.currentPath);
}

function focusedRowPath(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !filesListEl?.contains(active)) return null;
  return active.closest<HTMLElement>('[data-path]')?.dataset.path ?? null;
}

function restoreRowFocus(path: string | null): void {
  if (!path || !filesListEl) return;
  const rows = Array.from(filesListEl.querySelectorAll<HTMLElement>('[data-path]'));
  const target = rows.find(row => row.dataset.path === path) ?? rows.find(row => row.tabIndex === 0);
  if (!target) return;
  for (const row of rows) row.tabIndex = row === target ? 0 : -1;
  focusedPath = target.dataset.path ?? null;
  target.focus();
}

function renderFiles(): void {
  const content = contentEl;
  if (!content) return;
  const rowFocus = focusedRowPath();
  revealCurrentFile();
  content.replaceChildren();
  const view = filesView();
  const wrap = el('div', `sidebar-files sidebar-files-${view}`);
  if (view === 'list' || !store.rootPath) {
    const rootName = store.rootPath ? basename(store.rootPath) : uiText('No Folder');
    const root = el('div', 'sidebar-root-header');
    root.append(icon('folder'), document.createTextNode(rootName));
    wrap.append(root);
  }
  const filter = el('input', 'sidebar-filter');
  filter.type = 'text';
  filter.placeholder = uiText('Filter files…');
  filter.setAttribute('aria-label', uiText('Filter files…'));
  filter.spellcheck = false;
  filter.value = filterText;
  filter.addEventListener('input', () => {
    filterText = filter.value;
    renderFileRows();
  });
  wrap.append(filter);
  filesListEl = el('div', view === 'tree' ? 'sidebar-tree' : 'sidebar-list');
  filesListEl.setAttribute('role', view === 'tree' ? 'tree' : 'listbox');
  filesListEl.setAttribute('aria-label', uiText('Files'));
  filesListEl.addEventListener('keydown', view === 'tree' ? onTreeKeyDown : onListKeyDown);
  wrap.append(filesListEl);
  content.append(wrap);
  renderFileRows();
  restoreRowFocus(rowFocus);
}

function restoreFilterFocus(hadFocus: boolean): void {
  if (!hadFocus) return;
  const input = contentEl?.querySelector<HTMLInputElement>('.sidebar-filter');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function renderFileRows(): void {
  const rowFocus = focusedRowPath();
  if (filesView() === 'tree') renderTreeRows();
  else renderListRows();
  restoreRowFocus(rowFocus);
}

function renderListRows(): void {
  const list = filesListEl;
  if (!list) return;
  list.replaceChildren();
  if (!store.rootPath) {
    list.append(el('div', 'sidebar-empty', uiText('Open a folder to browse files')));
    return;
  }
  const q = filterText.trim().toLowerCase();
  const preferences = normalizeFilePreferences(store.prefs);
  const files = sortedFiles(store.files.filter((f) => fileAllowed(f.name, f.relativePath, preferences, 'library') && (!q || f.relativePath.toLowerCase().includes(q))));
  if (!files.length) {
    list.append(el('div', 'sidebar-empty', uiText('No matching files')));
    return;
  }
  for (const f of files) list.append(fileRow(f));
  applyListFocus();
}

function fileRow(f: FileEntry): HTMLElement {
  const row = el('div', 'sidebar-row sidebar-file-row');
  if (f.path === store.currentPath) row.classList.add('active');
  row.title = f.relativePath;
  row.dataset.path = f.path;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(f.path === store.currentPath));
  if (f.path === store.currentPath) row.setAttribute('aria-current', 'page');
  row.tabIndex = -1;
  row.append(icon('file'), el('span', 'sidebar-file-name', f.name));
  row.append(el('span', 'sidebar-file-path', f.relativePath));
  row.addEventListener('click', () => {
    focusedPath = f.path;
    restoreRowFocus(f.path);
    runCommand('openPath', f.path);
  });
  return row;
}

function renderTreeRows(): void {
  const list = filesListEl;
  if (!list) return;
  list.replaceChildren();
  if (!store.rootPath) {
    list.append(el('div', 'sidebar-empty', uiText('Open a folder to browse files')));
    return;
  }
  const rows = visibleRows();
  if (rows.length <= 1 && filterText.trim() && (store.files.length || store.directories.length)) {
    list.append(el('div', 'sidebar-empty', uiText('No matching files')));
    return;
  }
  const paths = new Set(rows.map((r) => r.path));
  if (focusedPath && !paths.has(focusedPath)) focusedPath = null;
  if (!focusedPath) focusedPath = store.currentPath && paths.has(store.currentPath)
    ? store.currentPath
    : (rows[0]?.path ?? null);
  const groups = new Map<number, HTMLElement>();
  groups.set(0, list);
  for (const item of rows) {
    const row = treeRow(item, item.path === focusedPath);
    (groups.get(item.depth) ?? list).append(row);
    if (item.kind === 'dir' && item.expanded) {
      const group = el('div', 'sidebar-tree-group');
      group.setAttribute('role', 'group');
      row.append(group);
      groups.set(item.depth + 1, group);
    }
  }
}

function treeRow(item: VisibleRow, focused: boolean): HTMLElement {
  const row = el('div', 'sidebar-tree-item');
  const line = el('div', 'sidebar-tree-row');
  row.append(line);
  row.dataset.path = item.path;
  row.dataset.kind = item.kind;
  row.dataset.rel = item.rel;
  row.style.setProperty('--tree-depth', String(item.depth));
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-label', item.name);
  row.setAttribute('aria-level', String(item.depth + 1));
  row.tabIndex = focused ? 0 : -1;
  const selected = item.kind === 'file' && item.path === store.currentPath;
  row.classList.toggle('active', selected);
  row.setAttribute('aria-selected', String(selected));
  if (selected) row.setAttribute('aria-current', 'page');
  if (item.kind === 'dir') {
    row.setAttribute('aria-expanded', item.expanded ? 'true' : 'false');
    const twist = el('span', 'sidebar-tree-twistie');
    line.append(twist, icon('folder'), el('span', 'sidebar-tree-label', item.name));
    row.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      focusedPath = item.path;
      if (store.rootPath) toggleCollapsed(store.rootPath, item.rel);
      renderFileRows();
      restoreRowFocus(item.path);
    });
  } else if (item.file) {
    const twist = el('span', 'sidebar-tree-twistie is-leaf');
    line.append(twist, icon('file'), el('span', 'sidebar-tree-label', item.name));
    row.title = item.file.relativePath;
    const file = item.file;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      focusedPath = file.path;
      restoreRowFocus(file.path);
      runCommand('openPath', file.path);
    });
  }
  return row;
}

function treeItems(): HTMLElement[] {
  if (!filesListEl) return [];
  return Array.from(filesListEl.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

function focusTreeIndex(index: number): void {
  const items = treeItems();
  if (!items.length) return;
  const i = Math.max(0, Math.min(items.length - 1, index));
  for (const item of items) item.tabIndex = -1;
  const target = items[i];
  target.tabIndex = 0;
  focusedPath = target.dataset.path ?? null;
  target.focus();
  for (const item of items) {
    const selected = item.dataset.kind === 'file' && item.dataset.path === store.currentPath;
    item.setAttribute('aria-selected', String(selected));
  }
}

function onTreeKeyDown(e: KeyboardEvent): void {
  const items = treeItems();
  if (!items.length) return;
  const current = document.activeElement instanceof HTMLElement
    ? items.indexOf(document.activeElement)
    : items.findIndex((n) => n.dataset.path === focusedPath);
  const idx = current >= 0 ? current : 0;
  const node = items[idx];
  const kind = node?.dataset.kind;
  const rel = node?.dataset.rel ?? '';
  const root = store.rootPath;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusTreeIndex(idx + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusTreeIndex(idx - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusTreeIndex(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusTreeIndex(items.length - 1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (kind === 'dir' && node.getAttribute('aria-expanded') === 'true' && root) {
      expandedSet(root).delete(rel);
      focusedPath = node.dataset.path ?? null;
      renderFileRows();
      treeItems().find((n) => n.dataset.path === focusedPath)?.focus();
    } else if (kind === 'dir' || kind === 'file') {
      const depth = Number(node.style.getPropertyValue('--tree-depth') || '0');
      for (let i = idx - 1; i >= 0; i--) {
        const d = Number(items[i].style.getPropertyValue('--tree-depth') || '0');
        if (d < depth) {
          focusTreeIndex(i);
          break;
        }
      }
    }
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (kind === 'dir' && node.getAttribute('aria-expanded') === 'false' && root) {
      expandedSet(root).add(rel);
      focusedPath = node.dataset.path ?? null;
      renderFileRows();
      treeItems().find((n) => n.dataset.path === focusedPath)?.focus();
    } else if (kind === 'dir' && node.getAttribute('aria-expanded') === 'true' &&
      Number(items[idx + 1]?.getAttribute('aria-level') ?? '0') > Number(node.getAttribute('aria-level'))) {
      focusTreeIndex(idx + 1);
    }
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (kind === 'dir' && root) {
      toggleCollapsed(root, rel);
      focusedPath = node.dataset.path ?? null;
      renderFileRows();
      treeItems().find((n) => n.dataset.path === focusedPath)?.focus();
    } else if (kind === 'file' && e.key === 'Enter' && node.dataset.path) {
      runCommand('openPath', node.dataset.path);
    }
  }
}

function applyListFocus(): void {
  if (!filesListEl) return;
  const rows = Array.from(filesListEl.querySelectorAll<HTMLElement>('[data-path]'));
  if (!rows.some(row => row.dataset.path === focusedPath)) {
    focusedPath = rows.find(row => row.dataset.path === store.currentPath)?.dataset.path ?? rows[0]?.dataset.path ?? null;
  }
  for (const row of rows) row.tabIndex = row.dataset.path === focusedPath ? 0 : -1;
}

function onListKeyDown(e: KeyboardEvent): void {
  if (!filesListEl) return;
  const rows = Array.from(filesListEl.querySelectorAll<HTMLElement>('[data-path]'));
  const index = Math.max(0, rows.indexOf(document.activeElement as HTMLElement));
  let target = index;
  if (e.key === 'ArrowDown') target = Math.min(rows.length - 1, index + 1);
  else if (e.key === 'ArrowUp') target = Math.max(0, index - 1);
  else if (e.key === 'Home') target = 0;
  else if (e.key === 'End') target = rows.length - 1;
  else if (e.key === 'Enter' && rows[index]) {
    e.preventDefault();
    runCommand('openPath', rows[index].dataset.path);
    return;
  } else return;
  e.preventDefault();
  restoreRowFocus(rows[target]?.dataset.path ?? null);
}

function updateActiveFile(): void {
  const list = filesListEl;
  if (!list) return;
  if (filesView() === 'tree') {
    for (const child of treeItems()) {
      const on = child.dataset.kind === 'file' && child.dataset.path === store.currentPath;
      child.classList.toggle('active', on);
      if (on) child.setAttribute('aria-current', 'page');
      else child.removeAttribute('aria-current');
      child.setAttribute('aria-selected', String(on));
    }
    return;
  }
  for (const child of Array.from(list.children)) {
    const row = child as HTMLElement;
    if (row.dataset.path !== undefined) {
      const selected = row.dataset.path === store.currentPath;
      row.classList.toggle('active', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    }
  }
}

// ---- outline tab ----

function renderOutline(): void {
  const content = contentEl;
  if (!content) return;
  content.replaceChildren();
  const wrap = el('div', 'sidebar-outline');
  outlineListEl = el('div', 'sidebar-list');
  outlineListEl.setAttribute('aria-label', uiText('Outline'));
  outlineListEl.addEventListener('keydown', onOutlineKeyDown);
  wrap.append(outlineListEl);
  content.append(wrap);
  renderOutlineList();
}

interface OutlineNode {
  heading: HeadingItem;
  key: string;
  parent: OutlineNode | null;
  children: OutlineNode[];
  depth: number;
}

function outlineNodes(): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const repeated = new Map<string, number>();
  for (const heading of store.outline) {
    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) stack.pop();
    const base = `${heading.level}:${heading.text}`;
    const occurrence = repeated.get(base) ?? 0;
    repeated.set(base, occurrence + 1);
    const parent = stack[stack.length - 1] ?? null;
    const node: OutlineNode = { heading, key: `${base}:${occurrence}`, parent, children: [], depth: stack.length };
    (parent?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

function outlineCollapsedSet(): Set<string> {
  const path = store.currentPath ?? `untitled:${store.currentName}`;
  let set = collapsedOutlines.get(path);
  if (!set) {
    set = new Set();
    const roots = outlineNodes();
    const add = (nodes: OutlineNode[]) => {
      for (const node of nodes) { if (node.children.length) set!.add(node.key); add(node.children); }
    };
    add(roots);
    if (roots.length === 1) set.delete(roots[0].key);
    collapsedOutlines.set(path, set);
  }
  return set;
}

function renderOutlineList(): void {
  const list = outlineListEl;
  if (!list) return;
  const hadFocus = document.activeElement instanceof HTMLElement && list.contains(document.activeElement);
  if (hadFocus) focusedHeading = (document.activeElement as HTMLElement).closest<HTMLElement>('[data-outline-key]')?.dataset.outlineKey ?? focusedHeading;
  list.replaceChildren();
  if (!store.outline.length) {
    list.append(el('div', 'sidebar-empty', uiText('No headings')));
    return;
  }
  const collapsible = normalizeFilePreferences(store.prefs).collapsibleOutline;
  list.setAttribute('role', collapsible ? 'tree' : 'listbox');
  const collapsed = outlineCollapsedSet();
  const append = (nodes: OutlineNode[]) => {
    for (const node of nodes) {
      const expanded = !collapsible || !collapsed.has(node.key);
      list.append(outlineRow(node, collapsible, expanded));
      if (expanded) append(node.children);
    }
  };
  append(outlineNodes());
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-outline-key]'));
  const target = rows.find(row => row.dataset.outlineKey === focusedHeading)
    ?? rows.find(row => Number(row.dataset.pos) === store.activeHeadingPos) ?? rows[0];
  for (const row of rows) row.tabIndex = row === target ? 0 : -1;
  if (target) {
    focusedHeading = target.dataset.outlineKey!;
    if (hadFocus) target.focus();
  }
  updateActiveHeading();
}

function outlineRow(node: OutlineNode, collapsible: boolean, expanded: boolean): HTMLElement {
  const h = node.heading;
  const row = el('div', 'sidebar-row sidebar-outline-row');
  const level = Math.min(Math.max(h.level, 1), 6);
  row.style.paddingLeft = `${8 + (level - 1) * 14}px`;
  if (h.pos === store.activeHeadingPos) row.classList.add('active');
  row.dataset.pos = String(h.pos);
  row.dataset.outlineKey = node.key;
  row.dataset.parentKey = node.parent?.key ?? '';
  row.dataset.depth = String(node.depth);
  row.setAttribute('role', collapsible ? 'treeitem' : 'option');
  row.setAttribute('aria-level', String(node.depth + 1));
  row.setAttribute('aria-selected', String(h.pos === store.activeHeadingPos));
  row.setAttribute('aria-label', h.text);
  row.tabIndex = -1;
  if (collapsible && node.children.length) {
    row.setAttribute('aria-expanded', String(expanded));
    const disclosure = el('button', 'sidebar-outline-disclosure', expanded ? '▾' : '▸');
    disclosure.type = 'button';
    disclosure.tabIndex = -1;
    disclosure.setAttribute('aria-label', expanded ? uiText('Collapse') : uiText('Expand'));
    disclosure.style.cssText = 'border:0;background:none;color:inherit;font:inherit;padding:0;width:14px;flex:none;cursor:pointer';
    disclosure.addEventListener('click', event => {
      event.stopPropagation();
      focusedHeading = node.key;
      const set = outlineCollapsedSet();
      if (set.has(node.key)) set.delete(node.key); else set.add(node.key);
      renderOutlineList();
      outlineListEl?.querySelectorAll<HTMLElement>('[data-outline-key]').forEach(item => {
        if (item.dataset.outlineKey === node.key) item.focus();
      });
    });
    row.append(disclosure);
  } else if (collapsible) {
    const spacer = el('span'); spacer.style.cssText = 'display:inline-block;width:14px;flex:none'; row.append(spacer);
  }
  row.append(el('span', 'sidebar-outline-label', h.text));
  row.addEventListener('click', () => {
    focusedHeading = node.key;
    for (const item of outlineListEl?.querySelectorAll<HTMLElement>('[data-outline-key]') ?? []) item.tabIndex = item === row ? 0 : -1;
    row.focus();
    runCommand('scrollToPos', h.pos);
    if (collapsible && node.children.length && !expanded) {
      outlineCollapsedSet().delete(node.key); renderOutlineList();
    }
  });
  return row;
}

function onOutlineKeyDown(event: KeyboardEvent): void {
  if (!outlineListEl) return;
  const rows = Array.from(outlineListEl.querySelectorAll<HTMLElement>('[data-outline-key]'));
  const index = Math.max(0, rows.indexOf(document.activeElement as HTMLElement));
  const row = rows[index];
  if (!row) return;
  const focus = (target: HTMLElement | undefined) => {
    if (!target) return;
    for (const item of rows) item.tabIndex = item === target ? 0 : -1;
    focusedHeading = target.dataset.outlineKey!; target.focus();
  };
  if (event.key === 'ArrowDown') focus(rows[Math.min(rows.length - 1, index + 1)]);
  else if (event.key === 'ArrowUp') focus(rows[Math.max(0, index - 1)]);
  else if (event.key === 'Home') focus(rows[0]);
  else if (event.key === 'End') focus(rows[rows.length - 1]);
  else if (event.key === 'Enter' || event.key === ' ') row.click();
  else if (event.key === 'ArrowLeft') {
    if (row.getAttribute('aria-expanded') === 'true') {
      outlineCollapsedSet().add(row.dataset.outlineKey!); renderOutlineList();
    } else focus(rows.find(item => item.dataset.outlineKey === row.dataset.parentKey));
  } else if (event.key === 'ArrowRight') {
    if (row.getAttribute('aria-expanded') === 'false') {
      outlineCollapsedSet().delete(row.dataset.outlineKey!); renderOutlineList();
    } else if (Number(rows[index + 1]?.dataset.depth) > Number(row.dataset.depth)) focus(rows[index + 1]);
  } else return;
  event.preventDefault();
}

function updateActiveHeading(): void {
  const list = outlineListEl;
  if (!list) return;
  let active = String(store.activeHeadingPos);
  const visible = new Set(Array.from(list.querySelectorAll<HTMLElement>('[data-outline-key]')).map(row => row.dataset.outlineKey));
  const find = (nodes: OutlineNode[]): OutlineNode | undefined => {
    for (const node of nodes) {
      if (node.heading.pos === store.activeHeadingPos) return node;
      const child = find(node.children);
      if (child) return child;
    }
    return undefined;
  };
  let node = find(outlineNodes());
  while (node && !visible.has(node.key)) node = node.parent ?? undefined;
  if (node) active = String(node.heading.pos);
  for (const child of Array.from(list.children)) {
    const row = child as HTMLElement;
    if (row.dataset.pos !== undefined) {
      row.classList.toggle('active', row.dataset.pos === active);
      row.setAttribute('aria-selected', String(row.dataset.pos === active));
    }
  }
}

// ---- shell ----

function renderContent(): void {
  if (currentTab === 'files') renderFiles();
  else renderOutline();
}

function filterHasFocus(): boolean {
  return document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains('sidebar-filter');
}

function applyPrefs(sidebar: HTMLElement, tabs: HTMLButtonElement[]): void {
  const prefs = store.prefs;
  document.body.classList.toggle('sidebar-hidden', !prefs.sidebarVisible);
  sidebar.style.width = `${clampWidth(prefs.sidebarWidth)}px`;
  for (const tab of tabs) {
    tab.textContent = uiText(tab.dataset.tab === 'files' ? 'Files' : 'Outline');
    tab.classList.toggle('active', tab.dataset.tab === prefs.sidebarTab);
  }
  const view = filesView();
  const tabChanged = currentTab !== prefs.sidebarTab;
  const viewChanged = currentFilesView !== view;
  const filePreferences = normalizeFilePreferences(prefs);
  const signature = JSON.stringify([filePreferences.defaultExtension, filePreferences.showHiddenFiles,
    filePreferences.treeFileFilterMode, filePreferences.libraryFileFilterMode,
    filePreferences.treeFileFilterPatterns, filePreferences.libraryFileFilterPatterns]);
  const filtersChanged = currentFilePreferences !== signature;
  const outlineChanged = currentOutlinePreference !== filePreferences.collapsibleOutline;
  currentFilePreferences = signature;
  currentOutlinePreference = filePreferences.collapsibleOutline;
  if (tabChanged || (prefs.sidebarTab === 'files' && (viewChanged || filtersChanged))) {
    const keepFilter = filterHasFocus();
    currentTab = prefs.sidebarTab;
    currentFilesView = view;
    renderContent();
    if (prefs.sidebarTab === 'files') restoreFilterFocus(keepFilter);
  } else if (prefs.sidebarTab === 'outline' && outlineChanged) {
    renderOutlineList();
  }
}

export function initSidebar(): void {
  if (inited) return;
  inited = true;
  const sidebar = document.getElementById('sidebar');
  const resizer = document.getElementById('sidebar-resizer');
  const content = document.getElementById('sidebar-content');
  if (!sidebar || !resizer || !content) return;
  contentEl = content;

  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar-tab'));
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      store.setPrefs({ sidebarTab: tab.dataset.tab === 'files' ? 'files' : 'outline' });
    });
  }

  document.getElementById('sidebar-collapse')?.addEventListener('click', () => {
    store.setPrefs({ sidebarVisible: !store.prefs.sidebarVisible });
  });

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('sidebar-resizing');
    const onMove = (ev: MouseEvent) => {
      pendingWidth = clampWidth(ev.clientX);
      sidebar.style.width = `${pendingWidth}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('sidebar-resizing');
      if (pendingWidth > 0) {
        store.setPrefs({ sidebarWidth: pendingWidth });
        pendingWidth = 0;
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  store.on('prefs', () => applyPrefs(sidebar, tabs));
  store.on('files', () => {
    if (currentTab !== 'files') return;
    const hadFocus = filterHasFocus();
    const input = hadFocus ? contentEl?.querySelector<HTMLInputElement>('.sidebar-filter') : null;
    const selection = input ? [input.selectionStart, input.selectionEnd, input.selectionDirection] as const : null;
    const scroll = content.scrollTop;
    renderFiles();
    restoreFilterFocus(hadFocus);
    if (selection && selection[0] !== null && selection[1] !== null) {
      contentEl?.querySelector<HTMLInputElement>('.sidebar-filter')?.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
    }
    content.scrollTop = scroll;
  });
  store.on('file', () => {
    if (currentTab !== 'files') return;
    if (store.currentPath !== lastOpenedPath || store.rootPath !== lastOpenedRoot) {
      revealCurrentFile();
      const hadFocus = filterHasFocus();
      renderFileRows();
      restoreFilterFocus(hadFocus);
    } else {
      updateActiveFile();
    }
  });
  store.on('outline', () => {
    if (currentTab === 'outline') renderOutlineList();
  });
  store.on('cursor', () => {
    if (currentTab === 'outline') updateActiveHeading();
  });

  applyPrefs(sidebar, tabs);
}
