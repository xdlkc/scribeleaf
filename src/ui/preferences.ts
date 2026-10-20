import { store } from '../store';
import { ThemeName, type Prefs } from '../types';
import { openExternal, postToNative } from '../bridge';
import { preferenceText as pt } from './preferences-i18n';
import { renderFilePreferences, renderImagePreferences, renderMarkdownPreferences, renderAppearancePreferences, renderGeneralPreferences } from './preference-panels';
import {
  ADD_TEMPLATES,
  addCustomExport,
  deleteCustomExport,
  formatOptions,
  moveCustomExport,
  patchFormat,
  patchGeneral,
  pandocStructuredFlags,
  renameCustomExport,
  schemaDefaults,
  type ExportSettingsState,
} from '../export-settings';

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'gothic', label: 'Gothic' },
  { value: 'night', label: 'Night' },
  { value: 'newsprint', label: 'Newsprint' },
  { value: 'pixyll', label: 'Pixyll' },
  { value: 'whitey', label: 'Whitey' },
];

const FIELD_LABELS: Record<string, string> = {
  exportFolder: 'Default Folder for Exported File', customExportPath: 'Custom location', pandocPath: 'Pandoc Path',
  openExportLocation: 'Open exported file location', openExportFile: 'Open exported file', runCommand: 'Run command',
  runCommandStr: 'Command', showOutput: 'Show command output', quality: 'Image Quality', exportTheme: 'Theme',
  paper: 'Paper Size', 'paper.margin': 'Page margins', 'paper.custom': 'Paper size (mm)',
  useThemeFontSize: 'Font Size', raw: 'Raw Type', saveDialog: 'Show Save File Dialog',
  appendHead: 'Append in <head />', appendBody: 'Append in <body />',
  allowPerFileSetting: 'General', splitPages: 'Page Break', sidebar: 'Outline',
  extraArguments: 'Extra Arguments', imageWidth: 'Width', imageFontSize: 'Font Size',
  'reference-doc': 'Style Reference', template: 'Template File', css: 'Custom CSS File',
  'toc-depth': 'Table of contents depth', targetFormat: 'Target format', extensions: 'File extensions',
  hardLineWrap: 'Hard line wrapping', variants: 'Variant', columns: 'Columns', eol: 'Line endings',
  tab: 'Tab / spaces', ascii: 'Use ASCII characters', 'reference-links': 'Use reference links',
  'reference-location': 'Reference location', 'markdown-headings': 'Heading style',
  webtex: 'Use WebTeX for math', 'webtex-format': 'WebTeX image format', 'pdf-engine': 'PDF engine',
  header: 'Header', footer: 'Footer', author: 'Author', command: 'Command', arg: 'Arguments',
};
const fieldLabel = (key: string) => FIELD_LABELS[key] ?? key;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = pt(text);
  return node;
}

type PreferenceTab = 'files' | 'general' | 'view' | 'editor' | 'export' | 'image' | 'markdown';

function routeTab(): PreferenceTab {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('preferences/files')) return 'files';
  if (hash.startsWith('preferences/image')) return 'image';
  if (hash.startsWith('preferences/markdown')) return 'markdown';
  if (hash.startsWith('preferences/editor')) return 'editor';
  if (hash.startsWith('preferences/view')) return 'view';
  if (hash.startsWith('preferences/export')) return 'export';
  return 'general';
}

