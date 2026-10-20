// Application bootstrap and command wiring.

import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/400-italic.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import '@fontsource/open-sans/700-italic.css';
import './themes/github.css';
import './themes/gothic.css';
import './themes/night.css';
import './themes/newsprint.css';
import './themes/pixyll.css';
import './themes/whitey.css';
import './styles/base.css';
import './ui/ui.css';
import './ui/preferences.css';

import { EditorView } from '@codemirror/view';
import { undo, redo, selectAll, cursorDocStart, cursorDocEnd, selectLine, deleteLine } from '@codemirror/commands';
import { findNext, findPrevious } from '@codemirror/search';

import { store } from './store';
import { registerCommand, runCommand } from './commands';
import * as bridge from './bridge';
import { isNative } from './bridge';
import { createEditor, createEditorState, setEditorUpdateHandler, EditorHandle } from './editor/setup';
import { openFind } from './editor/searchpanel';
import * as fmt from './editor/format';
import { registerProductCommands } from './editor/product-commands';
import { extractOutline, activeHeadingPos } from './outline';
import { countStats } from './wordcount';
import { buildStandaloneHtml, printMarkdown } from './export';
import { isExportFormat, repeatExportAvailability, type ExportFormat, type RepeatExportRequest } from './export-formats';
import { freezeEntry, loadExportOption, replicaFormatId, extractYamlFrontMatter, type FrozenExportSnapshot } from './export-settings';
import { mountPreferences } from './ui/preferences';
import { receiveImageUploaderTestResult } from './ui/preference-panels';
import { uiText } from './i18n';
import { freezeMarkdownPreferences, type MarkdownPreferences } from './markdown-preferences';
import { initMenubar } from './ui/menubar';
import { initSidebar } from './ui/sidebar';
import { initStatusbar } from './ui/statusbar';
import {
  openTableDialog,
  openLinkDialog,
  openImageDialog,
  openPreferencesDialog,
  openQuickOpen,
  showAboutDialog,
  confirmUnsaved,
} from './ui/dialogs';
import { ThemeName } from './types';
import { handleClipboardResult, pasteFromSystem, CLIPBOARD_ERROR_EVENT, type ClipboardResultPayload } from './editor/clipboard';
import { handleFileDropResult, FILE_DROP_ERROR_EVENT, type FileDropResult } from './editor/file-drop';

// ---------------------------------------------------------------------------

let handle: EditorHandle;
let view: EditorView;
let pendingAfterSave: (() => void) | null = null;
let autosaveTimer: number | null = null;
let statsTimer: number | null = null;
let docEol: '\n' | '\r\n' = '\n';
let savedMarkdown = '';
let loadingDocument = false;
let documentGeneration = 0;
let appliedEditorPrefs: {sourceMode: boolean; spellcheck: boolean; theme: ThemeName; focusMode: boolean} | null = null;

const SAMPLE_URL = 'samples/welcome.md';
const SAMPLE_BASE = 'samples/';

function toEditorEol(text: string): string {
  docEol = text.includes('\r\n') ? '\r\n' : '\n';
  return docEol === '\r\n' ? text.replace(/\r\n/g, '\n') : text;
}

function fromEditorEol(text: string): string {
  return docEol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

function getMarkdown(): string {
  return fromEditorEol(view.state.doc.toString());
}

function dirOf(path: string): string {
  const idx = path.replace(/\/+$/, '').lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx + 1) : '';
}

