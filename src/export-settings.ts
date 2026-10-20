// Independent export-preferences model. Field names follow the audited Typora
// store (export.general, export.pdf, customExport). Replica format ids use
// png/mediawiki where the original used image/wiki.

import { parse as parseYaml } from 'yaml';

export const EXPORT_SETTINGS_VERSION = 1;

export const FIXED_EXPORT_TABS = ['general', 'pdf', 'html', 'html-plain', 'image'] as const;

export const DEFAULT_CONVERTERS: readonly { name: string; type: string; key: string }[] = [
  { name: 'Word (.docx)', type: 'docx', key: 'docx' },
  { name: 'OpenOffice', type: 'odt', key: 'odt' },
  { name: 'RTF', type: 'rtf', key: 'rtf' },
  { name: 'Epub', type: 'epub', key: 'epub' },
  { name: 'LaTeX', type: 'latex', key: 'latex' },
  { name: 'Media Wiki', type: 'wiki', key: 'wiki' },
  { name: 'reStructuredText', type: 'rst', key: 'rst' },
  { name: 'Textile', type: 'textile', key: 'textile' },
  { name: 'OPML', type: 'opml', key: 'opml' },
];

export const ADD_TEMPLATES: readonly { name: string; type: string }[] = [
  { name: 'PDF (Typora / Webkit)', type: 'pdf' },
  { name: 'PDF (LaTeX / Pandoc)', type: 'latex-pdf' },
  { name: 'HTML', type: 'html' },
  { name: 'HTML (without Styles)', type: 'html-plain' },
  { name: 'Image', type: 'image' },
  { name: 'Word (.docx)', type: 'docx' },
  { name: 'OpenOffice', type: 'odt' },
  { name: 'RTF', type: 'rtf' },
  { name: 'Epub', type: 'epub' },
  { name: 'LaTeX', type: 'latex' },
  { name: 'Media Wiki', type: 'wiki' },
  { name: 'reStructuredText', type: 'rst' },
  { name: 'Textile', type: 'textile' },
  { name: 'OPML', type: 'opml' },
  { name: 'Markdown (Other Spec)', type: 'markdown' },
  { name: 'Pandoc', type: 'pandoc' },
  { name: 'Custom', type: 'custom' },
];

const BASE_YAML_KEYS = ['title', 'author', 'subject', 'creator', 'split-level', 'toc-depth'] as const;
const EXTRA_YAML_KEYS = [
  'header', 'footer', 'sidebar', 'append-head', 'append-head-extra', 'append-body', 'append-body-extra',
] as const;

export type ExportFolderMode = '' | 'same' | 'custom';

export interface ExportGeneral {
  exportFolder: ExportFolderMode;
  customExportPath: string;
  openExportLocation: boolean;
}

export interface CustomExportEntry {
  key: string;
  name: string;
  type: string;
  [field: string]: unknown;
}

export interface ExportSettingsState {
  version: number;
  pandocPath: string;
  general: ExportGeneral;
  formats: Record<string, Record<string, unknown>>;
  customExport: CustomExportEntry[];
}

export function schemaDefaults(type: string): Record<string, unknown> {
  switch (canonicalType(type)) {
    case 'html':
      return { sidebar: false, exportTheme: '', appendHead: '', appendBody: '', allowPerFileSetting: false };
    case 'html-plain':
      return { appendHead: '', appendBody: '', allowPerFileSetting: false };
    case 'pdf':
      return {
        paper: '',
        'paper.custom': [210, 297],
        'paper.margin': '',
        'paper.marginTop': 16,
        'paper.marginBottom': 16,
        'paper.marginLeft': 16,
        'paper.marginRight': 16,
        exportTheme: '',
        splitPages: false,
        header: '',
        footer: '',
        author: '',
        appendBody: '',
        allowPerFileSetting: false,
      };
    case 'image':
    case 'png':
      return { imageWidth: 640, quality: 0, useThemeFontSize: 0, imageFontSize: 24, exportTheme: '' };
    case 'docx':
      return { extraArguments: '', 'reference-doc': '' };
    case 'odt':
      return { extraArguments: '', template: '' };
    case 'epub':
      return { extraArguments: '', css: '', 'toc-depth': 3 };
    case 'latex-pdf':
      return { extraArguments: '', 'pdf-engine': '', template: '', author: '' };
    case 'markdown':
      return {
        variants: 'markdown',
        hardLineWrap: false,
        columns: 130,
        eol: '',
        tab: '',
        ascii: false,
        'reference-links': false,
        'reference-location': '',
        'markdown-headings': '',
        webtex: false,
        'webtex-format': 'png',
        extraArguments: '',
      };
    case 'pandoc':
      return { targetFormat: '', extensions: '', extraArguments: '', raw: '' };
    case 'custom':
      return { command: '', saveDialog: '', extensions: '', showOutput: false };
    default:
      return { extraArguments: '' };
  }
}

