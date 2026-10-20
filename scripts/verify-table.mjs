#!/usr/bin/env node
// Pure-logic checks for the table editor module. DOM/IME/focus are not run here.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    if (detail && detail.ok === false) throw new Error(JSON.stringify(detail));
    results.push({ name, passed: true, detail: detail ?? true });
  } catch (error) {
    results.push({ name, passed: false, detail: String(error && error.stack ? error.stack : error) });
  }
}

const hook = resolve('/tmp/typora-table-css-hook.mjs');
writeFileSync(
  hook,
  `
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const ext of ['', '.ts', '.js', '.mjs']) {
      const candidate = resolvePath(base, specifier + ext);
      if (existsSync(candidate) && !candidate.endsWith('/')) {
        try {
          const { statSync } = await import('node:fs');
          if (statSync(candidate).isFile()) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        } catch {}
      }
    }
  }
  return nextResolve(specifier, context);
}
`,
);

register(pathToFileURL(hook).href, import.meta.url);

const tsPath = resolve(root, 'src/editor/table-editor.ts');
const sourceText = readFileSync(tsPath, 'utf8');

check('Module source exports required APIs', () => {
  const needed = [
    'export function createTableEditor',
    'export function updateTableEditor',
    'export function handleTableCommand',
    'export function parseMarkdownTable',
    'export function serializeMarkdownTable',
    'export function splitTableRow',
    'export function patchTableCell',
    'export function findTableInDocument',
    'export function destroyTableEditor',
  ];
  const missing = needed.filter((s) => !sourceText.includes(s));
  return { ok: missing.length === 0, missing };
});

check('Uses shared pipe helper and sanitizer', () => {
  return {
    ok:
      sourceText.includes('prepareMarkdownTables') &&
      sourceText.includes('DOMPurify') &&
      sourceText.includes("import type { WidgetContext }") &&
      sourceText.includes('compositionstart') &&
      sourceText.includes('compositionend'),
  };
});

const lib = await import(pathToFileURL(tsPath).href);

const {
  parseMarkdownTable,
  serializeMarkdownTable,
  splitTableRow,
  replaceCell,
  insertTableRow,
  deleteTableRow,
  insertTableColumn,
  deleteTableColumn,
  setTableAlignment,
  moveTableRow,
  moveTableColumn,
  patchTableCell,
  findTableInDocument,
  handleTableCommand,
} = lib;

check('splitTableRow keeps escaped pipes and code-span pipes', () => {
  const a = splitTableRow('| a \\| b | `c|d` | e |');
  const b = splitTableRow('a \\| b | `c|d` | e');
  return {
    ok: a.length === 3 && a[0].includes('\\|') && a[1].includes('`c|d`') && b.length === 3,
    a,
    b,
  };
});

const sample = `| Default | Left | Right | Center |
| ------- | :---- | ----: | :----: |
| cell1   | cell2 | cell3 | cell4 |`;

check('parse preserves alignment and raw cells', () => {
  const t = parseMarkdownTable(sample);
  return {
    ok:
      t &&
      t.header[0] === 'Default' &&
      t.alignments.join(',') === 'none,left,right,center' &&
      t.rows[0][0] === 'cell1' &&
      t.rows.length === 1 &&
      t.header.length === 4,
    t,
  };
});

check('cell edit patches only that cell; no-op same text', () => {
  const next = patchTableCell(sample, 1, 1, 'cell2');
  const edited = patchTableCell(sample, 1, 1, '改');
  const t = parseMarkdownTable(edited);
  return {
    ok: next === sample && t.rows[0][1] === '改' && edited.includes('Default') && edited.includes(':----:'),
    nextEqual: next === sample,
    edited,
  };
});

check('escaped/code pipes survive parse+cell replace of another cell', () => {
  const src = `| h1 | h2 |
| --- | --- |
| a \\| b | \`x|y\` |`;
  const t = parseMarkdownTable(src);
  const patched = patchTableCell(src, 1, 0, 'a \\| b');
  return {
    ok:
      t.rows[0][0].includes('\\|') &&
      t.rows[0][1].includes('`x|y`') &&
      patched === src &&
      parseMarkdownTable(src).rows[0][1] === t.rows[0][1],
    t,
  };
});

check('structural row/column/align/reorder', () => {
  let t = parseMarkdownTable(sample);
  t = insertTableRow(t, 1);
  t = replaceCell(t, 2, 0, 'row2');
  t = insertTableColumn(t, 1);
  t = setTableAlignment(t, 1, 'left');
  t = moveTableRow(t, 1, 0);
  t = moveTableColumn(t, 0, 1);
  const text = serializeMarkdownTable(t);
  const again = parseMarkdownTable(text);
  const tooSmall = deleteTableRow(deleteTableRow(again, 0), 0);
  const oneCol = deleteTableColumn(deleteTableColumn(deleteTableColumn(deleteTableColumn(again, 0), 0), 0), 0);
  return {
    ok:
      again.rows.length === 2 &&
      again.rows[0].includes('row2') &&
      again.alignments.includes('left') &&
      tooSmall.rows.length === 1 &&
      oneCol.header.length === 1 &&
      text.startsWith('|') &&
      !text.includes('Second Header'),
    text,
    rows: again.rows,
    cols: again.header.length,
  };
});

check('source outside the table is unchanged by find/patch', () => {
  const prefix = '# Title\n\nkeep me\n\n';
  const suffix = '\n\n## After\n\nparagraph\n';
  const doc = prefix + sample + suffix;
  const range = findTableInDocument(doc, prefix.length, sample);
  const moved = findTableInDocument('X' + doc, prefix.length, sample);
  const patched = patchTableCell(sample, 1, 0, 'cell1-new');
  const nextDoc = doc.slice(0, range.from) + patched + doc.slice(range.to);
  return {
    ok:
      range.from === prefix.length &&
      moved.from === prefix.length + 1 &&
      nextDoc.startsWith(prefix) &&
      nextDoc.endsWith(suffix) &&
      nextDoc.includes('cell1-new') &&
      !nextDoc.slice(0, range.from).includes('cell1-new'),
    range,
    moved,
  };
});

check('stale from is rejected when table text is gone', () => {
  const miss = findTableInDocument('# no table here', 0, sample);
  return { ok: miss === null };
});

check('ambiguous duplicate tables are not patched by stale from', () => {
  const doc = sample + '\n\n' + sample;
  const miss = findTableInDocument(doc, 99999, sample);
  const unique = findTableInDocument('X\n' + sample, 0, sample);
  return { ok: miss === null && unique !== null && unique.from === 2, miss, unique };
});

check('handleTableCommand is idle without table focus', () => {
  const prev = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    const r = handleTableCommand('bold');
    const r2 = handleTableCommand('heading1');
    return { ok: r === false && r2 === false };
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
});

mkdirSync(resolve(root, 'evidence'), { recursive: true });
writeFileSync(
  resolve(root, 'evidence/table-verification.json'),
  JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
);
console.log(results.map((x) => `${x.passed ? 'PASS' : 'FAIL'} ${x.name}`).join('\n'));
if (results.some((x) => !x.passed)) process.exitCode = 1;