function documentBaseUrl(path: string): string {
  const dir = dirOf(path);
  if (!path.startsWith('/')) return new URL(dir, document.baseURI).href;
  return 'file://' + encodeURI(dir).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/** Replace the whole document with fresh state (clears undo history). */
function loadDocument(markdown: string, path: string | null, name: string, base?: string): void {
  documentGeneration++;
  loadingDocument = true;
  if (autosaveTimer !== null) { window.clearTimeout(autosaveTimer); autosaveTimer = null; }
  try {
    store.setFile(path, name);
    store.docBase = base ?? (path ? documentBaseUrl(path) : '');
    view.setState(createEditorState(toEditorEol(markdown)));
    savedMarkdown = getMarkdown();
    store.setDirty(false);
    store.clearRecovery();
  } finally { loadingDocument = false; }
  updateDerived(true);
  updateTitle();
  view.focus();
}

async function loadSample(): Promise<void> {
  const generation = ++documentGeneration;
  try {
    const res = await fetch(SAMPLE_URL);
    const md = await res.text();
    if (generation === documentGeneration) loadDocument(md, null, 'welcome.md', SAMPLE_BASE);
  } catch (err) {
    console.error('[main] failed to load sample', err);
  }
}

function updateTitle(): void {
  const title = `${store.currentName}${store.dirty ? ' — Edited' : ''} — Scribeleaf`;
  document.title = title;
  bridge.notifyTitle(title);
}

function updateDerived(immediate = false): void {
  if (statsTimer !== null) window.clearTimeout(statsTimer);
  const run = () => {
    statsTimer = null;
    const text = view.state.doc.toString();
    const sel = view.state.selection.main;
    store.setStats(countStats(text, sel.from, sel.to));
    const outline = extractOutline(text);
    store.setOutline(outline);
    store.setActiveHeadingPos(activeHeadingPos(outline, sel.head));
  };
  if (immediate) run();
  else statsTimer = window.setTimeout(run, 200);
}

function applyPrefs(): void {
  const p = store.prefs;
  if (isNative() && !p.autoSave && autosaveTimer !== null) { window.clearTimeout(autosaveTimer); autosaveTimer = null; }
  document.body.dataset.theme = p.theme;
  document.body.classList.toggle('source-mode', p.sourceMode);
  document.documentElement.style.setProperty('--editor-font-size', `${(16 * p.zoom) / 100}px`);
  document.documentElement.style.setProperty('--native-sidebar-width', p.sidebarVisible ? `${p.sidebarWidth}px` : '0px');
  if (!appliedEditorPrefs || p.sourceMode !== appliedEditorPrefs.sourceMode) handle.setLiveMode(!p.sourceMode);
  if (!appliedEditorPrefs || p.spellcheck !== appliedEditorPrefs.spellcheck) handle.setSpellcheck(p.spellcheck);
  if (!appliedEditorPrefs || p.theme !== appliedEditorPrefs.theme || p.focusMode !== appliedEditorPrefs.focusMode) handle.refresh();
  appliedEditorPrefs = {sourceMode: p.sourceMode, spellcheck: p.spellcheck, theme: p.theme, focusMode: p.focusMode};
}

// --- unsaved changes guard ---------------------------------------------------

function guardUnsaved(action: () => void): void {
  if (!store.dirty) {
    action();
    return;
  }
  void confirmUnsaved(store.currentName).then((choice) => {
    if (choice === 'cancel') return;
    if (choice === 'dontsave') {
      store.setDirty(false);
      store.clearRecovery();
      action();
      return;
    }
    // save first, then continue
    pendingAfterSave = action;
    runCommand('save');
    if (!isNative()) {
      // browser download is synchronous from our point of view
      pendingAfterSave = null;
      action();
    }
  });
}

// --- toasts -----------------------------------------------------------------

let toastEl: HTMLElement | null = null;
let toastTimer: number | null = null;

export function notice(message: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'app-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('visible'), 2600);
}

// --- file actions ------------------------------------------------------------

async function doSave(): Promise<void> {
  const md = getMarkdown();
  if (isNative()) {
    bridge.nativeSave(md, store.currentPath);
  } else {
    let name = store.currentName || 'Untitled.md';
    if (!/\.(md|markdown|mdown|txt)$/i.test(name)) name += '.md';
    bridge.downloadText(name, md);
    savedMarkdown = md;
    store.setDirty(false);
    store.clearRecovery();
    updateTitle();
  }
}

async function doExportHtml(): Promise<void> {
  return doExport('html');
}

async function doExportPdf(): Promise<void> {
  return doExport('pdf');
}

interface ExportPreparePayload {
  requestId: string;
  format: string;
  identity: string;
  overwrite?: boolean;
  intent?: string;
  settings: FrozenExportSnapshot;
  markdownPreferences?: Readonly<MarkdownPreferences>;
}

async function completePreparedExport(payload: ExportPreparePayload): Promise<void> {
  const markdownPreferences = freezeMarkdownPreferences(payload.markdownPreferences ?? store.prefs);
  const generation = documentGeneration;
  const markdown = getMarkdown();
  const resolved = loadExportOption(payload.settings, markdown);
  const options = resolved.options;
  const title = String(options.title ?? store.currentName.replace(/\.(md|markdown|mdown|txt)$/i, ''));
  options.title = title;
  const selectedTheme = String(options.exportTheme || store.prefs.theme) as ThemeName;
  const theme = (['github', 'gothic', 'night', 'newsprint', 'pixyll', 'whitey'] as string[]).includes(selectedTheme)
    ? selectedTheme
    : store.prefs.theme;
  const type = String(options.type ?? payload.format);
  const replicaId = replicaFormatId(type);
  const withoutStyles = type === 'html-plain';
  const fontSize = options.useThemeFontSize ? undefined : (options.imageFontSize != null ? `${options.imageFontSize}px` : undefined);
  const html = (replicaId === 'html' || replicaId === 'html-plain' || replicaId === 'pdf' || replicaId === 'png')
    ? await buildStandaloneHtml(title, extractYamlFrontMatter(markdown).body, theme, {
      withoutStyles,
      markdownPreferences,
      nativePrint: replicaId === 'pdf',
      appendHead: String(options.appendHead ?? '') + String(options.appendHeadExtra ?? ''),
      appendBody: String(options.appendBody ?? '') + String(options.appendBodyExtra ?? ''),
      sidebar: options.sidebar === true,
      splitPages: options.splitPages === true,
      fontSize: replicaId === 'png' ? fontSize : undefined,
      imageWidth: typeof options.imageWidth === 'number' ? options.imageWidth : undefined,
    })
    : '';
  if (generation !== documentGeneration) return;
  bridge.nativeExport(payload.format, html, markdown, {
    overwrite: payload.overwrite,
    requestId: payload.requestId,
    identity: payload.identity,
    intent: payload.intent ?? 'export',
    settings: { snapshot: payload.settings, resolved: options, metadata: resolved.metadata },
  });
}

async function doExport(
  format: ExportFormat | string,
  extras?: { overwrite?: boolean; requestId?: string },
): Promise<void> {
  const markdownPreferences = freezeMarkdownPreferences(store.prefs);
  if (extras?.overwrite && !isNative()) {
    notice('Overwrite export requires the native app');
    return;
  }
  if (isNative()) {
    if (extras?.requestId) return;
    bridge.postToNative({ type: 'beginExport', format, markdownPreferences });
    return;
  }
  const generation = documentGeneration;
  const markdown = getMarkdown();
  const title = store.currentName.replace(/\.(md|markdown|mdown|txt)$/i, '');
  if (format === 'pdf') { await printMarkdown(title, markdown, store.prefs.theme, markdownPreferences); return; }
  const frozen = freezeEntry(store.exportSettings, format === 'png' ? 'image' : format);
  if (!frozen) return;
  const options = loadExportOption(frozen, markdown).options;
  const selected = String(options.exportTheme || store.prefs.theme) as ThemeName;
  const html = await buildStandaloneHtml(title, extractYamlFrontMatter(markdown).body, selected, {
    markdownPreferences,
    withoutStyles: frozen.type === 'html-plain', sidebar: options.sidebar === true,
    appendHead: String(options.appendHead ?? '') + String(options.appendHeadExtra ?? ''),
    appendBody: String(options.appendBody ?? '') + String(options.appendBodyExtra ?? ''),
  });
  if (generation !== documentGeneration) return;
  if (format === 'html' || format === 'html-plain') {
    bridge.downloadText(`${title}.html`, html, 'text/html');
    notice('Exported HTML downloaded');
  } else notice('This export requires the native app');
}

function doExportLast(overwrite: boolean, payload?: unknown): void {
  if (!isNative()) return;
  const request = payload as Partial<RepeatExportRequest> | undefined;
  if (!request?.requestId) {
    if (overwrite ? repeatExportAvailability.overwrite : repeatExportAvailability.previous) bridge.nativeRepeatExport(overwrite);
    return;
  }
  if (typeof request.format !== 'string' || !isExportFormat(request.format) || typeof request.overwrite !== 'boolean') return;
  void doExport(request.format, { overwrite: request.overwrite, requestId: request.requestId }).catch(error => notice(String(error)));
}

async function doPrint(): Promise<void> {
  const markdown = getMarkdown();
  const markdownPreferences = freezeMarkdownPreferences(store.prefs);
  if (isNative()) {
    const html = await buildStandaloneHtml(store.currentName, markdown, store.prefs.theme, { nativePrint: true, markdownPreferences });
    bridge.postToNative({type: 'print', html});
  } else await printMarkdown(store.currentName, markdown, store.prefs.theme, markdownPreferences);
}

function doOpen(): void {
  if (isNative()) { bridge.nativeOpen(); return; }
  guardUnsaved(() => {
      void bridge.browserOpenFile().then((file) => {
        if (file) {
          loadDocument(file.markdown, null, file.name);
          notice('Opened locally — relative images are unavailable in browser mode');
        }
      });
  });
}

// --- command registration ----------------------------------------------------

function registerAllCommands(): void {
  const reg = registerCommand;

  // File
  reg('new', () => {
    if (isNative()) bridge.postToNative({ type: 'new' });
    else guardUnsaved(() => loadDocument('', null, 'Untitled'));
  });
  reg('open', doOpen);
  reg('openFolder', () => {
    if (!bridge.nativeOpenFolder()) notice('Open Folder requires the native app');
  });
  reg('quickOpen', () => openQuickOpen());
  reg('save', () => void doSave());
  reg('saveAs', () => {
    const md = getMarkdown();
    if (isNative()) bridge.nativeSaveAs(md);
    else void doSave();
  });
  reg('close', () => {
    if (isNative()) { bridge.postToNative({ type: 'close' }); return; }
    guardUnsaved(() => window.close());
  });
  reg('exportHtml', () => void doExportHtml());
  reg('exportPdf', () => void doExportPdf());
  reg('exportFormat', (value) => {
    if (typeof value === 'string' && (isExportFormat(value) || store.exportSettings.customExport.some(e => e.key === value))) void doExport(value).catch(error => notice(String(error)));
  });
  reg('exportLast', (value) => doExportLast(false, value));
  reg('exportLastOverwrite', (value) => doExportLast(true, value));
  reg('print', () => void doPrint());
  reg('openPath', (p) => {
    const path = String(p ?? '');
    if (!path) return;
    if (!bridge.nativeOpen(path)) notice('Opening files by path requires the native app');
  });
  reg('openRecent', (p) => runCommand('openPath', p));
  reg('clearRecent', () => store.clearRecents());

  // Edit
  reg('undo', () => { undo(view); view.focus(); });
  reg('redo', () => { redo(view); view.focus(); });
  reg('cut', () => { view.focus(); document.execCommand('cut'); });
  reg('copy', () => { view.focus(); document.execCommand('copy'); });
  reg('paste', () => void pasteFromSystem(view, false));
  reg('pastePlainText', () => {
    if (isNative()) { bridge.postToNative({type: 'pastePlainText'}); return; }
    void pasteFromSystem(view, true);
  });
  reg('selectAll', () => { selectAll(view); view.focus(); });
  reg('find', () => openFind(view, false));
  reg('replace', () => openFind(view, true));
  reg('findNext', () => findNext(view));
  reg('findPrev', () => findPrevious(view));
  reg('selectLine', () => { selectLine(view); view.focus(); });
  reg('deleteLine', () => { deleteLine(view); view.focus(); });
  reg('duplicateLine', () => fmt.duplicateLine(view));
  reg('jumpTop', () => { cursorDocStart(view); view.focus(); });
  reg('jumpBottom', () => { cursorDocEnd(view); view.focus(); });

  // Paragraph
  for (let n = 1; n <= 6; n++) reg(`heading${n}`, () => fmt.setHeading(view, n));
  reg('paragraph', () => fmt.setHeading(view, 0));
  reg('increaseHeading', () => fmt.changeHeadingLevel(view, 1));
  reg('decreaseHeading', () => fmt.changeHeadingLevel(view, -1));
  reg('table', () => openTableDialog());
  reg('codeFences', () => fmt.insertCodeFence(view));
  reg('mathBlock', () => fmt.insertMathBlock(view));
  reg('quote', () => fmt.toggleQuote(view));
  reg('orderedList', () => fmt.toggleList(view, 'ordered'));
  reg('bulletList', () => fmt.toggleList(view, 'bullet'));
  reg('taskList', () => fmt.toggleList(view, 'task'));
  reg('indent', () => fmt.indentSelection(view));
  reg('outdent', () => fmt.outdentSelection(view));
  reg('horizontalRule', () => fmt.insertHorizontalRule(view));
  reg('footnote', () => fmt.insertFootnote(view));
  registerProductCommands(view);

  // Format
  reg('bold', () => fmt.toggleBold(view));
  reg('italic', () => fmt.toggleItalic(view));
  reg('underline', () => fmt.toggleUnderline(view));
  reg('strike', () => fmt.toggleStrike(view));
  reg('inlineCode', () => fmt.toggleInlineCode(view));
  reg('highlight', () => fmt.toggleHighlight(view));
  reg('clearFormat', () => fmt.clearFormat(view));
  reg('hyperlink', () => {
    const sel = view.state.selection.main;
    openLinkDialog(view.state.sliceDoc(sel.from, sel.to));
  });
  reg('image', () => openImageDialog());

  // Dialog results
  reg('insertTable', (p) => {
    const { rows, cols, header } = (p ?? {}) as { rows?: number; cols?: number; header?: boolean };
    fmt.insertTableMd(view, Math.max(1, rows ?? 3), Math.max(1, cols ?? 3), header !== false);
  });
  reg('insertLink', (p) => {
    const { text, href, title } = (p ?? {}) as { text?: string; href?: string; title?: string };
    if (href) fmt.insertLinkMd(view, text ?? '', href, title ?? '');
  });
  reg('insertImage', (p) => {
    const { alt, src, title } = (p ?? {}) as { alt?: string; src?: string; title?: string };
    if (src) fmt.insertImageMd(view, alt ?? '', src, title ?? '');
  });

  // View
  reg('toggleSidebar', () => store.setPrefs({ sidebarVisible: !store.prefs.sidebarVisible }));
  reg('sidebarOutline', () => store.setPrefs({ sidebarVisible: true, sidebarTab: 'outline' }));
  reg('sidebarFiles', () => store.setPrefs({ sidebarVisible: true, sidebarTab: 'files', filesView: 'tree' }));
  reg('sidebarTree', () => store.setPrefs({ sidebarVisible: true, sidebarTab: 'files', filesView: 'tree' }));
  reg('sidebarListFiles', () => store.setPrefs({ sidebarVisible: true, sidebarTab: 'files', filesView: 'list' }));
  reg('toggleSource', () => store.setPrefs({ sourceMode: !store.prefs.sourceMode }));
  reg('toggleFocus', () => store.setPrefs({ focusMode: !store.prefs.focusMode }));
  reg('toggleTypewriter', () => store.setPrefs({ typewriterMode: !store.prefs.typewriterMode }));
  reg('zoomIn', () => store.setPrefs({ zoom: Math.min(400, store.prefs.zoom + 10) }));
  reg('zoomOut', () => store.setPrefs({ zoom: Math.max(25, store.prefs.zoom - 10) }));
  reg('actualSize', () => store.setPrefs({ zoom: 100 }));
  reg('fullscreen', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
  reg('minimize', () => undefined);
  reg('scrollToPos', (p) => {
    const pos = Number(p) || 0;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }),
    });
    view.focus();
  });
  reg('focusEditor', () => view.focus());
  reg('preferences', () => openPreferencesDialog('general'));
  reg('exportSettings', () => openPreferencesDialog('export'));

  // Theme
  reg('theme', (p) => {
    const t = String(p) as ThemeName;
    if (['github', 'gothic', 'night', 'newsprint', 'pixyll', 'whitey'].includes(t)) {
      store.setPrefs({ theme: t });
    }
  });

  // Help
  reg('about', () => showAboutDialog());
  reg('openSample', () => guardUnsaved(() => void loadSample()));
  reg('openExternal', (p) => bridge.openExternal(String(p ?? 'https://typora.io')));
}