export function canonicalType(type: string): string {
  if (type === 'png') return 'image';
  if (type === 'mediawiki') return 'wiki';
  return type;
}

export function replicaFormatId(type: string): string {
  if (type === 'image') return 'png';
  if (type === 'wiki') return 'mediawiki';
  return type;
}

export function defaultCustomExport(): CustomExportEntry[] {
  return DEFAULT_CONVERTERS.map((item) => ({ ...item }));
}

export function defaultExportSettings(): ExportSettingsState {
  return {
    version: EXPORT_SETTINGS_VERSION,
    pandocPath: '',
    general: { exportFolder: '', customExportPath: '', openExportLocation: false },
    formats: {},
    customExport: defaultCustomExport(),
  };
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const RESERVED_EXPORT_KEYS = new Set<string>([...FIXED_EXPORT_TABS, 'png', 'mediawiki']);

export function isReservedExportKey(key: string): boolean {
  return RESERVED_EXPORT_KEYS.has(key);
}

export function normalizeExportSettings(raw: unknown): ExportSettingsState {
  const base = defaultExportSettings();
  if (!raw || typeof raw !== 'object') return base;
  const src = raw as Record<string, unknown>;
  if (typeof src.pandocPath === 'string') base.pandocPath = src.pandocPath;
  const general = src.general as Record<string, unknown> | undefined;
  if (general) {
    const folder = general.exportFolder;
    if (folder === '' || folder === 'same' || folder === 'custom') base.general.exportFolder = folder;
    if (typeof general.customExportPath === 'string') base.general.customExportPath = general.customExportPath;
    if (typeof general.openExportLocation === 'boolean') base.general.openExportLocation = general.openExportLocation;
  }
  if (src.formats && typeof src.formats === 'object') {
    for (const [key, value] of Object.entries(src.formats as Record<string, unknown>)) {
      if (value && typeof value === 'object') base.formats[key] = deepClone(value as Record<string, unknown>);
    }
  }
  if (Array.isArray(src.customExport)) {
    const used: CustomExportEntry[] = [];
    for (const item of src.customExport as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const type = String(rec.type ?? '');
      const name = String(rec.name ?? rec.key ?? '');
      if (!type) continue;
      const requested = String(rec.key ?? '');
      const key = requested && !isReservedExportKey(requested) && !used.some((e) => e.key === requested)
        ? requested
        : uniqueCustomKey(type, used);
      const rest = { ...rec };
      delete rest.key; delete rest.name; delete rest.type;
      used.push({ key, name: name || key, type: canonicalType(type), ...rest } as CustomExportEntry);
    }
    base.customExport = used;
  }
  return base;
}

export function uniqueCustomKey(type: string, existing: CustomExportEntry[]): string {
  const canon = canonicalType(type);
  const taken = new Set(existing.map((e) => e.key));
  for (const reserved of RESERVED_EXPORT_KEYS) taken.add(reserved);
  let n = taken.has(canon) ? 1 : 0;
  let key = canon + (n || '');
  while (taken.has(key)) {
    n += 1;
    key = canon + n;
  }
  return key;
}

export function addCustomExport(state: ExportSettingsState, type: string, name: string): ExportSettingsState {
  const next = deepClone(state);
  const key = uniqueCustomKey(type, next.customExport);
  const suffix = key === canonicalType(type) ? '' : '-' + key.slice(canonicalType(type).length);
  next.customExport.push({ key, name: name + suffix, type: canonicalType(type) });
  return next;
}

export function renameCustomExport(state: ExportSettingsState, key: string, name: string): ExportSettingsState {
  const next = deepClone(state);
  const entry = next.customExport.find((e) => e.key === key);
  if (entry) entry.name = name;
  return next;
}

export function deleteCustomExport(state: ExportSettingsState, key: string): ExportSettingsState {
  const next = deepClone(state);
  next.customExport = next.customExport.filter((e) => e.key !== key);
  delete next.formats[key];
  return next;
}

export function moveCustomExport(state: ExportSettingsState, key: string, delta: number): ExportSettingsState {
  const next = deepClone(state);
  const index = next.customExport.findIndex((e) => e.key === key);
  const dest = index + delta;
  if (index < 0 || dest < 0 || dest >= next.customExport.length) return next;
  const [item] = next.customExport.splice(index, 1);
  next.customExport.splice(dest, 0, item);
  return next;
}

export function formatOptions(state: ExportSettingsState, key: string): Record<string, unknown> {
  const type = lookupType(state, key);
  const extra = { ...(state.customExport.find(entry => entry.key === key) ?? {}) } as Record<string, unknown>;
  delete extra.key; delete extra.name; delete extra.type;
  return deepClone({ ...schemaDefaults(type), ...extra, ...(state.formats[key] ?? {}) });
}

export function lookupType(state: ExportSettingsState, key: string): string {
  if (FIXED_EXPORT_TABS.includes(key as typeof FIXED_EXPORT_TABS[number])) return key;
  return state.customExport.find((e) => e.key === key)?.type ?? key;
}

export function patchFormat(state: ExportSettingsState, key: string, field: string, value: unknown): ExportSettingsState {
  const next = deepClone(state);
  next.formats[key] = { ...(next.formats[key] ?? {}), [field]: value };
  return next;
}

export function patchGeneral(state: ExportSettingsState, field: keyof ExportGeneral | 'pandocPath', value: unknown): ExportSettingsState {
  const next = deepClone(state);
  if (field === 'pandocPath') next.pandocPath = String(value ?? '');
  else (next.general as unknown as Record<string, unknown>)[field] = value;
  return next;
}

export interface FrozenExportSnapshot {
  key: string;
  type: string;
  name: string;
  general: ExportGeneral;
  pandocPath: string;
  options: Record<string, unknown>;
}

export function freezeEntry(state: ExportSettingsState, key: string): FrozenExportSnapshot | null {
  const type = lookupType(state, key);
  if (key === 'general') return null;
  const custom = state.customExport.find((e) => e.key === key);
  const name = custom?.name ?? key;
  return {
    key,
    type,
    name,
    general: deepClone(state.general),
    pandocPath: state.pandocPath,
    options: formatOptions(state, key),
  };
}

export function camelize(key: string): string {
  return key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export function capitalize(key: string): string {
  return key.length ? key[0].toUpperCase() + key.slice(1) : key;
}

export function extractYamlFrontMatter(markdown: string): { yaml: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!match) return { yaml: {}, body: markdown };
  try {
    const parsed = parseYaml(match[1], { schema: 'core', maxAliasCount: 50, prettyErrors: false });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { yaml: parsed as Record<string, unknown>, body: markdown.slice(match[0].length) };
    }
  } catch {
    /* invalid YAML is ignored */
  }
  return { yaml: {}, body: markdown };
}