function selectedExportKey(): string {
  const parts = location.hash.replace(/^#/, '').split('/');
  return parts[2] || 'general';
}

export function mountPreferences(root: HTMLElement): void {
  document.documentElement.classList.add('preferences-route');
  document.body.classList.add('preferences-route');
  const toolbar = el('div', 'pref-toolbar');
  const body = el('div', 'pref-body');
  root.replaceChildren(toolbar, body);

  const search = el('input', 'pref-search');
  search.type = 'search'; search.placeholder = pt('Search for…'); search.setAttribute('aria-label', pt('Search for…'));
  const categories = el('nav', 'pref-categories');
  toolbar.append(search, categories);
  const cats: { id: PreferenceTab; label: string; icon: string }[] = [
    { id: 'files', label: 'Files', icon: 'file-text' },
    { id: 'editor', label: 'Editor', icon: 'pencil' },
    { id: 'image', label: 'Images', icon: 'picture-o' },
    { id: 'markdown', label: 'Markdown', icon: 'markdown' },
    { id: 'export', label: 'Export', icon: 'print' },
    { id: 'view', label: 'View', icon: 'tint' },
    { id: 'general', label: 'General', icon: 'th-large' },
  ];
  for (const cat of cats) {
    const btn = el('button', 'pref-cat');
    const pictogram = el('span', 'pref-cat-icon'); pictogram.append(icon(cat.icon));
    btn.append(pictogram, el('span', '', cat.label));
    btn.addEventListener('click', () => {
      search.value = '';
      location.hash = '#preferences/' + cat.id;
      render();
    });
    categories.append(btn);
  }

  let previousRoute = '';
  const render = () => {
    const tab = routeTab();
    const route = location.hash;
    const sameRoute = route === previousRoute;
    const scroll = body.querySelector('.export-detail, .pref-pane')?.scrollTop ?? 0;
    const active = document.activeElement as HTMLInputElement | null;
    const activeID = active && body.contains(active) ? active.id : '';
    const selection = active?.tagName === 'INPUT' && active.type === 'text' ? [active.selectionStart, active.selectionEnd] : null;
    Array.from(categories.children).forEach((child, i) => {
      child.classList.toggle('active', cats[i].id === tab);
      child.setAttribute('aria-current', cats[i].id === tab ? 'page' : 'false');
    });
    body.replaceChildren();
    if (search.value.trim()) body.append(renderSearch(search.value, navigate));
    else if (tab === 'general') body.append(renderGeneralPreferences());
    else if (tab === 'files') body.append(renderFilePreferences());
    else if (tab === 'image') body.append(renderImagePreferences());
    else if (tab === 'markdown') body.append(renderMarkdownPreferences());
    else if (tab === 'view') body.append(renderAppearancePreferences());
    else if (tab === 'editor') body.append(renderEditor());
    else body.append(renderExport());
    previousRoute = route;
    if (sameRoute) {
      const scroller = body.querySelector('.export-detail, .pref-pane'); if (scroller) scroller.scrollTop = scroll;
      const replacement = activeID ? document.getElementById(activeID) as HTMLInputElement | null : null;
      if (replacement) { replacement.focus({ preventScroll: true }); if (selection) replacement.setSelectionRange(selection[0], selection[1]); }
    }
  };
  const navigate = (route: string, field: string) => {
    search.value = '';
    location.hash = route;
    render();
    requestAnimationFrame(() => {
      const target = Array.from(body.querySelectorAll<HTMLElement>('[data-field]')).find((node) => node.dataset.field === field);
      const group = target?.closest('.pref-section');
      group?.classList.add('search-hit'); target?.scrollIntoView({ block: 'nearest' });
    });
  };
  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; render(); }
    if (event.key === 'Enter' && search.value.trim()) body.querySelector<HTMLButtonElement>('.pref-search-result')?.click();
  });
  store.on('prefs', render);
  store.on('exportSettings', render);
  store.on('imageUploaderTest', render);
  window.addEventListener('hashchange', render);
  render();
}

const EDITOR_SETTINGS = [
  ['autoPairBrackets', 'Auto pair brackets and quotes', 'Auto Pair'],
  ['autoPairMarkdown', 'Auto pair common Markdown syntax', 'Auto Pair'],
  ['emojiAutoComplete', 'Enable autocomplete for Emojis', 'Auto Complete'],
  ['expandSimpleBlocks', 'Display source for simple blocks on focus', 'Live Rendering'],
  ['copyMarkdownAsPlainText', 'Copy Markdown source as plain text', 'Default Copy Behavior'],
  ['lineWiseCopyCut', 'Copy or cut the current line when no text is selected', 'Default Copy Behavior'],
  ['typewriterAlwaysCenter', 'Always keep caret in middle of screen when typewriter mode is enabled', 'Typewriter Mode'],
] as const;

