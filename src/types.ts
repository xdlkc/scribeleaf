// Shared types and global window declarations for the Scribeleaf renderer.
import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from './file-preferences';
import { DEFAULT_IMAGE_PREFERENCES, type ImagePreferences } from './image-preferences';
import { DEFAULT_MARKDOWN_PREFERENCES, type MarkdownPreferences } from './markdown-preferences';
export interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
}

export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

export interface HeadingItem {
  level: number; // 1..6
  text: string;
  pos: number; // document offset of the heading line start
}

export interface DocStats {
  words: number;
  chars: number;
  paragraphs: number;
  selWords: number;
  selChars: number;
}

export type ThemeName = 'github' | 'gothic' | 'night' | 'newsprint' | 'pixyll' | 'whitey';

export interface EditorPreferences {
  /** 0 detects the document's list indentation; -1 uses a tab. */
  indentSize: -1 | 0 | 2 | 3 | 4 | 5;
  prettyIndent: boolean;
  autoPairBrackets: boolean;
  autoPairMarkdown: boolean;
  emojiAutoComplete: boolean;
  expandSimpleBlocks: boolean;
  copyMarkdownAsPlainText: boolean;
  lineWiseCopyCut: boolean;
  typewriterAlwaysCenter: boolean;
}

/** Renderer baseline, not a claim about Typora's native factory defaults. */
export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  indentSize: 2,
  prettyIndent: false,
  autoPairBrackets: true,
  autoPairMarkdown: false,
  emojiAutoComplete: true,
  expandSimpleBlocks: false,
  copyMarkdownAsPlainText: false,
  lineWiseCopyCut: false,
  typewriterAlwaysCenter: false,
};

export function normalizeEditorPreferences(value: Partial<EditorPreferences>): EditorPreferences {
  const result = { ...DEFAULT_EDITOR_PREFERENCES };
  if ([-1, 0, 2, 3, 4, 5].includes(value.indentSize as number)) result.indentSize = value.indentSize!;
  for (const key of Object.keys(result) as (keyof EditorPreferences)[]) {
    if (key !== 'indentSize' && typeof value[key] === 'boolean') result[key] = value[key] as boolean;
  }
  return result;
}

export interface Prefs extends EditorPreferences, FilePreferences, ImagePreferences, MarkdownPreferences {
  quitAfterWindowClose: boolean;
  enableDebug: boolean;
  theme: ThemeName;
  autoSave: boolean;
  autoSaveDelayMs: number;
  typewriterMode: boolean;
  focusMode: boolean;
  sourceMode: boolean;
  sidebarVisible: boolean;
  sidebarTab: 'files' | 'outline';
  filesView: 'list' | 'tree';
  sidebarWidth: number;
  zoom: number; // percentage, 100 = actual size
  wordCountUnit: 'words' | 'characters' | 'paragraphs';
  spellcheck: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  ...DEFAULT_EDITOR_PREFERENCES,
  ...DEFAULT_FILE_PREFERENCES,
  ...DEFAULT_IMAGE_PREFERENCES,
  ...DEFAULT_MARKDOWN_PREFERENCES,
  quitAfterWindowClose: false,
  enableDebug: false,
  theme: 'github',
  autoSave: false,
  autoSaveDelayMs: 3000,
  typewriterMode: false,
  focusMode: false,
  sourceMode: false,
  sidebarVisible: false,
  sidebarTab: 'outline',
  filesView: 'tree',
  sidebarWidth: 260,
  zoom: 100,
  wordCountUnit: 'words',
  spellcheck: true,
};

/** Messages renderer -> native shell. */
export type NativeMessage =
  | { type: 'ready' }
  | { type: 'new' }
  | { type: 'close' }
  | { type: 'pastePlainText' }
  | { type: 'clipboardImage'; requestId: string; data?: string; mime?: string; name?: string; path?: string; remoteURL?: string; imagePolicy?: { copyImagesTo?: string; copyImagesInvalid?: boolean }; usePasteboard?: boolean; lookupFileURLs?: boolean; source?: 'paste' | 'drop' }
  | { type: 'clipboardCancel'; requestIds: string[] }
  | { type: 'fileDrop'; requestId: string; documentId: string; rendererDocumentId: string; documentPath: string; paths: string[]; useDraggingPasteboard: boolean }
  | { type: 'open'; path?: string }
  | { type: 'openFolder' }
  | { type: 'save'; markdown: string; path?: string }
  | { type: 'saveAs'; markdown: string }
  | { type: 'change'; markdown: string }
  | { type: 'repeatExport'; overwrite: boolean }
  | { type: 'beginExport'; format: string; markdownPreferences?: Readonly<MarkdownPreferences> }
  | { type: 'export'; format: string; html: string; markdown: string; overwrite?: boolean; requestId?: string; identity?: string; intent?: string; settings?: unknown }
  | { type: 'print'; html: string }
  | { type: 'openExternal'; url: string }
  | { type: 'title'; title: string }
  | { type: 'prefsChanged'; prefs: Prefs }
  | { type: 'exportSettingsChanged'; settings: unknown }
  | { type: 'chooseExportFolder' }
  | { type: 'choosePandoc' }
  | { type: 'chooseExportFile'; key: string; field: string }
  | { type: 'choosePreferenceFolder'; field: 'pinFolder' | 'customImageFolder'; selectLaunchFolder?: boolean }
  | { type: 'imageUploaderTest'; requestId: string }
  | { type: 'imageUploaderTestCancel'; requestId: string }
  | { type: 'clearRecent' }
  | { type: 'openPreferences'; tab?: string };

/** Commands native shell -> renderer via window.typora.command(name, payload). */
export interface TyporaBridge {
  command(name: string, payload?: unknown): void;
  getMarkdown(): string;
  editor: unknown;
  /** Test hook: standalone HTML export of the current document. */
  renderHtml?(): Promise<string>;
}

declare global {
  interface Window {
    typora?: TyporaBridge;
    webkit?: {
      messageHandlers?: {
        native?: { postMessage(msg: NativeMessage): void };
      };
    };
  }
}