function lookupMeta(map: Record<string, unknown> | undefined, key: string): unknown {
  return map?.[key] || map?.[key.toLowerCase()];
}

/** Literal audited lookup: project → file → exact global option key. */
export function getSetting(
  key: string,
  fileSetting: Record<string, unknown>,
  projectSetting: Record<string, unknown> | undefined,
  fileOption: Record<string, unknown>,
): unknown {
  const project = lookupMeta(projectSetting, key);
  const value = project !== undefined && project !== 'unset' ? project : lookupMeta(fileSetting, key);
  return value === 'unset' || value === undefined ? fileOption[key] : value;
}

export interface YamlResolveReport {
  options: Record<string, unknown>;
  metadata: Record<string, unknown>;
  projectInjectionUnknown: boolean;
}

export function loadExportOption(
  snapshot: FrozenExportSnapshot,
  markdown: string,
  projectSetting?: Record<string, unknown>,
): YamlResolveReport {
  const { yaml } = extractYamlFrontMatter(markdown);
  const allow = snapshot.options.allowPerFileSetting === true;
  const keys: string[] = [...BASE_YAML_KEYS];
  if (allow) keys.push(...EXTRA_YAML_KEYS);
  const overlay: Record<string, unknown> = {};
  for (const key of keys) {
    const value =
      getSetting('typora-' + key, yaml, projectSetting, snapshot.options) ||
      getSetting(key, yaml, projectSetting, snapshot.options) ||
      getSetting(capitalize(key), yaml, projectSetting, snapshot.options);
    if (value !== undefined) overlay[camelize(key)] = value;
  }
  if (overlay.sidebar === 'true') overlay.sidebar = true;
  if (overlay.sidebar === 'false') overlay.sidebar = false;
  const type = canonicalType(snapshot.type);
  if (type === 'pdf' || type === 'epub') {
    if (overlay.appendHead) overlay.userAppendHead = true;
    if (overlay.appendBody) overlay.userAppendBody = true;
    delete overlay.appendHead;
    delete overlay.appendBody;
    delete overlay.appendHeadExtra;
    delete overlay.appendBodyExtra;
  }
  const merged: Record<string, unknown> = { ...deepClone(snapshot.options), ...overlay, type: snapshot.type, key: snapshot.key };
  for (const k of Object.keys(merged)) {
    if (merged[k] === 'unset') merged[k] = '';
  }
  return {
    options: merged,
    metadata: yaml,
    projectInjectionUnknown: projectSetting === undefined,
  };
}

