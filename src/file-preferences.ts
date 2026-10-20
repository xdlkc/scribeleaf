/** Files settings shared by Preferences, the sidebar and the native bridge.
 * Values below are independent implementation fallbacks. Renderer baselines do
 * not prove the installed macOS application's factory defaults. */
export type FileFilterMode = 'supported' | 'custom' | 'all';
export type FileBrowserView = 'tree' | 'library';

export interface FilePreferences {
  /** Final extension, including custom values. An empty value means md. */
  defaultExtension: string;
  restoreWhenLaunch: 0 | 1 | 2 | 3;
  pinFolder: string;
  collapsibleOutline: boolean;
  saveOnFileSwitch: boolean;
  recordRecentFiles: boolean;
  folderDropAction: 'open' | 'link';
  markdownDropAction: 'open' | 'link';
  importDropAction: 'import' | 'link';
  showHiddenFiles: boolean;
  treeFileFilterMode: FileFilterMode;
  libraryFileFilterMode: Exclude<FileFilterMode, 'all'>;
  treeFileFilterPatterns: string[];
  libraryFileFilterPatterns: string[];
}

export const DEFAULT_FILE_PREFERENCES: FilePreferences = {
  defaultExtension: 'md', restoreWhenLaunch: 0, pinFolder: '',
  collapsibleOutline: false, saveOnFileSwitch: false, recordRecentFiles: true,
  folderDropAction: 'open', markdownDropAction: 'open', importDropAction: 'import',
  showHiddenFiles: false, treeFileFilterMode: 'supported', libraryFileFilterMode: 'supported',
  treeFileFilterPatterns: [], libraryFileFilterPatterns: [],
};

export function normalizeDefaultExtension(value: string): string {
  return /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*/.exec(value.trim().toLowerCase())?.[0].replace(/^\./, '') ?? '';
}

export function normalizeFilePreferences(value: Partial<FilePreferences>): FilePreferences {
  const out: FilePreferences = { ...DEFAULT_FILE_PREFERENCES, treeFileFilterPatterns: [], libraryFileFilterPatterns: [] };
  if (typeof value.defaultExtension === 'string') out.defaultExtension = normalizeDefaultExtension(value.defaultExtension);
  if ([0, 1, 2, 3].includes(value.restoreWhenLaunch as number)) out.restoreWhenLaunch = value.restoreWhenLaunch!;
  if (typeof value.pinFolder === 'string') out.pinFolder = value.pinFolder;
  for (const key of ['collapsibleOutline', 'saveOnFileSwitch', 'recordRecentFiles', 'showHiddenFiles'] as const) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  for (const key of ['folderDropAction', 'markdownDropAction'] as const) {
    if (value[key] === 'open' || value[key] === 'link') out[key] = value[key];
  }
  if (value.importDropAction === 'import' || value.importDropAction === 'link') out.importDropAction = value.importDropAction;
  if (['supported', 'custom', 'all'].includes(value.treeFileFilterMode ?? '')) out.treeFileFilterMode = value.treeFileFilterMode!;
  if (['supported', 'custom'].includes(value.libraryFileFilterMode ?? '')) out.libraryFileFilterMode = value.libraryFileFilterMode!;
  for (const key of ['treeFileFilterPatterns', 'libraryFileFilterPatterns'] as const) {
    if (Array.isArray(value[key])) out[key] = value[key].filter((pattern): pattern is string => typeof pattern === 'string');
  }
  return out;
}

export const SUPPORTED_TEXT_EXTENSIONS = [
  'md', 'markdown', 'mmd', 'mkd', 'mdwn', 'mdown', 'mdx', 'mdtxt', 'mdtext', 'apib',
  'rmarkdown', 'rmd', 'qmd', 'txt', 'text',
] as const;

export function isSupportedFile(name: string, prefs: Pick<FilePreferences, 'defaultExtension'>): boolean {
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? '';
  return !extension || (SUPPORTED_TEXT_EXTENSIONS as readonly string[]).includes(extension) || extension === (prefs.defaultExtension || 'md');
}

/** Typora's documented glob subset: *, **, ?, character classes. Patterns with
 * a slash match the root-relative path; others match the basename. Exclusions
 * win regardless of order. Supported files remain included until excluded. */
const globCache = new Map<string, RegExp | null>();
export function fileGlobRegExp(pattern: string): RegExp | null {
  if (globCache.has(pattern)) return globCache.get(pattern)!;
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') { index++; expression += '(?:.*/)?'; }
        else expression += '.*';
      } else expression += '[^/]*';
    } else if (char === '?') expression += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) return null;
      let cursor = index + 1;
      let group = '';
      if (pattern[cursor] === '!' || pattern[cursor] === '^') { group = '^'; cursor++; }
      for (; cursor < end; cursor++) {
        if (pattern[cursor] === '\\') { group += '\\' + (pattern[++cursor] ?? ''); }
        else group += pattern[cursor].replace(/[.^$+(){}=|]/g, '\\$&');
      }
      expression += '[' + group + ']';
      index = end;
    } else expression += char.replace(/[.^$+(){}=!|\\]/g, '\\$&');
  }
  let result: RegExp | null;
  try { result = new RegExp('^' + expression + '$'); } catch { result = null; }
  if (globCache.size >= 256) globCache.delete(globCache.keys().next().value!);
  globCache.set(pattern, result);
  return result;
}

export function matchesFilePatterns(name: string, relativePath: string, patterns: readonly string[], supported: boolean): boolean {
  let included = supported;
  let excluded = false;
  const path = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const raw of patterns) {
    let pattern = raw.trim();
    const exclude = pattern.startsWith('!');
    if (exclude) pattern = pattern.slice(1).trim();
    if (!pattern) continue;
    const match = fileGlobRegExp(pattern)?.test(pattern.includes('/') ? path : name) ?? false;
    if (match) { if (exclude) excluded = true; else included = true; }
  }
  return included && !excluded;
}

export function filePathVisible(relativePath: string, prefs: FilePreferences, view: FileBrowserView, directory = true): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!prefs.showHiddenFiles && parts.some(part => part.startsWith('.'))) return false;
  const mode = view === 'tree' ? prefs.treeFileFilterMode : prefs.libraryFileFilterMode;
  return (view === 'tree' && mode === 'all') || !(directory ? parts : parts.slice(0, -1)).includes('node_modules');
}

export function fileAllowed(name: string, relativePath: string, prefs: FilePreferences, view: FileBrowserView): boolean {
  if (!filePathVisible(relativePath, prefs, view, false)) return false;
  const mode = view === 'tree' ? prefs.treeFileFilterMode : prefs.libraryFileFilterMode;
  if (mode === 'all') return true;
  const supported = isSupportedFile(name, prefs);
  return mode === 'custom'
    ? matchesFilePatterns(name, relativePath, view === 'tree' ? prefs.treeFileFilterPatterns : prefs.libraryFileFilterPatterns, supported)
    : supported;
}