// --- native bridge ------------------------------------------------------------

function exposeBridge(): void {
  window.typora = {
    command(name: string, payload?: unknown) {
      switch (name) {
        case 'exportFinished': {
          const result = (payload ?? {}) as {name?: string; warnings?: string};
          notice(`${uiText('Exported')} ${result.name ?? ''}${result.warnings ? ` — ${result.warnings}` : ''}`);
          return;
        }
        case 'exportPrepare': {
          const pl = payload as ExportPreparePayload;
          if (pl?.requestId && pl.settings) void completePreparedExport(pl).catch((error) => notice(String(error)));
          return;
        }
        case 'hydratePrefs': {
          const pl = (payload ?? {}) as { prefs?: Partial<import('./types').Prefs>; exportSettings?: unknown; runtimeFilePolicy?: Partial<typeof store.runtimeFilePolicy> };
          store.applyHydratedPrefs(pl.prefs ?? {}, pl.exportSettings, pl.runtimeFilePolicy);
          return;
        }
        case 'exportLast': {
          doExportLast(false, payload);
          return;
        }
        case 'lastExportState': {
          const pl = (payload ?? {}) as { previous?: boolean; overwrite?: boolean };
          repeatExportAvailability.previous = pl.previous === true;
          repeatExportAvailability.overwrite = pl.overwrite === true;
          return;
        }
        case 'clipboardResult': handleClipboardResult(payload as ClipboardResultPayload); return;
        case 'fileDropResult': handleFileDropResult(payload as FileDropResult); return;
        case 'load': {
          const pl = (payload ?? {}) as { markdown?: string; path?: string; name?: string; base?: string; documentId?: string };
          store.nativeDocumentId = pl.documentId ?? '';
          loadDocument(pl.markdown ?? '', pl.path || null, pl.name ?? 'Untitled', pl.base || undefined);
          return;
        }
        case 'files': {
          const pl = (payload ?? {}) as {
            root?: string;
            files?: { name: string; path: string; relativePath: string }[];
            directories?: { name: string; path: string; relativePath: string }[];
          };
          const rootChanged = (pl.root ?? null) !== store.rootPath;
          store.setFiles(pl.root ?? null, pl.files ?? [], pl.directories ?? []);
          if (rootChanged && pl.root) store.setPrefs({ sidebarVisible: true, sidebarTab: 'files' });
          return;
        }
        case 'saved': {
          const pl = (payload ?? {}) as { path?: string; name?: string; markdown?: string; documentId?: string };
          if (pl.documentId) store.nativeDocumentId = pl.documentId;
          if (pl.path) {
            store.setFile(pl.path, pl.name ?? pl.path.split('/').pop() ?? pl.path);
            store.docBase = documentBaseUrl(pl.path);
            handle.refresh();
          }
          savedMarkdown = pl.markdown ?? getMarkdown();
          const dirty = getMarkdown() !== savedMarkdown;
          store.setDirty(dirty);
          if (!dirty) store.clearRecovery();
          updateTitle();
          const cont = pendingAfterSave;
          pendingAfterSave = null;
          if (cont && !dirty) cont();
          return;
        }
        case 'requestSave':
          runCommand('save');
          return;
        case 'requestSaveAs':
          runCommand('saveAs');
          return;
        case 'export': {
          const fmt2 = String(payload ?? 'html');
          runCommand('exportFormat', fmt2);
          return;
        }
        case 'format':
          runCommand(String(payload ?? ''));
          return;
        default:
          runCommand(name, payload);
      }
    },
    getMarkdown,
    get editor() {
      return view;
    },
    /** Test hook: standalone HTML export of the current document. */
    async renderHtml(): Promise<string> {
      const preferences = freezeMarkdownPreferences(store.prefs);
      return buildStandaloneHtml(store.currentName, getMarkdown(), store.prefs.theme, { markdownPreferences: preferences });
    },
  };
}

