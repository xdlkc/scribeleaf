import { store } from '../store';
import { isNative, openExternal, postToNative } from '../bridge';
import { type Prefs, type ThemeName } from '../types';
import { preferenceText as pt } from './preferences-i18n';

type Field = keyof Prefs;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); value.className = className;
  if (text !== undefined) value.textContent = pt(text);
  return value;
}
function write(field: Field, value: unknown) { store.setPrefs({ [field]: value } as Partial<Prefs>); }
function identify<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(input: T, field: Field, label: string): T {
  input.name = field; input.id = 'pref-option-' + field; input.dataset.field = field;
  input.setAttribute('aria-label', pt(label)); input.dataset.searchLabel = label; return input;
}
function group(field: string, title: string, ...items: HTMLElement[]): HTMLElement {
  const section = node('section', 'pref-section'); section.dataset.field = field;
  const content = node('div', 'pref-section-content'); content.append(...items);
  section.append(node('h3', '', title), content); return section;
}
function pane(...groups: HTMLElement[]): HTMLElement { const value = node('div', 'pref-pane'); value.append(...groups); return value; }
function subfield(label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLElement {
  const row = node('div', 'pref-subfield'); const caption = node('label', '', label); caption.htmlFor = control.id;
  row.append(caption, control); return row;
}
function check(field: Field, label: string, inverse = false, forced = false): HTMLElement {
  const input = identify(node('input'), field, label); input.type = 'checkbox';
  input.checked = forced || (inverse ? !store.prefs[field] : !!store.prefs[field]); input.disabled = forced;
  input.addEventListener('change', () => write(field, inverse ? !input.checked : input.checked));
  const caption = node('label', '', label); caption.prepend(input);
  const row = node('div', 'pref-row pref-check'); row.dataset.field = field; row.append(caption); return row;
}
type Choice = readonly [string, string];
function select(field: Field, label: string, options: readonly Choice[], custom?: (value: string) => boolean): HTMLSelectElement {
  const input = identify(node('select'), field, label);
  for (const [key, title] of options) { const option = node('option', '', title); option.value = key; input.append(option); }
  input.value = String(store.prefs[field]);
  input.addEventListener('change', () => {
    if (custom?.(input.value)) return;
    const current = store.prefs[field]; write(field, typeof current === 'number' ? Number(input.value) : typeof current === 'boolean' ? input.value === 'true' : input.value);
  });
  return input;
}
function text(field: Field, label: string, type: 'text' | 'number' | 'lines' = 'text'): HTMLInputElement | HTMLTextAreaElement {
  const input = type === 'lines' ? identify(node('textarea'), field, label) : identify(node('input'), field, label);
  if (input instanceof HTMLInputElement) input.type = type === 'number' ? 'number' : 'text';
  input.value = Array.isArray(store.prefs[field]) ? (store.prefs[field] as string[]).join('\n') : String(store.prefs[field] ?? '');
  input.addEventListener('change', () => write(field, type === 'lines' ? input.value.split(/\r?\n/).filter(value => value.trim()) : type === 'number' ? Number(input.value) : input.value));
  return input;
}
function chooseFolder(field: 'pinFolder' | 'customImageFolder', label: string): HTMLElement {
  const row = node('div', 'pref-input-group'); row.append(text(field, label));
  const button = node('button', 'pref-action', 'Choose…'); button.type = 'button';
  button.addEventListener('click', () => postToNative({ type: 'choosePreferenceFolder', field })); row.append(button); return row;
}

export function renderFilePreferences(): HTMLElement {
  const launch = select('restoreWhenLaunch', 'On Launch', [['0', 'Open new file'], ['1', 'Restore last closed folders'], ['2', 'Restore last closed files and folders'], ['3', 'Open custom folder']], value => {
    if (value === '3' && !store.prefs.pinFolder && isNative()) {
      postToNative({ type: 'choosePreferenceFolder', field: 'pinFolder', selectLaunchFolder: true }); return true;
    }
    return false;
  });
  const start = group('restoreWhenLaunch', 'On Launch', launch);
  if (store.prefs.restoreWhenLaunch === 3) start.querySelector('.pref-section-content')!.append(chooseFolder('pinFolder', 'Open custom folder'));
  const extensions = select('defaultExtension', 'Default File Type / Extension', [['md', 'Markdown (.md)'], ['markdown', 'Markdown (.markdown)'], ['text', 'Text File (.text)'], ['__custom', 'Custom']], value => {
    if (value !== '__custom') return false;
    const detail = start.parentElement?.querySelector<HTMLElement>('[data-field="defaultExtension"] .pref-extension-detail');
    if (detail) detail.hidden = false;
    return true;
  });
  const current = store.prefs.defaultExtension || 'md';
  if (!['md', 'markdown', 'text'].includes(current)) extensions.value = '__custom';
  const extensionDetail = node('div', 'pref-extension-detail'); extensionDetail.hidden = extensions.value !== '__custom';
  extensionDetail.append(text('defaultExtension', 'Custom extension'));
  extensionDetail.querySelector('input')!.id += '-custom';
  const extensionGroup = group('defaultExtension', 'Default File Type / Extension', extensions, extensionDetail);
  // Custom is a UI selection, not another persisted extension value.
  extensions.addEventListener('change', () => { extensionDetail.hidden = extensions.value !== '__custom'; if (!extensionDetail.hidden) extensionDetail.querySelector('input')?.focus(); });
  const tree = group('treeFileFilterMode', 'File Tree', select('treeFileFilterMode', 'File Tree', [['supported', 'Supported Files (Markdown & Plain Text)'], ['custom', 'Custom'], ['all', 'All Files']]));
  if (store.prefs.treeFileFilterMode === 'custom') tree.querySelector('.pref-section-content')!.append(text('treeFileFilterPatterns', 'File Tree — Custom Patterns', 'lines'));
  const library = group('libraryFileFilterMode', 'File Library', select('libraryFileFilterMode', 'File Library', [['supported', 'Supported Files (Markdown & Plain Text)'], ['custom', 'Custom']]));
  if (store.prefs.libraryFileFilterMode === 'custom') library.querySelector('.pref-section-content')!.append(text('libraryFileFilterPatterns', 'File Library — Custom Patterns', 'lines'));
  const recent = group('recordRecentFiles', 'Recent Files', check('recordRecentFiles', 'Record recent files and folders'));
  const clear = node('button', 'pref-action', 'Clear Recent Files'); clear.type = 'button';
  clear.addEventListener('click', () => { if (isNative()) postToNative({ type: 'clearRecent' }); else store.clearRecents(); });
  recent.querySelector('.pref-section-content')!.append(clear);
  return pane(start, extensionGroup,
    group('collapsibleOutline', 'Outline', check('collapsibleOutline', 'Collapsible Outline on Left Panel')),
    group('saveOnFileSwitch', 'Save & Recover', check('saveOnFileSwitch', 'Save without asking when switching files on side panel', false, store.runtimeFilePolicy.saveOnFileSwitchForced)),
    recent,
    group('folderDropAction', 'Drag and Drop',
      subfield('When drop folder', select('folderDropAction', 'When drop folder', [['open', 'Open in Scribeleaf'], ['link', 'Insert Folder Link']])),
      subfield('When drop markdown file', select('markdownDropAction', 'When drop markdown file', [['open', 'Open in Scribeleaf'], ['link', 'Insert File Link']])),
      subfield('When drop files that can be imported', select('importDropAction', 'When drop files that can be imported', [['import', 'Import File'], ['link', 'Insert File Link']]))),
    group('showHiddenFiles', 'File Browser', check('showHiddenFiles', 'Show hidden folders / files')), tree, library);
}

let uploaderRequestID = '';
let uploaderRunning = false;
let uploaderResult = '';
export function receiveImageUploaderTestResult(payload: { requestId?: string; paths?: string[]; error?: string }): void {
  if (payload?.requestId !== uploaderRequestID) return;
  uploaderRunning = false;
  uploaderResult = payload.error === 'cancelled' ? pt('Cancelled') : payload.error || (payload.paths ?? []).join('\n');
  store.emit('imageUploaderTest');
}

export function renderImagePreferences(): HTMLElement {
  const insertion = group('imageInsertAction', 'When Insert…', select('imageInsertAction', 'When Insert…', [['', 'No special action'], ['folder', 'Copy image to current folder (./)'], ['assert', 'Copy image to ./assets'], ['per-file-assert', 'Copy image to ./${filename}.assets'], ['ipic', 'Upload image'], ['custom', 'Copy image to custom folder']]));
  if (store.prefs.imageInsertAction === 'custom') insertion.querySelector('.pref-section-content')!.append(chooseFolder('customImageFolder', 'Copy image to custom folder'));
  const uploader = select('imageUploader', 'Image Uploader', [['', 'None'], ['ipic', 'iPic'], ['upic', 'uPic'], ['picsee', 'Picsee'], ['picgo-intro', 'PicGo-Core (command line)'], ['picgo-app', 'PicGo.app'], ['piclist-app', 'PicList'], ['custom', 'Custom Command']], value => {
    if (value !== 'picgo-intro') return false;
    openExternal('https://support.typora.io/Upload-Image/#picgo-core-command-line-opensource'); uploader.value = store.prefs.imageUploader; return true;
  });
  const uploading = group('imageUploader', 'Image Upload Setting', uploader);
  if (store.prefs.imageUploader === 'custom') uploading.querySelector('.pref-section-content')!.append(text('customImageUploadCommand', 'Command'));
  const test = node('button', 'pref-action', uploaderRunning ? 'Cancel' : 'Test Uploader'); test.type = 'button';
  test.addEventListener('click', () => {
    if (!isNative()) { uploaderResult = pt('This action requires the native app'); store.emit('imageUploaderTest'); return; }
    if (uploaderRunning) postToNative({ type: 'imageUploaderTestCancel', requestId: uploaderRequestID });
    else { uploaderRequestID = 'uploader-test-' + Date.now(); uploaderRunning = true; uploaderResult = ''; postToNative({ type: 'imageUploaderTest', requestId: uploaderRequestID }); store.emit('imageUploaderTest'); }
  });
  uploading.querySelector('.pref-section-content')!.append(test);
  if (uploaderResult) uploading.querySelector('.pref-section-content')!.append(node('pre', 'pref-upload-result', uploaderResult));
  return pane(insertion,
    group('imageRules', 'Images Insert', check('imageCopyLocal', 'Apply above rules to local images'), check('imageCopyOnline', 'Apply above rules to online images'), check('allowImageUpload', 'Allow upload images automatically based on YAML settings')),
    group('imagePaths', 'Image Path', check('useRelativeImagePaths', 'Use relative path if possible'), check('relativeImageDotPrefix', 'Add ./ for relative path'), check('escapeImageURLs', 'Auto escape image URL when insert')), uploading);
}

export function renderMarkdownPreferences(): HTMLElement {
  const syntax = group('strictMarkdown', 'Syntax Support', check('strictMarkdown', 'Strict Mode'), check('noAutoLink', 'Auto Links (e.g: https://typora.io)', true),
    check('enableInlineMath', 'Inline Math'), check('enableSubscript', 'Subscript'), check('enableSuperscript', 'Superscript'), check('enableHighlight', 'Highlight'), check('enableAlert', 'Github Style Alert'), check('enableDiagram', 'Diagrams'));
  const styles = group('headingStyle', 'Syntax Preference', subfield('Heading Style', select('headingStyle', 'Heading Style', [['0', 'atx (#)'], ['1', 'setext (===)'], ['2', 'atx with suffix (# ⋯ #)'], ['3', 'variable-width setext (=====)']])),
    subfield('Unordered List', select('ulStyle', 'Unordered List', [['0', '-'], ['1', '+'], ['2', '*']])), subfield('Ordered List', select('olStyle', 'Ordered List', [['0', '1. ⋯ 2. ⋯ 3. ⋯'], ['1', '1. ⋯ 1. ⋯ 1. ⋯']])));
  const smart = group('convertSmartOnRender', 'Smart Punctuation', select('convertSmartOnRender', 'Smart Punctuation', [['false', 'Convert on Input'], ['true', 'Convert on Rendering']]), check('smartQuote', 'Smart Quotes'), check('smartDash', 'Smart Dashes'), check('remapPunctuation', 'Remap Unicode Punctuation on Parse'));
  const code = group('codeIndentSize', 'Code Fences', check('showLineNumbersForFence', 'Display line numbers for code fences'), check('noLineWrapping', 'Auto wrap long lines', true), check('shiftTabAutoIndent', 'Use Shift+Tab to auto indent selected code'),
    subfield('Indent Size for Code', select('codeIndentSize', 'Indent Size for Code', [['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']])), subfield('Default Code Language', text('defaultCodeLang', 'Default Code Language')), subfield('Apply Default Code Language When', select('defaultCodeLangOption', 'Apply Default Code Language When', [['1', 'When add code fences via Markdown'], ['2', 'When add code fences via Menubar'], ['3', 'Both']])));
  return pane(syntax, styles, smart, code,
    group('noLegacyMath', 'Math Blocks', check('noLegacyMath', 'LaTeX Math Delimiter \\( \\) \\[ \\]', true), check('gitlabMath', 'Code Block Math'), select('autoNumberingForMath', 'Auto Numbering Math Equations', [['', 'No Automatic Equation Numbering'], ['ams', 'Use AMS Numbering Rules'], ['all', 'Auto Numbering for All Math Equations']])),
    group('indentFirstLine', 'Paragraph', check('indentFirstLine', 'Indent first line of paragraphs'), check('hideBrAndLineBreak', 'Visible <br/>', true)),
    group('ignoreLineBreak', 'Whitespace and Line Breaks', subfield('When Writing', select('ignoreLineBreak', 'When Writing', [['false', 'Preserve sequential whitespace and single line break'], ['true', 'Ignore sequential whitespace and single line break']])), subfield('Export / Print', select('preLinebreakOnExport', 'Export / Print', [['true', 'Preserve sequential whitespace and single line break'], ['false', 'Ignore sequential whitespace and single line break']]))));
}

export function renderGeneralPreferences(): HTMLElement {
  return pane(group('quitAfterWindowClose', 'General', check('quitAfterWindowClose', 'Quit Scribeleaf when last window is closed')),
    group('enableDebug', 'Security', check('enableDebug', 'Enable Debug')));
}

export function renderAppearancePreferences(): HTMLElement {
  const themes = ['github', 'gothic', 'night', 'newsprint', 'pixyll', 'whitey'] as ThemeName[];
  const theme = select('theme', 'Theme', themes.map(value => [value, value === 'github' ? 'GitHub' : value[0].toUpperCase() + value.slice(1)] as const));
  const zoom = select('zoom', 'Zoom', ['50', '67', '80', '90', '100', '110', '125', '150', '175', '200'].map(value => [value, value + '%'] as const));
  return pane(group('theme', 'Themes', theme), group('zoom', 'Zoom', zoom));
}
