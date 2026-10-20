// Central application state with tiny pub/sub. Persisted to localStorage.

import { DEFAULT_PREFS, DocStats, FileEntry, HeadingItem, Prefs, RecentEntry, normalizeEditorPreferences } from './types';
import { defaultExportSettings, normalizeExportSettings, type ExportSettingsState } from './export-settings';
import { isNative, postToNative } from './bridge';
import { normalizeFilePreferences } from './file-preferences';
import { normalizeImagePreferences } from './image-preferences';
import { normalizeMarkdownPreferences } from './markdown-preferences';

type Listener = () => void;

const LS_PREFS = 'typora-replica:prefs';
const LS_RECENTS = 'typora-replica:recents';
const LS_RECOVERY = 'typora-replica:recovery';

class Store {
  // Current document identity
  currentPath: string | null = null;
  currentName = 'Untitled';
  nativeDocumentId = '';
  runtimeFilePolicy = { saveOnFileSwitchForced: false, systemAlwaysConfirmsChanges: true };
  /** Base used to resolve relative image paths ('samples/' in browser, dir of file in native). */
  docBase = '';
  dirty = false;

  // Folder state (native supplies via `files` command)
  rootPath: string | null = null;
  files: FileEntry[] = [];
  directories: FileEntry[] = [];

  // Derived document data (updated by editor core)
  outline: HeadingItem[] = [];
  activeHeadingPos = -1;
  stats: DocStats = { words: 0, chars: 0, paragraphs: 0, selWords: 0, selChars: 0 };

  prefs: Prefs = { ...DEFAULT_PREFS };
  recents: RecentEntry[] = [];
  exportSettings: ExportSettingsState = defaultExportSettings();
  hydrating = false;

  private listeners = new Map<string, Set<Listener>>();

  constructor() {
    this.loadPrefs();
    this.loadRecents();
  }

  on(event: string, fn: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(event: string): void {
    const set = this.listeners.get(event);
    if (set) for (const fn of [...set]) fn();
  }

  // ---- document ----

  setFile(path: string | null, name: string): void {
    this.currentPath = path;
    this.currentName = name;
    if (path) this.addRecent(path, name);
    this.emit('file');
  }

  setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    this.emit('dirty');
    this.emit('file');
  }

  setFiles(root: string | null, files: FileEntry[], directories: FileEntry[] = []): void {
    this.rootPath = root;
    this.files = files;
    this.directories = directories;
    this.emit('files');
  }

  setOutline(outline: HeadingItem[]): void {
    this.outline = outline;
    this.emit('outline');
  }

  setActiveHeadingPos(pos: number): void {
    if (this.activeHeadingPos === pos) return;
    this.activeHeadingPos = pos;
    this.emit('cursor');
  }

  setStats(stats: DocStats): void {
    this.stats = stats;
    this.emit('stats');
  }

  // ---- prefs ----

  setPrefs(patch: Partial<Prefs>): void {
    Object.assign(this.prefs, patch);
    this.normalizePrefs();
    this.savePrefs();
    this.emit('prefs');
    if (!this.hydrating && isNative()) postToNative({ type: 'prefsChanged', prefs: { ...this.prefs } });
  }

  applyHydratedPrefs(prefs: Partial<Prefs>, exportSettings?: unknown, runtimeFilePolicy?: Partial<typeof this.runtimeFilePolicy>): void {
    this.hydrating = true;
    try {
      if (runtimeFilePolicy) Object.assign(this.runtimeFilePolicy, runtimeFilePolicy);
      if (prefs) {
        Object.assign(this.prefs, prefs);
        this.normalizePrefs();
        this.emit('prefs');
      }
      if (exportSettings !== undefined) {
        this.exportSettings = normalizeExportSettings(exportSettings);
        this.emit('exportSettings');
      }
    } finally {
      this.hydrating = false;
    }
  }

  setExportSettings(next: ExportSettingsState): void {
    this.exportSettings = next;
    this.emit('exportSettings');
    if (!this.hydrating) {
      if (isNative()) postToNative({ type: 'exportSettingsChanged', settings: next });
      else {
        try { localStorage.setItem('typora-replica:export-settings', JSON.stringify(next)); } catch { /* ignore */ }
      }
    }
  }

  private normalizePrefs(): void {
    if (typeof this.prefs.quitAfterWindowClose !== 'boolean') this.prefs.quitAfterWindowClose = false;
    if (typeof this.prefs.enableDebug !== 'boolean') this.prefs.enableDebug = false;
    Object.assign(this.prefs, normalizeEditorPreferences(this.prefs));
    Object.assign(this.prefs, normalizeFilePreferences(this.prefs), normalizeImagePreferences(this.prefs));
    Object.assign(this.prefs, normalizeMarkdownPreferences(this.prefs));
    if (this.prefs.filesView !== 'list' && this.prefs.filesView !== 'tree') {
      this.prefs.filesView = 'tree';
    }
  }

  private loadPrefs(): void {
    try {
      const raw = localStorage.getItem(LS_PREFS);
      if (raw) Object.assign(this.prefs, JSON.parse(raw));
    } catch {
      /* ignore */
    }
    this.normalizePrefs();
    try {
      const exportRaw = localStorage.getItem('typora-replica:export-settings');
      if (exportRaw) this.exportSettings = normalizeExportSettings(JSON.parse(exportRaw));
    } catch {
      /* ignore */
    }
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify(this.prefs));
    } catch {
      /* ignore */
    }
  }

  // ---- recents ----

  addRecent(path: string, name: string): void {
    if (!this.prefs.recordRecentFiles) return;
    this.recents = [
      { path, name, openedAt: Date.now() },
      ...this.recents.filter((r) => r.path !== path),
    ].slice(0, 20);
    try {
      localStorage.setItem(LS_RECENTS, JSON.stringify(this.recents));
    } catch {
      /* ignore */
    }
    this.emit('recents');
  }

  clearRecents(): void {
    this.recents = [];
    try {
      localStorage.removeItem(LS_RECENTS);
    } catch {
      /* ignore */
    }
    this.emit('recents');
  }

  private loadRecents(): void {
    try {
      const raw = localStorage.getItem(LS_RECENTS);
      if (raw) this.recents = JSON.parse(raw);
    } catch {
      /* ignore */
    }
  }

  // ---- browser fallback recovery ----

  saveRecovery(markdown: string, name: string, path: string | null): void {
    try {
      localStorage.setItem(
        LS_RECOVERY,
        JSON.stringify({ markdown, name, path, savedAt: Date.now() }),
      );
    } catch {
      /* quota */
    }
  }

  loadRecovery(): { markdown: string; name: string; path: string | null; savedAt: number } | null {
    try {
      const raw = localStorage.getItem(LS_RECOVERY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  clearRecovery(): void {
    try {
      localStorage.removeItem(LS_RECOVERY);
    } catch {
      /* ignore */
    }
  }
}

export const store = new Store();
