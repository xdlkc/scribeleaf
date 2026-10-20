import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const cache = resolve('.cache/file-preferences-qa');
await mkdir(cache, { recursive: true });
const vectors = [
  ['baseline-md', 'notes.md', 'notes.md', [], true, true],
  ['baseline-nontext', 'data.csv', 'data.csv', [], false, false],
  ['basename-any-depth', 'data.csv', 'nested/deep/data.csv', ['*.csv'], false, true],
  ['slash-relative', 'data.csv', 'nested/data.csv', ['nested/*.csv'], false, true],
  ['slash-does-not-match-other-root', 'data.csv', 'other/nested/data.csv', ['nested/*.csv'], false, false],
  ['single-star-no-slash', 'data.csv', 'nested/deep/data.csv', ['nested/*.csv'], false, false],
  ['double-star-recursive', 'data.csv', 'nested/deep/data.csv', ['nested/**/*.csv'], false, true],
  ['double-star-zero-depth', 'data.csv', 'data.csv', ['**/*.csv'], false, true],
  ['double-star-zero-inner-depth', 'data.csv', 'nested/data.csv', ['nested/**/*.csv'], false, true],
  ['exclude-supported', 'draft-a.md', 'nested/draft-a.md', ['!**/draft-*.md'], true, false],
  ['exclude-wins-first', 'data.csv', 'nested/data.csv', ['!*.csv', '*.csv'], false, false],
  ['exclude-wins-last', 'data.csv', 'nested/data.csv', ['*.csv', '!*.csv'], false, false],
  ['unmatched-include-keeps-supported', 'note.md', 'note.md', ['*.csv'], true, true],
  ['spaces-around-pattern', 'data.csv', 'data.csv', ['  *.csv  '], false, true],
  ['spaces-after-exclusion', 'note.md', 'note.md', [' ! *.md  '], true, false],
  ['empty-negation-ignored', 'note.md', 'note.md', ['!', '  '], true, true],
  ['mac-case-sensitive', 'DATA.CSV', 'DATA.CSV', ['*.csv'], false, false],
  ['question-one-character', 'file1.csv', 'file1.csv', ['file?.csv'], false, true],
  ['question-not-two', 'file12.csv', 'file12.csv', ['file?.csv'], false, false],
  ['character-range', 'file2.csv', 'file2.csv', ['file[1-3].csv'], false, true],
  ['negative-character-range', 'file9.csv', 'file9.csv', ['file[!1-3].csv'], false, true],
  ['negative-range-excludes', 'file2.csv', 'file2.csv', ['file[^1-3].csv'], false, false],
  ['braces-are-literal', 'file{a,b}.csv', 'file{a,b}.csv', ['file{a,b}.csv'], false, true],
  ['braces-are-not-alternation', 'filea.csv', 'filea.csv', ['file{a,b}.csv'], false, false],
  ['regex-punctuation-literal', '(a)+$.csv', '(a)+$.csv', ['(a)+$.csv'], false, true],
  ['unicode-basename', '中文.csv', '项目/中文.csv', ['*.csv'], false, true],
  ['emoji-one-question-does-not-consume-surrogate-pair', '😀.csv', '😀.csv', ['?.csv'], false, false],
  ['emoji-two-questions-consume-surrogate-pair', '😀.csv', '😀.csv', ['??.csv'], false, true],
  ['emoji-exclusion-must-not-remove-supported', '😀.md', '😀.md', ['!?.md'], true, true],
  ['emoji-literal', '😀.csv', '😀.csv', ['😀.csv'], false, true],
  ['combining-mark-two-units', 'e\u0301.csv', 'e\u0301.csv', ['??.csv'], false, true],
  ['double-star-cannot-consume-line-separator', 'b.csv', 'a\u2028/b.csv', ['**/b.csv'], false, false],
  ['single-star-can-consume-line-separator', 'a\u2028.csv', 'a\u2028.csv', ['*.csv'], false, true],
  ['backslash-relative-normalized', 'data.csv', 'nested\\data.csv', ['nested/*.csv'], false, true],
  ['leading-slash-trimmed', 'data.csv', '/nested/data.csv', ['nested/*.csv'], false, true],
  ['invalid-pattern-ignored', 'note.md', 'note.md', ['[bad'], true, true],
  ['extensionless-baseline', 'README', 'docs/README', [], true, true],
].map(([id, name, path, patterns, supported, expected]) => ({ id, name, path, patterns, supported, expected }));
const vectorsPath = resolve(cache, 'vectors.json');
await writeFile(vectorsPath, JSON.stringify(vectors));

