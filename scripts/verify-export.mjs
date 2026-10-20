import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

await mkdir('.cache', {recursive: true});
const source = `
import {buildStandaloneHtml} from './src/export.ts';
import {readFileSync,writeFileSync} from 'node:fs';
void(async()=>{
 const tick=String.fromCharCode(96),slash=String.fromCharCode(92);
 const md=readFileSync('fixtures/acceptance.md','utf8').replace(/\x60\x60\x60mermaid[\\s\\S]*?\x60\x60\x60/g,'')+'\\n\\nOutside '+tick+'x|y'+tick+'\\n\\n| Case | Value |\\n| --- | --- |\\n| Existing | '+tick+'a'+slash+'|b'+tick+' |\\n\\nEXPORT_END_MARKER\\n';
 const html=await buildStandaloneHtml('A & B <draft>',md,'github');
 const gothic=await buildStandaloneHtml('Gothic',md,'gothic');
 const results={
  standaloneDocument:/<!doctype html>/i.test(html),
  escapedTitle:html.includes('<title>A &amp; B &lt;draft&gt;</title>'),
  heading:html.includes('A place for your thoughts'),
  tableCodePipe:html.includes('A simple comparison'),
  outsideCodePipe:html.includes('<code>x|y</code>'),
  escapedTableCodePipe:html.includes('<code>a|b</code>'),
  tasks:html.includes('type="checkbox"'),
  math:html.includes('<math'),
  footnotes:html.includes('Some thoughts belong in the margin.'),
  fullDocument:html.includes('EXPORT_END_MARKER'),
  embeddedFont:html.includes('data:font/woff2;base64,'),
  fontLicense:html.includes('SIL OPEN FONT LICENSE'),
  gothicFonts:gothic.includes('TeXGyreAdventor')&&gothic.includes('data:font/woff;base64,')&&!gothic.includes('../assets/fonts/gothic/'),
  gothicLicenses:gothic.includes('GUST Font License')&&gothic.includes('LaTeX Project Public License')&&gothic.includes('Didact Gothic')
 };
 writeFileSync('evidence/export.html',html);
 writeFileSync('evidence/export-gothic.html',gothic);
 writeFileSync('evidence/export-verification.json',JSON.stringify({results},null,2));
 for(const [name,ok] of Object.entries(results)) console.log((ok?'PASS ':'FAIL ')+name);
 if(Object.values(results).some(ok=>!ok))process.exitCode=1;
})();`;
await build({
  stdin: {contents: source, resolveDir: process.cwd(), loader: 'ts'},
  outfile: '.cache/export-check.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['mermaid'],
  plugins: [{name: 'inline-theme-css', setup(context) {
    context.onResolve({filter: /\?(inline|raw)$/}, args => {
      const clean = args.path.replace(/\?(inline|raw)$/, '');
      const path = clean.startsWith('.') ? resolve(args.resolveDir, clean) : require.resolve(clean, {paths: [args.resolveDir]});
      return {path, namespace: 'theme-css', pluginData: {raw: args.path.endsWith('?raw')}};
    });
    context.onLoad({filter: /.*/, namespace: 'theme-css'}, async args => {
      let contents = await readFile(args.path, 'utf8');
      if (!args.pluginData?.raw) for (const match of [...contents.matchAll(/url\(["']?([^"')]+)["']?\)/g)]) {
        if (/^(data:|https?:|#)/.test(match[1])) continue;
        const file = resolve(dirname(args.path), match[1].split(/[?#]/)[0]);
        const mime = {'.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf'}[extname(file)];
        if (mime) contents = contents.replace(match[0], `url("data:${mime};base64,${(await readFile(file)).toString('base64')}")`);
      }
      return {contents, loader: 'text'};
    });
  }}],
});
try { console.log(execFileSync(process.execPath, ['.cache/export-check.cjs'], {encoding:'utf8'})); }
catch(error) { if(error.stdout) console.log(error.stdout); process.exitCode=1; }