export const UNSAFE_PANDOC_FLAGS = new Set([
  '-o', '--output', '--output-file', '--extract-media', '--log', '--defaults', '-d',
]);

export class ArgvSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvSyntaxError';
  }
}

export class PandocExtraRejectedError extends Error {
  rejected: string[];
  constructor(rejected: string[]) {
    super('Pandoc extra arguments cannot override the export source or destination: ' + rejected.join(' '));
    this.name = 'PandocExtraRejectedError';
    this.rejected = rejected;
  }
}

export function splitArgv(input: string): string[] {
  if (input.includes('\0')) throw new ArgvSyntaxError('NUL byte in extra arguments');
  const out: string[] = [];
  let current = '', started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    started ||= !/\s/.test(ch);
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        const next = input[i + 1];
        if (['"', '\\', '$', '`'].includes(next)) { current += next; i++; }
        else if (next === '\n') i++;
        else current += ch;
      } else if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '\\' && i + 1 < input.length) {
      if (input[i + 1] !== '\n') current += input[i + 1];
      i++;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (started) { out.push(current); current = ''; started = false; }
    } else current += ch;
  }
  if (quote) throw new ArgvSyntaxError('Unterminated quote in extra arguments');
  if (started) out.push(current);
  return out;
}

function flagName(token: string): string {
  if (token === '--') return token;
  if (token.startsWith('--')) return token.split('=')[0];
  if (/^-[A-Za-z]/.test(token)) return token.slice(0, 2);
  return token.split('=')[0];
}

export function isUnsafePandocToken(token: string): boolean {
  if (token === '--' || token === '>' || token === '>>' || token.startsWith('>') || token.includes('`') || token.includes('$(')) return true;
  const flag = flagName(token);
  return UNSAFE_PANDOC_FLAGS.has(flag) || (flag.startsWith('--') && [...UNSAFE_PANDOC_FLAGS].some(unsafe => unsafe.startsWith('--') && unsafe.startsWith(flag)));
}