const source = String.raw`
import { DEFAULT_FILE_PREFERENCES as defaults, normalizeFilePreferences, normalizeDefaultExtension, fileAllowed, filePathVisible, isSupportedFile, matchesFilePatterns } from './src/file-preferences.ts';
import { store } from './src/store.ts';
import { registerCommand } from './src/commands.ts';
import { initSidebar } from './src/ui/sidebar.ts';
const checks = [];
function check(name, passed, actual) { checks.push({ name, passed: !!passed, ...(actual === undefined ? {} : { actual }) }); }
const vectors = JSON.parse(process.env.FILE_PREFS_VECTORS);
for (const row of vectors) check('glob-' + row.id, matchesFilePatterns(row.name, row.path, row.patterns, row.supported) === row.expected);
check('custom-extension-normalized-prefix', normalizeDefaultExtension(' .NOTE.Book /junk') === 'note.book');
check('invalid-extension-normalized-empty', normalizeDefaultExtension('!!md') === '');
check('extensionless-and-rmarkdown-supported', isSupportedFile('README', defaults) && isSupportedFile('note.rmarkdown', defaults));
check('custom-extension-added', isSupportedFile('note.FOO', normalizeFilePreferences({ defaultExtension: '.FOO' })));
const invalid = normalizeFilePreferences({ defaultExtension: 1, restoreWhenLaunch: true, recordRecentFiles: 'false', showHiddenFiles: 1, libraryFileFilterMode: 'all', treeFileFilterPatterns: [1, '*.csv'] });
check('invalid-types-normalized', invalid.defaultExtension === 'md' && invalid.restoreWhenLaunch === 0 && invalid.recordRecentFiles === true && invalid.showHiddenFiles === false && invalid.libraryFileFilterMode === 'supported' && JSON.stringify(invalid.treeFileFilterPatterns) === '["*.csv"]');
const normalized = normalizeFilePreferences({ treeFileFilterPatterns: ['*.csv'] });
normalized.treeFileFilterPatterns.push('*.png');
check('default-pattern-arrays-not-shared', defaults.treeFileFilterPatterns.length === 0 && normalizeFilePreferences({}).treeFileFilterPatterns.length === 0);
check('all-still-hides-hidden-parents', !fileAllowed('notes.md', '.private/notes.md', { ...defaults, treeFileFilterMode: 'all' }, 'tree'));
check('node-modules-directory-hidden', !filePathVisible('deps/node_modules', defaults, 'tree'));
check('node-modules-regular-file-supported', fileAllowed('node_modules', 'node_modules', defaults, 'tree'));
check('node-modules-tree-all-only', fileAllowed('data.csv', 'node_modules/data.csv', { ...defaults, treeFileFilterMode: 'all' }, 'tree') && !fileAllowed('data.md', 'node_modules/data.md', { ...defaults, treeFileFilterMode: 'all' }, 'library'));

const opens = [], jumps = [];
registerCommand('openPath', value => opens.push(value));
registerCommand('scrollToPos', value => jumps.push(value));
const root = '/synthetic-files';
const paths = ['README', 'node_modules', 'note.md', 'data.csv', '.hidden.md', '.private/note.md', 'nested/notes.md', 'nested/draft-a.md', 'nested/data.csv', 'assets/image.png', 'deps/node_modules/notes.md'];
const files = paths.map(relativePath => ({ name: relativePath.split('/').at(-1), path: root + '/' + relativePath, relativePath }));
const dirs = ['.private', 'nested', 'assets', 'empty', 'deps', 'deps/node_modules'].map(relativePath => ({ name: relativePath.split('/').at(-1), path: root + '/' + relativePath, relativePath }));
store.setFiles(root, files, dirs);
store.setPrefs({ ...defaults, sidebarVisible: true, sidebarTab: 'files', filesView: 'tree' });
initSidebar();
const rels = () => [...document.querySelectorAll('[role=treeitem][data-rel]')].map(row => row.dataset.rel);
const row = rel => [...document.querySelectorAll('[data-rel]')].find(item => item.dataset.rel === rel);
check('tree-supported-hides-csv-and-hidden', rels().includes('note.md') && rels().includes('README') && !rels().includes('data.csv') && !rels().includes('.private') && !rels().includes('.hidden.md'), rels());
check('tree-preserves-empty-assets-folders', rels().includes('empty') && rels().includes('assets'));
store.setPrefs({ treeFileFilterMode: 'all' });
check('tree-all-refilters-without-files-event', rels().includes('data.csv') && !rels().includes('.hidden.md'), rels());
store.setPrefs({ showHiddenFiles: true });
check('hidden-preference-live', rels().includes('.hidden.md') && rels().includes('.private'));
store.setPrefs({ treeFileFilterMode: 'custom', treeFileFilterPatterns: ['*.csv', '!**/draft-*.md'], showHiddenFiles: false });
row('nested').click();
check('custom-tree-adds-csv-excludes-supported', rels().includes('nested/data.csv') && !rels().includes('nested/draft-a.md') && rels().includes('nested/notes.md'), rels());
const filter = document.querySelector('.sidebar-filter'); filter.value = 'NESTED/DATA'; filter.dispatchEvent(new Event('input', { bubbles: true }));
check('file-filter-retains-ancestors', JSON.stringify(rels()) === JSON.stringify(['', 'nested', 'nested/data.csv']), rels());
filter.value = ''; filter.dispatchEvent(new Event('input', { bubbles: true }));
row('nested/data.csv').click();
check('custom-file-identity-opens-exact-path', opens.at(-1) === root + '/nested/data.csv', opens);
store.setPrefs({ filesView: 'list' });
const listed = () => [...document.querySelectorAll('.sidebar-file-row')].map(row => row.dataset.path.slice(root.length + 1));
check('library-independent-supported-filter', !listed().includes('data.csv') && listed().includes('nested/draft-a.md') && !listed().includes('deps/node_modules/notes.md'), listed());
store.setPrefs({ libraryFileFilterMode: 'custom', libraryFileFilterPatterns: ['*.png', '!**/draft-*.md'] });
check('library-live-custom-filters', listed().includes('assets/image.png') && !listed().includes('nested/draft-a.md') && !listed().includes('data.csv'), listed());
store.setPrefs({ defaultExtension: 'csv' });
check('new-default-extension-live-supported', listed().includes('data.csv'));
const list = document.querySelector('[role=listbox]'), listRows = [...list.querySelectorAll('[data-path]')];
listRows[0].focus(); listRows[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
check('library-end-key-roving-focus', document.activeElement === listRows.at(-1));
document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
check('library-enter-opens-focused-file', opens.at(-1) === listRows.at(-1).dataset.path);
store.setFiles(root, [{ name: 'implicit.csv', path: root + '/implicit/deep/implicit.csv', relativePath: 'implicit/deep/implicit.csv' }], []);
store.setPrefs({ filesView: 'tree', treeFileFilterMode: 'all' });
check('implicit-directory-inferred', !!row('implicit'));
row('implicit').click(); row('implicit/deep').click();
check('implicit-nested-file-visible', !!row('implicit/deep/implicit.csv'));

store.setFile('/synthetic-outline.md', 'synthetic-outline.md');
store.setOutline([{level:1,text:'A',pos:0},{level:2,text:'A1',pos:10},{level:3,text:'A11',pos:20},{level:2,text:'A2',pos:30},{level:1,text:'B',pos:40}]);
store.setPrefs({ sidebarTab: 'outline', collapsibleOutline: true });
const outlineRows = () => [...document.querySelectorAll('[data-outline-key]')];
const headings = () => outlineRows().map(row => row.getAttribute('aria-label'));
const heading = text => outlineRows().find(row => row.getAttribute('aria-label') === text);
const key = (element, value) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
check('outline-multiple-roots-start-collapsed', JSON.stringify(headings()) === JSON.stringify(['A', 'B']), headings());
heading('A').querySelector('button').click();
check('outline-disclosure-expands-only-direct-visible-children', JSON.stringify(headings()) === JSON.stringify(['A', 'A1', 'A2', 'B']) && jumps.length === 0, headings());
heading('A1').focus(); key(heading('A1'), 'ArrowRight');
check('outline-right-expands-child', headings().includes('A11'));
key(document.activeElement, 'ArrowRight');
check('outline-right-enters-child', document.activeElement === heading('A11'));
key(document.activeElement, 'ArrowLeft');
check('outline-left-to-parent', document.activeElement === heading('A1'));
key(document.activeElement, 'ArrowLeft');
check('outline-left-collapses-parent-keeps-focus', !headings().includes('A11') && document.activeElement === heading('A1'));
key(document.activeElement, 'Enter');
check('outline-label-locates-and-expands', jumps.at(-1) === 10 && headings().includes('A11'));
heading('A').querySelector('button').click();
store.setPrefs({ collapsibleOutline: false });
check('outline-flat-preference-reveals-all-live', headings().length === 5 && !document.querySelector('[data-outline-key][aria-expanded]') && !document.querySelector('.sidebar-outline-disclosure'));
check('outline-flat-preserves-heading-level-indent', heading('A11').style.paddingLeft === '36px' && heading('A11').dataset.pos === '20');
heading('A1').focus(); key(heading('A1'), 'ArrowDown'); key(document.activeElement, 'Enter');
check('outline-flat-down-enter-locates', jumps.at(-1) === 20);
store.setActiveHeadingPos(30);
check('outline-active-heading-updates', heading('A2').classList.contains('active') && heading('A2').getAttribute('aria-selected') === 'true');
store.setPrefs({ collapsibleOutline: true });
check('outline-collapse-state-retained-through-flat', JSON.stringify(headings()) === JSON.stringify(['A', 'B']), headings());
store.setActiveHeadingPos(20);
check('outline-collapsed-active-child-highlights-visible-ancestor', heading('A').classList.contains('active') && heading('A').getAttribute('aria-selected') === 'true');
store.setFile('/synthetic-single-outline.md', 'synthetic-single-outline.md');
store.setOutline([{ level: 1, text: 'Only', pos: 0 }, { level: 2, text: 'Child', pos: 10 }, { level: 3, text: 'Deep', pos: 20 }]);
check('outline-single-root-start-open-descendant-collapsed', JSON.stringify(headings()) === JSON.stringify(['Only', 'Child']), headings());
check('outline-has-no-unproven-visible-filter', !document.querySelector('.sidebar-outline input'));
console.log('FILE_PREFS_JS_JSON:' + JSON.stringify({ passed: checks.every(x => x.passed), checks }));
if (checks.some(x => !x.passed)) process.exitCode = 1;
`;
const banner = `const { JSDOM } = require('jsdom'); const dom = new JSDOM('<!doctype html><html><body><aside id="sidebar"><button class="sidebar-tab" data-tab="files">Files</button><button class="sidebar-tab" data-tab="outline">Outline</button><button id="sidebar-collapse"></button><div id="sidebar-content"></div><div id="sidebar-resizer"></div></aside></body></html>', {url:'https://synthetic.test/'}); for (const key of ['window','document','Node','Document','Element','HTMLElement','DocumentFragment','DOMParser','Event','CustomEvent','MutationObserver','localStorage']) globalThis[key]=key==='window'?dom.window:dom.window[key]; globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);`;
let js, native;
const output = resolve(cache, 'check.cjs'), executable = resolve(cache, 'native-check');
try {
  await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true,
    platform: 'node', format: 'cjs', external: ['jsdom'], loader: { '.css': 'empty' }, banner: { js: banner } });
  let stdout = '';
  try { stdout = execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 30000, env: { ...process.env, FILE_PREFS_VECTORS: JSON.stringify(vectors) } }); }
  catch (error) { stdout = error.stdout ?? ''; if (error.stderr) process.stderr.write(error.stderr); }
  const line = stdout.split('\n').find(row => row.startsWith('FILE_PREFS_JS_JSON:'));
  js = line ? JSON.parse(line.slice('FILE_PREFS_JS_JSON:'.length)) : { passed: false, checks: [], error: stdout.slice(-3000) };
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', resolve(cache, 'swift'),
    'native/FilePreferences.swift', 'native/FolderMonitor.swift', 'scripts/verify-file-preferences.swift', '-o', executable, '-framework', 'CoreServices'], { encoding: 'utf8', timeout: 120000 });
  try { stdout = execFileSync(executable, [vectorsPath], { encoding: 'utf8', timeout: 20000 }); }
  catch (error) { stdout = error.stdout ?? ''; if (error.stderr) process.stderr.write(error.stderr); }
  const nativeLine = stdout.split('\n').find(row => row.startsWith('FILE_PREFS_NATIVE_JSON:'));
  native = nativeLine ? JSON.parse(nativeLine.slice('FILE_PREFS_NATIVE_JSON:'.length)) : { passed: false, checks: [], error: stdout.slice(-3000) };
} catch (error) { if (!js) js = { passed: false, checks: [], error: String(error) }; native = { passed: false, checks: [], error: String(error) }; }
finally { await Promise.all([output, executable, vectorsPath].map(path => rm(path, { force: true }))); }
const sources = ['src/file-preferences.ts', 'src/ui/sidebar.ts', 'native/FilePreferences.swift', 'native/FolderMonitor.swift'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const total = js.checks.length + native.checks.length;
const passedCount = [...js.checks, ...native.checks].filter(row => row.passed).length;
const result = { generatedAt: new Date().toISOString(), command: 'node scripts/verify-file-preferences.mjs',
  scope: 'Actual shared TS functions and live sidebar DOM/events in isolated JSDOM; real Swift parsing, temporary-directory enumeration and FolderMonitor filter update. No GUI geometry or native App startup/save/drop execution claim.',
  sourceHashes, passed: js.passed && native.passed, total, passedCount, js, native,
  reference: 'evidence/file-preferences-source-reference.json',
  limitations: ['Independent fallback values do not prove macOS factory defaults.', 'App.swift launch/save/drop and Recent Documents wiring is owned and verified by the coordinator.', 'JSDOM verifies real product DOM and keyboard handlers, not WebKit pixels, native focus, IME or original keyboard parity.', 'Malformed glob patterns are ignored safely; installed source can throw a RegExp error for malformed classes.', 'Symlink/package traversal behavior is unchanged and has not been compared to every original filesystem case.'] };
await writeFile('evidence/file-preferences-verification.json', JSON.stringify(result, null, 2) + '\n');
console.log(`${result.passed ? 'PASS' : 'FAIL'} ${passedCount}/${total} file preferences`);
for (const part of [js, native]) { for (const check of part.checks.filter(row => !row.passed)) console.error(JSON.stringify(check)); if (part.error) console.error(part.error); }
if (!result.passed) process.exitCode = 1;
