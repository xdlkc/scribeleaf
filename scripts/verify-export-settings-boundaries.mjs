// Focused counterexamples for immutable settings, YAML precedence and argv.
// This test does not claim native UI or actual conversion coverage.
import {build} from 'esbuild';
import {writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const bundle=resolve('.cache/export-settings-boundaries.mjs');
await build({entryPoints:['src/export-settings.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm'});
const model=await import(pathToFileURL(bundle).href),checks=[];
const check=(name,condition,detail)=>checks.push({name,passed:!!condition,...(detail===undefined?{}:{detail})});
try{
  const state=model.defaultExportSettings();
  const fixed=['general','pdf','html','html-plain','image'];
  check('Adding a PDF preset cannot reuse a fixed tab identity',!fixed.includes(model.uniqueCustomKey('pdf',state.customExport)));
  const normalized=model.normalizeExportSettings({customExport:[{key:'pdf',type:'pdf',name:'collision'},{key:'docx',type:'docx',name:'one'},{key:'docx',type:'docx',name:'two'}]});
  const ids=normalized.customExport.map(e=>e.key);
  check('Imported/corrupt settings cannot collide with fixed tabs or another entry',new Set(ids).size===ids.length&&!ids.some(id=>fixed.includes(id)),ids);
  state.formats.pdf={header:'Foo',appendBody:'<p>GLOBAL_APPEND</p>',allowPerFileSetting:true,'paper.custom':[148,210]};
  const frozen=model.freezeEntry(state,'pdf');
  const bar=model.loadExportOption(frozen,'---\nheader: Bar\n---\n\n# First\n');
  check('Current YAML overrides frozen base for one invocation',bar.options.header==='Bar');
  state.formats.pdf.header='Changed global';
  const removed=model.loadExportOption(frozen,'# YAML header removed\n');
  check('Removing YAML Bar returns to frozen base Foo, not old effective Bar or new global',removed.options.header==='Foo',removed.options.header);
  state.formats.pdf['paper.custom'][0]=999;
  check('Frozen nested paper arrays cannot alias mutable settings',frozen.options['paper.custom'][0]===148,frozen.options['paper.custom']);
  const pdf=model.loadExportOption(frozen,'---\nappend-body: LOCAL_APPEND\n---\n\n# PDF\n');
  check('PDF removes only YAML append overlay and retains global appendBody',pdf.options.appendBody==='<p>GLOBAL_APPEND</p>'&&pdf.options.userAppendBody===true,pdf.options);
  const noLocal={...frozen,options:{...frozen.options,allowPerFileSetting:false}};
  const blocked=model.loadExportOption(noLocal,'---\nheader: Forbidden\ntitle: Allowed title\n---\n\nBody\n');
  check('YAML toggle blocks extended keys while base metadata remains active',blocked.options.header==='Foo'&&blocked.options.title==='Allowed title');
  const html=model.freezeEntry(model.patchFormat(state,'html','sidebar',true),'html');html.options.allowPerFileSetting=true;
  const truthy=model.loadExportOption(html,'---\ntypora-sidebar: false\nsidebar: true\n---\n\n# Header\n');
  check('Prefixed false follows original truthy fallback to ordinary true',truthy.options.sidebar===true,truthy.options.sidebar);
  const unset=model.loadExportOption(frozen,'---\nheader: unset\n---\n\nBody\n');
  check('Unset falls through to frozen base header',unset.options.header==='Foo');
  const capitalized=model.loadExportOption(frozen,'---\nHeader: Bar\n---\nBody');
  check('Lowercase base truthy value precedes capitalized YAML fallback',capitalized.options.header==='Foo',capitalized.options.header);
  const noHeader={...frozen,options:{...frozen.options,header:''}};
  check('Capitalized YAML applies when earlier base is empty',model.loadExportOption(noHeader,'---\nHeader: Bar\n---\nBody').options.header==='Bar');
  check('Arbitrary uppercase YAML spelling is not silently casefolded',model.loadExportOption(noHeader,'---\nHEADER: Bar\n---\nBody').options.header==='');
  const quoted=model.extractYamlFrontMatter('---\nname: &n 张三\nauthor: [*n, 李四]\nheader: |\n  First: line\n  中文\n---\n\n# Body\n');
  check('Standard YAML handles aliases, flow lists and block scalars',quoted.yaml.author?.join('|')==='张三|李四'&&quoted.yaml.header?.includes('First: line\n中文'));
  const tag=model.extractYamlFrontMatter('---\ntitle: !!js/function >\n  function(){throw new Error("must never execute")}\n---\nBody\n');
  check('Custom executable YAML tags never become callable values',typeof tag.yaml.title!=='function');
  for(const input of ['-o/tmp/source.md','--output=/tmp/source.md','-o /tmp/source.md','--log=/tmp/source.md','--out=/tmp/source.md','--lo=/tmp/source.md','--defaults=unsafe.yaml']){
    let rejected=false,detail;
    try{const parsed=model.sanitizePandocExtras(input);rejected=parsed.rejected.length>0&&!parsed.args.some(a=>a.includes('/tmp/source.md'));detail=parsed;}
    catch(error){rejected=true;detail=String(error);}
    check('Pandoc extras cannot bypass controlled target: '+input,rejected,detail);
  }
  check('Quoted Unicode resource paths stay one argv element',JSON.stringify(model.splitArgv('--css "/tmp/资源 #100%.css"'))===JSON.stringify(['--css','/tmp/资源 #100%.css']));
  const escaped=model.splitArgv('--css /tmp/a\\ b.css');
  check('Unquoted escaped spaces retain one argv path',JSON.stringify(escaped)===JSON.stringify(['--css','/tmp/a b.css']),escaped);
  const backslash=model.splitArgv('--css "/tmp/a\\b.css"');
  check('Backslash before ordinary character in double quotes is preserved',backslash[1]==='/tmp/a\\b.css',backslash);
  let malformed=false;try{model.splitArgv('--css "unterminated');}catch{malformed=true;}
  check('Unterminated argument quotes produce a clear error',malformed);
  const menu=model.exportMenuItems(model.addCustomExport(model.defaultExportSettings(),'docx','QA renamed'));
  check('Generated custom IDs and menu ordering agree',menu.at(-1).label==='QA renamed-1'&&menu.at(-1).key==='docx1');
  const importedEntry=model.defaultExportSettings();
  importedEntry.customExport[0]['reference-doc']='old.docx';
  check('Entry options populate preferences before editing',model.formatOptions(importedEntry,'docx')['reference-doc']==='old.docx');
  const editedEntry=model.patchFormat(importedEntry,'docx','reference-doc','new.docx');
  check('Explicit preferences edit overrides legacy entry options',model.freezeEntry(editedEntry,'docx').options['reference-doc']==='new.docx');
  const inherited=model.defaultExportSettings();inherited.general.openExportLocation=true;
  const inheritSnap=model.freezeEntry(inherited,'html');
  check('Absent per-format folder flag inherits General true',model.afterExportActions(inheritSnap.options,inheritSnap.general).openExportLocation===true);
  const explicit=model.freezeEntry(model.patchFormat(inherited,'html','openExportLocation',false),'html');
  check('Explicit per-format false overrides General true',model.afterExportActions(explicit.options,explicit.general).openExportLocation===false);
}finally{rmSync(bundle,{force:true});}
const passed=checks.every(c=>c.passed);writeFileSync('evidence/export-settings-boundaries-verification.json',JSON.stringify({generatedAt:new Date().toISOString(),scope:'Focused TypeScript model counterexamples; no native/UI/format conversion claim',passed,checks},null,2)+'\n');
for(const c of checks)console.log(`${c.passed?'PASS':'FAIL'} ${c.name}`);if(!passed)process.exitCode=1;