export function sanitizePandocExtras(extra: string): { args: string[]; rejected: string[] } {
  const tokens = splitArgv(extra);
  const args: string[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      rejected.push(token, ...tokens.slice(i + 1));
      break;
    }
    if (isUnsafePandocToken(token)) {
      rejected.push(token);
      const flag = flagName(token);
      const attached = token.length > flag.length && !token.includes('=') && flag.startsWith('-') && !flag.startsWith('--');
      if (!token.includes('=') && !attached && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        rejected.push(tokens[++i]);
      }
      continue;
    }
    args.push(token);
  }
  if (rejected.length) throw new PandocExtraRejectedError(rejected);
  return { args, rejected };
}

export function pandocStructuredFlags(options: Record<string, unknown>): string[] {
  const flags: string[] = [];
  const toc = options.tocDepth ?? options['toc-depth'];
  const split = options.splitLevel ?? options['split-level'];
  if (toc !== undefined && toc !== '' && toc !== null) flags.push('--toc-depth', String(toc));
  if (split !== undefined && split !== '' && split !== null) flags.push('--split-level', String(split));
  if (options.ascii) flags.push('--ascii');
  if (options['reference-links'] || options.referenceLinks) flags.push('--reference-links');
  const refLoc = options['reference-location'] ?? options.referenceLocation;
  if (refLoc) flags.push('--reference-location', String(refLoc));
  const headings = options['markdown-headings'] ?? options.markdownHeadings;
  if (headings) flags.push('--markdown-headings', String(headings));
  if (options.tab === 'tab') flags.push('--preserve-tabs');
  else if (options.tab) flags.push('--tab-stop', String(options.tab));
  if (options.eol) flags.push('--eol', String(options.eol));
  if (options.hardLineWrap) flags.push('--wrap', 'auto', '--columns', String(options.columns ?? 130));
  if (options.webtex) {
    const fmt = options['webtex-format'] ?? options.webtexFormat ?? 'png';
    flags.push(String(fmt) === 'svg' ? '--webtex=https://latex.codecogs.com/svg.latex?' : '--webtex');
  }
  const ref = options['reference-doc'] ?? options.referenceDoc;
  if (ref) flags.push('--reference-doc', String(ref));
  if (options.template) flags.push('--template', String(options.template));
  if (options.css) flags.push('--css', String(options.css));
  const engine = options['pdf-engine'] ?? options.pdfEngine;
  if (engine) flags.push('--pdf-engine', String(engine));
  return flags;
}

export function afterExportActions(options: Record<string, unknown>, general: ExportGeneral): {
  openExportLocation: boolean;
  openExportFile: boolean;
  runCommandStr: string;
  showOutput: boolean;
} {
  const type = String(options.type ?? '');
  if (type === 'custom') {
    return {
      openExportLocation: options.saveDialog ? ae(options.openExportLocation, general.openExportLocation) : false,
      openExportFile: options.saveDialog === 'saveFile' ? !!options.openExportFile : false,
      runCommandStr: String(options.command ?? ''),
      showOutput: !!options.showOutput,
    };
  }
  return {
    openExportLocation: ae(options.openExportLocation, general.openExportLocation),
    openExportFile: !!options.openExportFile,
    runCommandStr: options.runCommand ? String(options.runCommandStr ?? '') : '',
    showOutput: !!options.showOutput,
  };
}

function ae(value: unknown, fallback: unknown): boolean {
  return !!(value === undefined ? fallback : value);
}

export function exportMenuItems(state: ExportSettingsState): { label: string; key: string; type: string }[] {
  const fixed = [
    { label: 'PDF', key: 'pdf', type: 'pdf' },
    { label: 'HTML', key: 'html', type: 'html' },
    { label: 'HTML (without styles)', key: 'html-plain', type: 'html-plain' },
    { label: 'Image', key: 'image', type: 'image' },
  ];
  const custom = state.customExport.map((e) => ({ label: e.name, key: e.key, type: e.type }));
  return [...fixed, ...custom];
}

export function pixelScaleForQuality(quality: unknown, windowScale: number, screenScale: number): number {
  const q = Number(quality ?? 0);
  if (q === 1 || q === 2 || q === 3) return q;
  return windowScale || screenScale || 1;
}
