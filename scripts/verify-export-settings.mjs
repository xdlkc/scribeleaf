import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadTs(rel) {
  const src = readFileSync(path.join(root, rel), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel,
  });
  const dest = path.join(root, '.cache/export-settings-dist', rel.replace('src/', '').replace('.ts', '.mjs'));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, out.outputText.replace(/from '\.\/([^']+)'/g, "from './$1.mjs'"));
  return dest;
}

const modPath = loadTs('src/export-settings.ts');
const m = await import(modPath);

const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

const defaults = m.defaultExportSettings();
assert('version', defaults.version === 1);
assert('folder auto', defaults.general.exportFolder === '');
assert('pandoc empty', defaults.pandocPath === '');
assert('open loc false', defaults.general.openExportLocation === false);
assert('9 converters', defaults.customExport.length === 9);
assert('wiki key', defaults.customExport.some((e) => e.key === 'wiki' && e.type === 'wiki'));

let state = defaults;
state = m.addCustomExport(state, 'custom', 'Custom');
assert('unique custom', state.customExport.some((e) => e.type === 'custom'));
state = m.addCustomExport(state, 'docx', 'Word (.docx)');
assert('docx2', state.customExport.some((e) => e.key === 'docx1' || e.key.startsWith('docx')));
const keys = state.customExport.map((e) => e.key);
assert('unique keys', new Set(keys).size === keys.length);
state = m.renameCustomExport(state, 'docx1', 'Word copy');
state = m.moveCustomExport(state, 'rst', -1);
state = m.deleteCustomExport(state, 'opml');
assert('deleted opml', !state.customExport.some((e) => e.key === 'opml'));

const frozen = m.freezeEntry(state, 'pdf');
assert('freeze pdf', frozen && frozen.options && frozen.general);
const copy = m.deepClone(frozen);
copy.options.header = 'changed';
assert('deep freeze', frozen.options.header === '' && copy.options.header === 'changed');

const md = `---
title: 标题
author: 甲
typora-sidebar: true
header: H
unset-key: unset
---
# Hi
`;
const snap = m.freezeEntry(m.defaultExportSettings(), 'html');
snap.options.allowPerFileSetting = true;
const resolved = m.loadExportOption(snap, md);
assert('yaml title', resolved.options.title === '标题');
assert('sidebar bool', resolved.options.sidebar === true);
assert('project unknown', resolved.projectInjectionUnknown === true);

const pdfSnap = m.freezeEntry(m.defaultExportSettings(), 'pdf');
pdfSnap.options.allowPerFileSetting = true;
pdfSnap.options.appendBody = 'x';
const pdfR = m.loadExportOption(pdfSnap, '---\nappend-body: extra\n---\n');
assert('pdf userAppend', pdfR.options.userAppendBody === true);
assert('pdf keeps global append while suppressing per-file overlay', pdfR.options.appendBody === 'x');

const safe = m.sanitizePandocExtras('--toc-depth=3 --reference-doc "文档.docx"');
assert('keep toc', safe.args.includes('--toc-depth=3'));
assert('keep unicode', safe.args.includes('文档.docx'));
let rejected = false;
try { m.sanitizePandocExtras('-o /tmp/x'); } catch (error) { rejected = error.rejected?.includes('-o') === true; }
assert('reject -o', rejected);

const out = path.join(root, '.cache/export-settings-dist/export-settings-unit.json');
writeFileSync(out, JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
if (failures.length) {
  console.error(failures);
  process.exit(1);
}
console.log('export-settings unit ok', out);