function renderEditor(): HTMLElement {
  const pane = el('div', 'pref-pane pref-editor');
  const indent = el('select'); indent.name = 'indentSize'; indent.id = 'pref-editor-indentSize';
  for (const [value, label] of [['0', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['-1', 'Tab']]) {
    const option = el('option', '', label); option.value = value; indent.append(option);
  }
  indent.value = String(store.prefs.indentSize);
  indent.setAttribute('aria-label', pt('Indent Size on Save'));
  indent.addEventListener('change', () => store.setPrefs({ indentSize: Number(indent.value) as Prefs['indentSize'] }));
  const pretty = el('input'); pretty.type = 'checkbox'; pretty.name = 'prettyIndent'; pretty.id = 'pref-editor-prettyIndent'; pretty.checked = store.prefs.prettyIndent;
  pretty.addEventListener('change', () => store.setPrefs({ prettyIndent: pretty.checked }));
  const prettyRow = check('Pretty indentation', pretty); prettyRow.dataset.field = 'prettyIndent';
  pane.append(section('indentSize', 'Indent Size on Save', indent, prettyRow));
  const groups = new Map<string, HTMLElement>();
  for (const [key, label, title] of EDITOR_SETTINGS) {
    let group = groups.get(title);
    if (!group) { group = section(key, title); groups.set(title, group); pane.append(group); }
    const box = el('input'); box.type = 'checkbox'; box.name = key; box.id = 'pref-editor-' + key; box.checked = store.prefs[key];
    if (key === 'autoPairMarkdown') { box.disabled = !store.prefs.autoPairBrackets; box.checked = box.checked && !box.disabled; }
    box.addEventListener('change', () => store.setPrefs({ [key]: box.checked } as Partial<Prefs>));
    const row = check(label, box); row.dataset.field = key;
    group.querySelector('.pref-section-content')!.append(row);
  }
  return pane;
}

type SearchSetting = { route: string; field: string; label: string; category: string };
function renderSearch(query: string, navigate: (route: string, field: string) => void): HTMLElement {
  const pane = el('div', 'pref-search-results'); pane.setAttribute('aria-live', 'polite');
  const index: SearchSetting[] = [
    { route: '#preferences/export/general', field: 'exportFolder', label: 'Default Folder for Exported File', category: 'Export' },
    { route: '#preferences/export/general', field: 'pandocPath', label: 'Pandoc Path', category: 'Export' },
    { route: '#preferences/export/general', field: 'afterExport', label: 'After Export', category: 'Export' },
    { route: '#preferences/editor', field: 'indentSize', label: 'Indent Size on Save', category: 'Editor' },
    { route: '#preferences/editor', field: 'prettyIndent', label: 'Pretty indentation', category: 'Editor' },
    ...EDITOR_SETTINGS.map(([field, label]) => ({ route: '#preferences/editor', field, label, category: 'Editor' })),
  ];
  for (const [tab, category, renderer] of [
    ['files', 'Files', renderFilePreferences], ['image', 'Images', renderImagePreferences],
    ['markdown', 'Markdown', renderMarkdownPreferences], ['view', 'View', renderAppearancePreferences],
    ['general', 'General', renderGeneralPreferences],
  ] as const) {
    for (const input of renderer().querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) {
      if (input.dataset.field) index.push({ route: '#preferences/' + tab, field: input.dataset.field, label: input.dataset.searchLabel || input.getAttribute('aria-label') || input.name, category });
    }
  }
  index.push({route:'#preferences/files',field:store.prefs.treeFileFilterMode === 'custom' ? 'treeFileFilterPatterns' : 'treeFileFilterMode',label:'File Tree — Custom Patterns',category:'Files'},
    {route:'#preferences/files',field:store.prefs.libraryFileFilterMode === 'custom' ? 'libraryFileFilterPatterns' : 'libraryFileFilterMode',label:'File Library — Custom Patterns',category:'Files'},
    {route:'#preferences/image',field:store.prefs.imageInsertAction === 'custom' ? 'customImageFolder' : 'imageInsertAction',label:'Copy image to custom folder',category:'Images'});
  for (const [key, type, name] of [
    ['pdf', 'pdf', 'PDF'], ['html', 'html', 'HTML'], ['html-plain', 'html-plain', 'HTML (without Styles)'], ['image', 'image', 'Image'],
    ...store.exportSettings.customExport.map((entry) => [entry.key, entry.type, entry.name]),
  ]) {
    for (const [field, label] of [['afterExport', 'After Export'], ['afterExport', 'Open exported file location'], ['afterExport', 'Open exported file'], ['afterExport', 'Run command'], ['afterExport', 'Show command output']]) {
      index.push({ route: '#preferences/export/' + key, field, label, category: pt('Export') + ' › ' + name });
    }
    if (type === 'pdf') for (const [field, label] of [['paper.margin', 'Page margins'], ['paper.custom', 'Width × Height']]) {
      index.push({ route: '#preferences/export/' + key, field, label, category: pt('Export') + ' › ' + name });
    }
    for (const field of Object.keys(schemaDefaults(type))) {
      if (field.startsWith('paper.') || ['key', 'type', 'name', 'arg', 'runCommandStr', 'showOutput', 'imageFontSize'].includes(field)) continue;
      index.push({ route: '#preferences/export/' + key, field: field === 'useThemeFontSize' ? 'fontSize' : field,
        label: field === 'quality' ? 'Image Quality' : field === 'useThemeFontSize' ? 'Font Size' : fieldLabel(field), category: pt('Export') + ' › ' + name });
    }
  }
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = index.filter((item) => terms.every((term) => (item.label + ' ' + pt(item.label) + ' ' + item.category + ' ' + pt(item.category) + ' ' + item.field).toLocaleLowerCase().includes(term)));
  if (!matches.length) pane.append(el('p', '', 'No matching settings'));
  for (const item of matches) {
    const button = el('button', 'pref-search-result', item.label); button.type = 'button';
    button.append(el('small', '', item.category));
    button.addEventListener('click', () => navigate(item.route, item.field)); pane.append(button);
  }
  return pane;
}

function renderExport(): HTMLElement {
  const wrap = el('div', 'export-config');
  const sidebar = el('div', 'export-sidebar');
  const list = el('div', 'export-list');
  const detail = el('div', 'export-detail');
  wrap.append(sidebar, detail);
  sidebar.append(list);
  const state = store.exportSettings;
  const key = selectedExportKey();
  const items: { key: string; label: string; deletable: boolean }[] = [
    { key: 'general', label: 'General', deletable: false },
    { key: 'pdf', label: 'PDF', deletable: false },
    { key: 'html', label: 'HTML', deletable: false },
    { key: 'html-plain', label: 'HTML (without Styles)', deletable: false },
    { key: 'image', label: 'Image', deletable: false },
    ...state.customExport.map((e) => ({ key: e.key, label: e.name, deletable: true })),
  ];
  for (const item of items) {
    if (item.key === 'pdf') list.append(el('div', 'export-separator'));
    const btn = el('button', 'export-item' + (item.key === key ? ' active' : ''), item.label);
    btn.dataset.exportKey = item.key;
    btn.addEventListener('click', () => {
      location.hash = '#preferences/export/' + item.key;
    });
    list.append(btn);
    if (item.key === 'image') list.append(el('div', 'export-separator'));
  }
  const tools = el('div', 'export-tools');
  const current = items.find((i) => i.key === key);
  const add = iconButton('plus', 'Add…');
  add.dataset.action = 'add';
  const addMenu = el('div', 'pref-popover export-template-menu');
  addMenu.hidden = true;
  addMenu.setAttribute('role', 'menu');
  add.setAttribute('aria-haspopup', 'menu');
  add.setAttribute('aria-expanded', 'false');
  add.addEventListener('click', () => {
    addMenu.hidden = !addMenu.hidden;
    add.setAttribute('aria-expanded', String(!addMenu.hidden));
    if (!addMenu.hidden) addMenu.querySelector('button')?.focus();
  });
  for (const template of ADD_TEMPLATES) {
    const item = el('button', 'pref-menu-item', template.name);
    item.type = 'button'; item.setAttribute('role', 'menuitem');
    item.addEventListener('click', () => {
      const next = addCustomExport(store.exportSettings, template.type, template.name);
      commit(next);
      location.hash = '#preferences/export/' + next.customExport[next.customExport.length - 1].key;
    });
    addMenu.append(item);
  }
  addMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { addMenu.hidden = true; add.setAttribute('aria-expanded', 'false'); add.focus(); }
  });
  tools.addEventListener('focusout', () => queueMicrotask(() => {
    if (!tools.contains(document.activeElement)) { addMenu.hidden = true; add.setAttribute('aria-expanded', 'false'); }
  }));
  const del = iconButton('minus', 'Delete');
  del.dataset.action = 'delete'; del.disabled = !current?.deletable;
  del.addEventListener('click', () => {
    commit(deleteCustomExport(store.exportSettings, key));
    location.hash = '#preferences/export/general';
  });
  const index = state.customExport.findIndex((item) => item.key === key);
  const up = iconButton('arrow-up', 'Move Up');
  up.dataset.action = 'up'; up.disabled = index <= 0;
  up.addEventListener('click', () => commit(moveCustomExport(store.exportSettings, key, -1)));
  const down = iconButton('arrow-down', 'Move Down');
  down.dataset.action = 'down'; down.disabled = index < 0 || index >= state.customExport.length - 1;
  down.addEventListener('click', () => commit(moveCustomExport(store.exportSettings, key, 1)));
  const rename = iconButton('pencil', 'Rename');
  rename.dataset.action = 'rename'; rename.disabled = !current?.deletable;
  rename.addEventListener('click', () => {
    const name = window.prompt(pt('Name'), current?.label ?? '');
    if (name) commit(renameCustomExport(store.exportSettings, key, name));
  });
  tools.append(add, del, el('span', 'export-tool-spacer'), up, down, rename, addMenu);
  sidebar.append(tools);
  if (key === 'general') detail.append(renderExportGeneral(state));
  else detail.append(renderFormatCard(state, key));
  return wrap;
}