// --- editor event wiring -------------------------------------------------------

function attachEditorListeners(): void {
  setEditorUpdateHandler((update) => {
    if (loadingDocument) return;
    if (update.docChanged) {
      const text = getMarkdown();
      store.setDirty(text !== savedMarkdown);
      updateDerived();
      bridge.notifyChange(text);
      if (autosaveTimer !== null) { window.clearTimeout(autosaveTimer); autosaveTimer = null; }
      if (!isNative()) {
        if (!store.dirty) store.clearRecovery();
        else autosaveTimer = window.setTimeout(() => {
          autosaveTimer = null;
          store.saveRecovery(getMarkdown(), store.currentName, store.currentPath);
        }, 500);
      } else if (store.prefs.autoSave && store.currentPath && store.dirty) {
        autosaveTimer = window.setTimeout(() => {
          autosaveTimer = null;
          bridge.nativeSave(getMarkdown(), store.currentPath);
        }, store.prefs.autoSaveDelayMs);
      }
    } else if (update.selectionSet) {
      updateDerived();
    }
    if (store.prefs.typewriterMode && store.prefs.typewriterAlwaysCenter && (update.docChanged || update.selectionSet)) {
      const head = update.state.selection.main.head;
      requestAnimationFrame(() => {
        view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
      });
    }
  });
}