function commit(next: ExportSettingsState): void {
  store.setExportSettings(next);
}

const HELP_LINKS: Record<string, string> = {
  pandocPath: 'https://support.typora.io/Export/#pandoc',
  quality: 'https://support.typora.io/Export/#image-quality',
  header: 'https://support.typora.io/Export/#header--footer',
  footer: 'https://support.typora.io/Export/#header--footer',
  author: 'https://support.typora.io/Export/#header--footer',
  appendHead: 'https://support.typora.io/Export/#add-custom-contents',
  appendBody: 'https://support.typora.io/Export/#add-custom-contents',
  allowPerFileSetting: 'https://support.typora.io/Export/#per-file-configurations',
  extraArguments: 'https://support.typora.io/Export/#other-pandoc-options',
  'reference-doc': 'https://support.typora.io/Export/#style-reference',
  template: 'https://support.typora.io/Export/#template',
  css: 'https://support.typora.io/Export/#epub',
  command: 'https://support.typora.io/Export/#other-formats-using-custom-commands',
};

function icon(name: string): HTMLElement {
  const span = el('span', 'pref-icon pref-icon-' + name);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function iconButton(name: string, title: string): HTMLButtonElement {
  const button = el('button', 'pref-action');
  button.type = 'button'; button.title = pt(title); button.setAttribute('aria-label', pt(title));
  button.append(icon(name));
  return button;
}

function section(field: string, title: string, ...children: HTMLElement[]): HTMLElement {
  const group = el('section', 'pref-section');
  group.dataset.field = field;
  const heading = el('h3', '', title);
  const link = HELP_LINKS[field];
  if (link) {
    const help = el('a', 'pref-help-link', 'Learn More…');
    help.href = link; help.target = '_blank'; help.rel = 'noopener';
    help.addEventListener('click', (event) => { event.preventDefault(); openExternal(link); });
    heading.append(help);
  }
  const content = el('div', 'pref-section-content');
  content.append(...children); group.append(heading, content);
  return group;
}

function identify<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(node: T, key: string, field: string): T {
  node.name = field;
  node.id = 'pref-export-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + field.replace(/[^a-zA-Z0-9_-]/g, '-');
  node.dataset.field = field;
  node.setAttribute('aria-label', pt(fieldLabel(field)));
  return node;
}

function renderExportGeneral(state: ExportSettingsState): HTMLElement {
  const card = el('div', 'pref-card');
  const folder = identify(el('select'), 'general', 'exportFolder');
  for (const [value, label] of [['', 'Auto'], ['same', 'Same folder with current file'], ['custom', 'Custom location']] as const) {
    const option = el('option', '', label); option.value = value; folder.append(option);
  }
  folder.value = state.general.exportFolder;
  folder.addEventListener('change', () => commit(patchGeneral(store.exportSettings, 'exportFolder', folder.value)));
  const folderGroup = section('exportFolder', 'Default Folder for Exported File', folder);
  if (state.general.exportFolder === 'custom') {
    const path = identify(el('input'), 'general', 'customExportPath');
    path.type = 'text'; path.value = state.general.customExportPath;
    path.addEventListener('change', () => commit(patchGeneral(store.exportSettings, 'customExportPath', path.value)));
    const browse = iconButton('folder-open', 'Choose…');
    browse.addEventListener('click', () => postToNative({ type: 'chooseExportFolder' }));
    const row = el('div', 'pref-input-group'); row.dataset.field = 'customExportPath'; row.append(path, browse);
    folderGroup.querySelector('.pref-section-content')!.append(row);
  }
  const pandoc = identify(el('input'), 'general', 'pandocPath');
  pandoc.type = 'text'; pandoc.placeholder = pt('(Auto Detect)'); pandoc.value = state.pandocPath;
  pandoc.addEventListener('change', () => commit(patchGeneral(store.exportSettings, 'pandocPath', pandoc.value)));
  const pickPandoc = iconButton('folder-open', 'Choose…');
  pickPandoc.addEventListener('click', () => postToNative({ type: 'choosePandoc' }));
  const pandocRow = el('div', 'pref-input-group'); pandocRow.append(pandoc, pickPandoc);
  const openLoc = identify(el('input'), 'general', 'openExportLocation');
  openLoc.type = 'checkbox'; openLoc.checked = state.general.openExportLocation;
  openLoc.addEventListener('change', () => commit(patchGeneral(store.exportSettings, 'openExportLocation', openLoc.checked)));
  card.append(folderGroup, section('pandocPath', 'Pandoc Path', pandocRow), section('afterExport', 'After Export', check('Open exported file location', openLoc)));
  return card;
}

function renderFormatCard(state: ExportSettingsState, key: string): HTMLElement {
  const type = key === 'html' || key === 'html-plain' || key === 'pdf' || key === 'image'
    ? key : state.customExport.find((entry) => entry.key === key)?.type ?? key;
  const options = formatOptions(state, key);
  const defaults = schemaDefaults(type);
  const card = el('div', 'pref-card');
  card.dataset.exportType = type;
  const pandocType = !['html', 'html-plain', 'pdf', 'image', 'png', 'custom'].includes(type);
  if (pandocType) {
    // A preview of invariant/user flags. Native export resolves temporary source
    // and destination paths separately, so no pretend paths are shown here.
    const writer = type === 'wiki' ? 'mediawiki' : type === 'latex-pdf' ? 'pdf' : type === 'pandoc' ? String(options.targetFormat ?? '') : type === 'markdown' ? String(options.variants || 'markdown') : type;
    const flags = ['--from', 'markdown', ...(writer ? ['--to', writer] : []), '--standalone', ...pandocStructuredFlags(options)];
    const quote = (value: string) => /^[a-zA-Z0-9_./:=?+@,-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
    const preview = identify(el('input'), key, 'arg'); preview.type = 'text'; preview.readOnly = true;
    preview.value = flags.map(quote).join(' ') + (options.extraArguments ? ' ' + String(options.extraArguments) : '');
    card.append(section('arg', 'Arguments', preview));
  }
  const fields = Object.keys({ ...defaults, ...options }).filter((field) => !['key', 'type', 'name', ...(pandocType ? ['arg'] : []), 'openExportLocation', 'openExportFile', 'runCommand', 'runCommandStr', 'showOutput'].includes(field));
  for (const field of fields) {
    if (field.startsWith('paper.') || field === 'imageFontSize') continue;
    card.append(control(key, field, options[field], type, options));
  }
  card.append(afterExportControls(state, key, options));
  return card;
}

function control(key: string, field: string, value: unknown, type: string, options: Record<string, unknown>): HTMLElement {
  const set = (next: unknown) => commit(patchFormat(store.exportSettings, key, field, next));
  if (field === 'paper') return paperControls(key, options);
  if (field === 'useThemeFontSize') {
    const content = el('div', 'pref-font-options');
    content.append(radio('Use custom font size', value !== 1, () => set(0), 'pref-export-' + key + '-font-size', 'custom'),
      radio('Use theme font size', value === 1, () => set(1), 'pref-export-' + key + '-font-size', 'theme'));
    for (const input of content.querySelectorAll('input')) { input.name = 'useThemeFontSize'; input.dataset.field = 'useThemeFontSize'; }
    if (value !== 1) content.append(numberWithUnit(key, 'imageFontSize', options.imageFontSize, 'px', schemaDefaults(type).imageFontSize));
    return section('fontSize', 'Font Size', content);
  }
  if (field === 'exportTheme') {
    const select = identify(el('select'), key, field);
    const current = el('option', '', 'Current Theme'); current.value = ''; select.append(current);
    for (const theme of THEMES) { const option = el('option', '', theme.label); option.value = theme.value; select.append(option); }
    select.value = String(value ?? ''); select.addEventListener('change', () => set(select.value));
    const help = iconButton('question-circle', 'Change this option to specify a separated theme for export.');
    help.addEventListener('click', () => openExternal('https://support.typora.io/Export/#change-export-theme'));
    const group = el('div', 'pref-input-group'); group.append(select, help);
    return section(field, 'Theme', group);
  }
  if (field === 'sidebar' || field === 'splitPages' || field === 'allowPerFileSetting' || typeof value === 'boolean') {
    const box = identify(el('input'), key, field); box.type = 'checkbox'; box.checked = !!value;
    box.addEventListener('change', () => set(box.checked));
    const text = field === 'sidebar' ? 'Include Outline Sidebar' : field === 'splitPages' ? 'Page Break Between Top Headings' : field === 'allowPerFileSetting' ? 'Read and overwrite export settings from YAML front matters' : fieldLabel(field);
    return section(field, fieldLabel(field), check(text, box));
  }
  if (field === 'quality' || field === 'raw' || field === 'saveDialog') {
    const select = identify(el('select'), key, field);
    const choices = field === 'quality' ? [['0', 'Auto'], ['1', 'Medium'], ['2', 'High'], ['3', 'Best']]
      : field === 'saveDialog' ? [['', 'Do not popup save file dialog'], ['saveFile', 'Select file path to save'], ['saveFolder', 'Select folder path to save']]
      : ['', 'html', 'mediawiki', 'rst', 'textile', 'latex', 'docx', 'opml'].map((raw) => [raw, raw || 'Auto']);
    for (const [choice, label] of choices) { const option = el('option', '', label); option.value = choice; select.append(option); }
    select.value = String(value ?? (field === 'quality' ? 0 : ''));
    select.addEventListener('change', () => set(field === 'quality' ? Number(select.value) : select.value));
    return section(field, field === 'quality' ? 'Image Quality' : field === 'raw' ? 'Raw Type' : 'Show Save File Dialog', select);
  }
  if (field === 'extensions' && type === 'custom' && options.saveDialog !== 'saveFile') { const hidden = el('div'); hidden.hidden = true; hidden.dataset.field = field; return hidden; }
  if (typeof value === 'number' || field === 'imageWidth' || field === 'columns' || field === 'toc-depth') {
    const number = numberWithUnit(key, field, value, field === 'imageWidth' ? 'px' : '', field === 'imageWidth' ? schemaDefaults(type)[field] : undefined);
    return section(field, fieldLabel(field), number);
  }
  const title = field === 'appendBody' && type === 'pdf' ? 'Append Extra Content (HTML)' : fieldLabel(field);
  if (field === 'appendHead' || field === 'appendBody') {
    const textarea = identify(el('textarea'), key, field); textarea.value = String(value ?? '');
    textarea.addEventListener('change', () => set(textarea.value));
    return section(field, title, textarea);
  }
  const input = identify(el('input'), key, field); input.type = 'text'; input.value = String(value ?? '');
  input.addEventListener('change', () => set(input.value));
  if (field === 'header' || field === 'footer') {
    input.placeholder = pt('None');
    const group = el('div', 'pref-input-group pref-preset-group');
    const menu = el('div', 'pref-popover pref-preset-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
    const presets = field === 'header' ? ['${title}', '${author}', '${pageNo}', '${today}'] : ['${title}', 'No. ${pageNo} / ${totalPages}', 'Written in Scribeleaf', 'CONFIDENTIAL'];
    const button = iconButton('ellipsis-h', 'Presets'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus(); });
    for (const preset of ['', ...presets]) {
      const item = el('button', 'pref-menu-item', preset || 'None'); item.type = 'button'; item.setAttribute('role', 'menuitem');
      item.addEventListener('click', () => set(preset)); menu.append(item);
    }
    group.addEventListener('focusout', () => queueMicrotask(() => { if (!group.contains(document.activeElement)) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); } }));
    group.addEventListener('keydown', (event) => { if (event.key === 'Escape') { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); } });
    group.append(input, button, menu); return section(field, title, group);
  }
  if (field === 'author') input.placeholder = pt('Empty');
  if (field === 'customExportPath' || field === 'pandocPath' || field === 'reference-doc' || field === 'template' || field === 'css') {
    const browse = iconButton('folder-open', 'Choose…');
    browse.addEventListener('click', () => postToNative({ type: 'chooseExportFile', key, field }));
    const group = el('div', 'pref-input-group'); group.append(input, browse); return section(field, title, group);
  }
  return section(field, title, input);
}