// --- boot ----------------------------------------------------------------------

async function boot(): Promise<void> {
  document.body.classList.toggle('native-app', isNative());
  const initial = '';
  handle = createEditor(document.getElementById('editor')!, initial);
  view = handle.view;

  registerAllCommands();
  exposeBridge();
  initMenubar();
  initSidebar();
  initStatusbar();
  attachEditorListeners();
  window.addEventListener(CLIPBOARD_ERROR_EVENT, (event) => {
    const error = (event as CustomEvent<{error?: string}>).detail?.error;
    if (error && error !== 'cancelled') notice(error);
  });
  window.addEventListener(FILE_DROP_ERROR_EVENT, (event) => notice(String((event as CustomEvent<string>).detail)));

  store.on('prefs', applyPrefs);
  store.on('file', updateTitle);
  store.on('dirty', updateTitle);

  applyPrefs();
  updateDerived(true);
  updateTitle();

  if (isNative()) {
    bridge.notifyReady();
  } else {
    // browser fallback: restore previous session, else show the sample document
    const recovery = store.loadRecovery();
    if (recovery && recovery.markdown.trim() !== '') {
      loadDocument(recovery.markdown, recovery.path, recovery.name);
      store.docBase = '';
      store.setDirty(true);
      notice('Recovered unsaved changes from your last session');
    } else {
      await loadSample();
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

if (location.hash.startsWith('#preferences')) {
  const root = document.getElementById('app');
  if (root) {
    root.replaceChildren();
    root.id = 'preferences-root';
    window.typora = {
      command(name, payload) {
        if (name === 'imageUploaderTestResult') {
          receiveImageUploaderTestResult((payload ?? {}) as Parameters<typeof receiveImageUploaderTestResult>[0]);
          return;
        }
        if (name === 'hydratePrefs') {
          const data = (payload ?? {}) as { prefs?: Partial<import('./types').Prefs>; exportSettings?: unknown; runtimeFilePolicy?: Partial<typeof store.runtimeFilePolicy> };
          store.applyHydratedPrefs(data.prefs ?? {}, data.exportSettings, data.runtimeFilePolicy);
        }
      },
      getMarkdown: () => '', editor: null,
    };
    mountPreferences(root);
    document.getElementById('overlays')?.remove();
    if (isNative()) bridge.notifyReady();
  }
} else {
  void boot();
}