function numberWithUnit(key: string, field: string, value: unknown, unit = '', resetValue?: unknown): HTMLElement {
  const row = el('div', 'pref-number-unit');
  const input = identify(el('input'), key, field); input.type = 'number'; input.value = String(value ?? '');
  input.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, field, Number(input.value))));
  row.append(input);
  if (unit) row.append(el('span', 'pref-unit', unit));
  if (resetValue !== undefined) {
    const reset = el('button', 'pref-reset', 'Reset'); reset.type = 'button'; reset.dataset.action = 'reset';
    reset.addEventListener('click', () => commit(patchFormat(store.exportSettings, key, field, resetValue)));
    row.append(reset);
  }
  return row;
}

function paperControls(key: string, options: Record<string, unknown>): HTMLElement {
  const paper = identify(el('select'), key, 'paper');
  for (const [value, label] of [['', 'Mac Default'], ['A5', 'A5'], ['A4', 'A4'], ['A3', 'A3'], ['Letter', 'US Letter'], ['Legal', 'US Legal'], ['Tabloid', 'Tabloid'], ['custom', 'Custom']]) {
    const option = el('option', '', label); option.value = value; paper.append(option);
  }
  const current = String(options.paper ?? ''); paper.value = current;
  paper.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'paper', paper.value)));
  const margins = identify(el('select'), key, 'paper.margin');
  for (const [value, label] of [['', 'Default margins'], ['custom', 'Custom margins']]) {
    const option = el('option', '', label); option.value = value; margins.append(option);
  }
  margins.value = String(options['paper.margin'] ?? '');
  margins.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'paper.margin', margins.value)));
  const marginRow = labeled('Page margins', margins, 'paper-margin'); marginRow.classList.add('pref-paper-option');
  const dimensions = el('div', 'pref-paper-dimensions'); dimensions.dataset.field = 'paper.custom';
  dimensions.append(el('span', 'pref-paper-label', 'Width × Height'));
  const values = el('span', 'pref-paper-size-values'); dimensions.append(values);
  const sizes: Record<string, number[]> = { A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [216, 279], Legal: [216, 356], Tabloid: [279, 432] };
  const custom = Array.isArray(options['paper.custom']) ? options['paper.custom'] : [210, 297];
  // Like the reference panel, Default previews the retained custom dimensions
  // (A4 when absent). It is a read-only preview; native export still uses the
  // actual system paper when paper is empty.
  const pair = current === 'custom' ? custom : sizes[current] ?? custom;
  for (const [index, label] of ['Width', 'Height'].entries()) {
    const input = identify(el('input'), key, 'paper.custom'); input.id += '-' + index;
    input.type = 'number'; input.min = '1'; input.max = '2000'; input.readOnly = current !== 'custom';
    input.value = String(pair[index]);
    input.setAttribute('aria-label', pt('Paper ' + label.toLowerCase() + ' (mm)'));
    input.addEventListener('change', () => { const next = [...custom]; next[index] = Number(input.value); commit(patchFormat(store.exportSettings, key, 'paper.custom', next)); });
    values.append(input, document.createTextNode(index === 0 ? ' mm x ' : ' mm'));
  }
  const group = section('paper', 'Paper Size', paper, marginRow, dimensions);
  if (margins.value === 'custom') {
    const customMargins = el('div', 'pref-paper-margins'); customMargins.dataset.field = 'paper.margin';
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      const field = 'paper.margin' + side;
      customMargins.append(labeled(side, numberWithUnit(key, field, options[field] ?? 16, 'mm'), field));
    }
    marginRow.after(customMargins);
  }
  return group;
}

function afterExportControls(state: ExportSettingsState, key: string, options: Record<string, unknown>): HTMLElement {
  const loc = identify(el('input'), key, 'openExportLocation'); loc.type = 'checkbox';
  loc.checked = options.openExportLocation === undefined ? state.general.openExportLocation : !!options.openExportLocation;
  loc.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'openExportLocation', loc.checked)));
  const file = identify(el('input'), key, 'openExportFile'); file.type = 'checkbox'; file.checked = !!options.openExportFile;
  file.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'openExportFile', file.checked)));
  const run = identify(el('input'), key, 'runCommand'); run.type = 'checkbox'; run.checked = !!options.runCommand;
  run.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'runCommand', run.checked)));
  const group = section('afterExport', 'After Export', check('Open exported file location', loc), check('Open exported file', file), check('Run command', run));
  if (options.runCommand) {
    const cmd = identify(el('input'), key, 'runCommandStr'); cmd.type = 'text'; cmd.value = String(options.runCommandStr ?? '');
    cmd.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'runCommandStr', cmd.value)));
    const out = identify(el('input'), key, 'showOutput'); out.type = 'checkbox'; out.checked = !!options.showOutput;
    out.addEventListener('change', () => commit(patchFormat(store.exportSettings, key, 'showOutput', out.checked)));
    const nested = el('div', 'pref-command-options'); nested.append(cmd, check('Show command output', out));
    group.querySelector('.pref-section-content')!.append(nested);
  }
  return group;
}

function labeled(text: string, controlEl: HTMLElement, field = text.toLowerCase().replace(/[^a-z0-9]+/g, '-')): HTMLElement {
  const row = el('div', 'pref-row');
  const label = el('label', '', text);
  const target = controlEl.matches('input, select, textarea') ? controlEl : controlEl.querySelector('input, select, textarea') ?? controlEl;
  const id = target.id || 'pref-' + field; target.id = id; label.htmlFor = id;
  row.append(label, controlEl); return row;
}

function check(text: string, box: HTMLInputElement): HTMLElement {
  const row = el('div', 'pref-row pref-check');
  const label = el('label', '', text); label.prepend(box); row.append(label); return row;
}

function radio(text: string, checked: boolean, on: () => void, name?: string, value?: string): HTMLElement {
  const row = el('div', 'pref-row pref-radio');
  const box = el('input'); box.type = 'radio'; box.checked = checked;
  if (name) box.name = name;
  if (value) box.value = value;
  box.addEventListener('change', () => { if (box.checked) on(); });
  const label = el('label', '', text); label.prepend(box); row.append(label); return row;
}
