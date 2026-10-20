/** Reproducible reference CSS cascade and real DOM selector checks.
 * This is not a browser layout engine: it cannot prove pixels or font loading.
 * node scripts/verify-theme-styles.mjs [--fixtures]
 * --fixtures emits disposable standalone reference/replica pages in .cache.
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import postcss from 'postcss';
import {JSDOM} from 'jsdom';
const root=path.resolve(import.meta.dirname,'..');
const referenceRoot=process.env.TYPORA_THEME_REFERENCE||'/Applications/Typora.app/Contents/Resources/TypeMark/style/themes';
const themes=['night','newsprint','pixyll','whitey'];
const read=p=>readFileSync(p,'utf8');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const base=read(path.join(root,'src/styles/base.css'));
const tableCss=read(path.join(root,'src/editor/table-editor.css'));
const sourceBase=read(path.resolve(referenceRoot,'../base.css'));
const exportSource=read(path.join(root,'src/export.ts'));
const exportCss=/const CONTENT_CSS = `([\s\S]*?)`;/m.exec(exportSource)[1];
const ua=`html {font-size:16px;color:black;font-family:serif;line-height:normal;font-weight:400;font-style:normal;text-align:start;} body {font-size:1em;} h1,h2,h3,h4,h5,h6,th {font-weight:700;} p {margin:1em 0;} ul,ol{margin:1em 0;padding-left:40px;} pre,code{font-family:monospace;} pre{margin:1em 0;} blockquote{margin:1em 40px;} table{border-collapse:separate;} th,td{padding:1px;}`;
const sample=`<h1 data-probe="h1">Heading One</h1><h2 data-probe="h2">Heading Two</h2><h3 data-probe="h3">Heading Three</h3><h4 data-probe="h4">Heading Four</h4><h5 data-probe="h5">Heading Five</h5><h6 data-probe="h6">Heading Six</h6><p data-probe="p">Body 中文 <a data-probe="a" href="#sample">link</a> <code data-probe="code">inline</code></p><blockquote data-probe="blockquote"><p>Quoted words</p><p>Second quote paragraph</p></blockquote><ul data-probe="ul"><li data-probe="li">List item<ul><li>Nested item</li></ul></li><li>Second item</li></ul><ol data-probe="ol"><li>Numbered item</li></ol><pre class="md-fences" data-probe="pre">const answer = 42;</pre><table data-probe="table"><thead><tr><th data-probe="th">Header</th></tr></thead><tbody><tr><td data-probe="td">Cell</td></tr><tr><td data-probe="stripe">Stripe</td></tr></tbody></table>`;
const editorSample=sample.replace(/<h([1-6])([^>]*)>/g,'<div class="cm-line cm-header-$1"$2>').replace(/<\/h[1-6]>/g,'</div>').replace(/<p data-probe="p">/,'<div class="cm-line" data-probe="p">').replace(/<\/p>/,'</div>').replace(/<code data-probe="code">/,'<span class="cm-inline-code" data-probe="code">').replace(/<\/code>/,'</span>').replace(/<a data-probe="a"/,'<a class="cm-link" data-probe="a"').replace(/<blockquote[\s\S]*?<\/blockquote>/,'<div class="cm-line cm-quote" data-probe="blockquote">Quoted words</div><div class="cm-line cm-quote">Second quote line</div>').replace(/<ul data-probe="ul">[\s\S]*?<\/ul><\/li><li>Second item<\/li><\/ul>/,'<div class="cm-line cm-list-line" data-probe="li">• List item</div>').replace(/<ol data-probe="ol">[\s\S]*?<\/ol>/,'<div class="cm-line cm-list-line cm-ol-line">1. Numbered item</div>').replace(/<pre[^>]*data-probe="pre">([\s\S]*?)<\/pre>/,'<div class="cm-line cm-codeblock-line cm-codeblock-first cm-codeblock-last" data-probe="pre">$1</div>').replace(/<table data-probe="table">/,'<div class="lp-table lp-table-editor md-render"><table data-probe="table"><thead><tr class="lp-table-handle-row"><th class="lp-table-corner"></th><th class="lp-table-colhead"><span class="lp-col-handle"></span></th></tr></thead>').replace(/<(th|td) data-probe=/g,'<$1 class="lp-cell" data-probe=').replace(/<\/table>/,'</table></div>');
// Match the live table's shared thead and its zero-width row handles.
const editorFixture=editorSample.replace('</tr></thead><thead>','</tr>')
 .replace(/<tr><th class="lp-cell"/g,'<tr><td class="lp-row-handle"><span class="lp-row-grip"></span></td><th class="lp-cell"')
 .replace(/<tr><td class="lp-cell"/g,'<tr><td class="lp-row-handle"><span class="lp-row-grip"></span></td><td class="lp-cell"');
const split=s=>postcss.list.comma(s);
function specificity(selector){
 let total=[0,0,0],s=selector;
 s=s.replace(/:(is|not|has|where)\(/g,match=>match); // handled recursively below
 let out='';
 for(let i=0;i<s.length;i++){
  const f=/^:(is|not|has|where)\(/.exec(s.slice(i));
  if(!f){out+=s[i];continue;}
  let j=i+f[0].length,depth=1,start=j;
  for(;j<s.length&&depth;j++){if(s[j]==='(')depth++;if(s[j]===')')depth--;}
  if(f[1]!=='where'){
   const all=split(s.slice(start,j-1)).map(specificity).sort(compare);
   const max=all.at(-1)||[0,0,0];total=total.map((n,k)=>n+max[k]);
  }
  i=j-1;
 }
 out=out.replace(/\[[^\]]*\]/g,()=>{total[1]++;return '';});
 total[0]+=(out.match(/#[\w-]+/g)||[]).length;
 total[1]+=(out.match(/\.[\w-]+|:(?!:)[\w-]+(?:\([^)]*\))?/g)||[]).length;
 out=out.replace(/#[\w-]+|\.[\w-]+|::?[\w-]+(?:\([^)]*\))?/g,'');
 total[2]+=(out.match(/\b[a-zA-Z][\w-]*\b/g)||[]).length;
 return total;
}
function compare(a,b){for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;}
function mediaApplies(query,width){
 if(/\bprint\b/.test(query))return false;
 const tests=[...query.matchAll(/\((min|max)-width:\s*([\d.]+)(px|em)\)/g)];
 return tests.every(([,kind,n,unit])=>kind==='min'?width>=Number(n)*(unit==='em'?16:1):width<=Number(n)*(unit==='em'?16:1));
}
function expand(prop,value){
 const entries=[[prop,value]];
 if(['margin','padding'].includes(prop)){
  const a=postcss.list.space(value),v=[a[0],a[1]??a[0],a[2]??a[0],a[3]??a[1]??a[0]];
  ['top','right','bottom','left'].forEach((side,i)=>entries.push([prop+'-'+side,v[i]]));
 }
 if(/^border(?:-(?:top|right|bottom|left))?$/.test(prop)){
  const a=postcss.list.space(value),style=a.find(s=>/^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(s))||'none';
  const width=style==='none'||style==='hidden'?'0':a.find(s=>/^(?:[\d.]+(?:px|em|rem)?|thin|medium|thick)$/.test(s))||'medium';
  const color=a.find(s=>/^#|^rgb|^hsl|^(?:transparent|currentColor|gray|grey|white|black)$/i.test(s))||'currentColor';
  for(const side of prop==='border'?['top','right','bottom','left']:[prop.slice(7)])entries.push(['border-'+side+'-width',width],['border-'+side+'-style',style],['border-'+side+'-color',color]);
 }
 if(prop==='background'&&!/gradient|url\(/i.test(value))entries.push(['background-color',value]);
 return entries;
}
function declarations(css,width){
 const rows=[];let order=0;
 function walk(parent,active=true){for(const node of parent.nodes||[]){
  if(node.type==='atrule'){if(node.name==='media')walk(node,active&&mediaApplies(node.params,width));continue;}
  if(node.type!=='rule'||!active)continue;
  for(const selector of node.selectors){if(selector.includes('::')||/:(?:before|after)\b/.test(selector))continue;
   for(const decl of node.nodes||[])if(decl.type==='decl')for(const [prop,value] of expand(decl.prop,decl.value))rows.push({selector,spec:specificity(selector),prop,value,important:decl.important?1:0,order:order++});
  }
 }}walk(postcss.parse(css));return rows;
}
const inherited=new Set(['color','font-family','font-size','font-weight','font-style','line-height','text-align','letter-spacing','text-transform']);
function engine(doc,css,width){
 const rows=declarations(css,width),cache=new WeakMap();
 const raw=node=>{if(cache.has(node))return cache.get(node);const map={};for(const r of rows){let matches=false;try{matches=node.matches(r.selector)}catch{}if(!matches)continue;const prev=map[r.prop];if(!prev||compare([r.important,...r.spec,r.order],[prev.important,...prev.spec,prev.order])>=0)map[r.prop]=r;}cache.set(node,map);return map;};
 function variable(node,key){const value=raw(node)[key]?.value;if(value!==undefined)return value;return node.parentElement?variable(node.parentElement,key):'';}
 function value(node,key){let v=raw(node)[key]?.value;if(v===undefined||v==='inherit'){return inherited.has(key)&&node.parentElement?value(node.parentElement,key):'';}return v.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,(_,key,fallback)=>variable(node,key)||fallback||'');}
 function resolvedValue(node,key){let v=value(node,key);for(let i=0;i<5&&v.includes('var(');i++)v=v.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,(_,key,fallback)=>variable(node,key)||fallback||'');return v;}
 function fs(node){const token=raw(node)['font-size']?.value;if(!token||token==='inherit')return node.parentElement?fs(node.parentElement):16;const v=resolvedValue(node,'font-size');return length(node,v,true);}
 function length(node,v,font=false){const product=/^calc\(\s*(-?[\d.]+(?:px|rem|em|%))\s*\*\s*(-?[\d.]+)\s*\)$/.exec(v.trim());if(product)return length(node,product[1],font)*Number(product[2]);const m=/^(-?[\d.]+)(px|rem|em|%)?$/.exec(v.trim());if(!m)return v==='normal'?null:NaN;const n=Number(m[1]);if(m[2]==='rem')return n*(node===doc.documentElement?16:fs(doc.documentElement));if(m[2]==='em')return n*(font?(node.parentElement?fs(node.parentElement):16):fs(node));if(m[2]==='%')return n/100*(node.parentElement?fs(node.parentElement):16);return n;}
 function lineToken(node){const own=raw(node)['line-height']?.value;if(!own||own==='inherit')return node.parentElement?lineToken(node.parentElement):{unitless:1.2};const v=resolvedValue(node,'line-height');if(/^[\d.]+$/.test(v))return {unitless:Number(v)};return {px:length(node,v)};}
 function prop(node,key){
  if(key==='font-size')return round(fs(node));
  if(key==='line-height'){const v=lineToken(node);return round(v.px??v.unitless*fs(node));}
  let v=resolvedValue(node,key);
  if(/^(margin|padding)-(top|right|bottom|left)$|^border-(top|right|bottom|left)-width$|^max-width$/.test(key)){
   if(!v)return key==='max-width'?'none':0;
   return /^(?:auto|none|\d+ch|\d+%)$/.test(v)?v:round(length(node,v));
  }
  if(key==='background-color'&&(!v||v==='transparent'||v==='inherit'))return node.parentElement?prop(node.parentElement,key):'transparent';
  if(key==='font-weight')return v==='bold'?'700':v==='normal'?'400':v;
  if(key==='text-align'&&(!v||v==='start'))return 'left';
  if(/color$/.test(key)){v=v.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,'#$1$1$2$2$3$3').replace(/^white$/i,'#ffffff').replace(/^black$/i,'#000000');}
  v=v.replace(/(?<=[(, ])\.(\d+)/g,'0.$1');return v.toLowerCase().replaceAll('"','').replaceAll("'",'').replace(/\s+/g,' ').trim();
 }
 return {raw,prop,length,fs};
}
const round=x=>Number.isFinite(x)?Math.round(x*1e5)/1e5:String(x);
const normalizeFamily=s=>s.replace(/\s*,\s*/g,',').replace(/replica newsprint pt serif,?\s*/,'').replace(/replica pixyll merriweather,?\s*/,'').replace(/replica pixyll lato,?\s*/,'');
const report={scope:'Reference CSS cascade plus JSDOM selector verification at desktop/narrow widths; not a browser layout engine, pixel comparison, native app check or actual font-load test.',referenceRoot,referenceBaseSha256:digest(path.resolve(referenceRoot,'../base.css')),viewportWidths:[700,1200,1900],results:[],limitations:['Paragraph groups, source blank lines, nested lists and multiline quotes use CM line structures. Full block spacing cannot be proved by a static sample.','Pixyll reference root inherits 14px from original base.css; localized CSS variables preserve that default without changing the editor global root. Custom export root sizes have separate real-browser evidence.','Whitey reference provides no Vollkorn font resource. The existing Vollkorn → Palatino → Times system stack is preserved; availability is not proved.','Only Latin subsets of PT Serif/Merriweather/Lato are packaged. CJK and unsupported glyphs still use system fallback.','This script does not run a browser. Separate real computed-style and font-load results are recorded by scripts/verify-theme-browser.mjs; use that result for browser verification.'],verificationMethod:'Node/PostCSS and JSDOM selector checks; no model call in this verifier'};
report.fontIntegrity=[];
for(const theme of ['newsprint','pixyll']){
 const manifest=JSON.parse(read(path.join(root,'public/licenses',theme,'FONT-SOURCES.json')));
 for(const font of manifest.fonts){
  const file=path.resolve(root,font.file),data=readFileSync(file),source=readFileSync(font.source);
  const passed=data.equals(source)&&digest(file)===font.sha256&&['wOFF','wOF2'].includes(data.toString('ascii',0,4));
  report.fontIntegrity.push({file:font.file,source:font.source,sha256:font.sha256,passed});
 }
 for(const license of manifest.licenses){
  const text=read(path.join(root,'public/licenses',theme,license.file));
  if(![license.copyright,'SIL OPEN FONT LICENSE Version 1.1','PERMISSION & CONDITIONS','TERMINATION','DISCLAIMER'].every(v=>text.includes(v)))throw Error('Incomplete license: '+license.file);
 }
}
let failures=0;
for(const theme of themes){
 const themeCss=read(path.join(root,'src/themes',theme+'.css')),refCss=read(path.join(referenceRoot,theme+'.css'));
 const ast=postcss.parse(themeCss),unscoped=[];
 ast.walkRules(r=>{if(r.parent.type==='atrule'&&r.parent.name==='font-face')return;for(const s of r.selectors)if(!s.startsWith(`body[data-theme="${theme}"]`))unscoped.push(s);});
 const faces=[];ast.walkAtRules('font-face',r=>{const ds=Object.fromEntries(r.nodes.filter(n=>n.type==='decl').map(n=>[n.prop,n.value]));const rel=/url\("([^"]+)"\)/.exec(ds.src)[1];const f=path.resolve(root,'src/themes',rel);faces.push({family:ds['font-family'],style:ds['font-style'],weight:ds['font-weight'],file:path.relative(root,f),exists:existsSync(f),sha256:existsSync(f)?digest(f):null});});
 for(const width of report.viewportWidths){
  const referenceDoc=new JSDOM(`<html><body><div id="write">${sample}</div></body></html>`).window.document;
  const htmlDoc=new JSDOM(`<html><body data-theme="${theme}"><article class="md-render">${sample}</article></body></html>`).window.document;
  const editorDoc=new JSDOM(`<html style="--editor-font-size:16px"><body data-theme="${theme}"><div id="editor"><div class="cm-scroller"><div class="cm-content">${editorFixture}</div></div></div></body></html>`).window.document;
  const ref=engine(referenceDoc,ua+sourceBase+refCss,width),html=engine(htmlDoc,ua+exportCss+themeCss,width),editor=engine(editorDoc,ua+base+tableCss+themeCss,width);
  const checks=[],differences=[];
  for(const tag of ['h1','h2','h3','h4','h5','h6','p','code','pre','blockquote','ul','ol','li','table','th','td','stripe','a']){
   const source=referenceDoc.querySelector(`[data-probe="${tag}"]`),replica=htmlDoc.querySelector(`[data-probe="${tag}"]`),live=editorDoc.querySelector(`[data-probe="${tag}"]`);
   const props=['font-family','font-size','font-weight','font-style','color'];
   if(tag!=='code')props.push('line-height');
   if(tag==='a')props.push('text-decoration');
   if(/^h[1-6]$/.test(tag)||['p','blockquote','pre','table','ul','ol'].includes(tag))for(const side of ['top','right','bottom','left'])props.push('margin-'+side);
   if(/^h[1-6]$/.test(tag)||['blockquote','pre','code','th','td','stripe','ul','ol'].includes(tag))for(const side of ['top','right','bottom','left'])props.push('padding-'+side);
   if(['pre','blockquote','th','td','stripe'].includes(tag))for(const side of ['top','right','bottom','left'])props.push('border-'+side+'-width');
   if(['h1','h2','h3','h4','h5','h6','p','code','pre','table'].includes(tag))props.push('text-align');
   if(['p','code','pre','blockquote','th','td','stripe'].includes(tag))props.push('background-color');
   for(const property of props){let expected=ref.prop(source,property),actual=html.prop(replica,property);if(property==='font-family'){expected=normalizeFamily(expected);actual=normalizeFamily(actual);}const match=typeof expected==='number'?Math.abs(expected-actual)<.002:expected===actual;const c={surface:'HTML',sample:tag,property,reference:expected,actual,passed:match};checks.push(c);if(!match)differences.push(c);
    // A single CM code line cannot model block margins, blank source lines or
    // margin collapse. Keep HTML margins checked; assess editor block spacing
    // with real editor layout, rather than treating this fixture as that proof.
    if(live&&tag!=='ul'&&tag!=='ol'&&tag!=='blockquote'&&!(['p','pre'].includes(tag)&&/^margin-/.test(property))){
     let actual=editor.prop(live,property);if(property==='font-family')actual=normalizeFamily(actual);
     // CodeMirror has line containers instead of HTML headings/paragraphs.
     const same=typeof expected==='number'?Math.abs(expected-actual)<.002:expected===actual;const c={surface:'CM fixture',sample:tag,property,reference:expected,actual,passed:same};checks.push(c);if(!same)differences.push(c);
    }
   }
  }
  for(const property of ['font-family','font-size','font-weight','font-style','color','line-height']){
   const source=referenceDoc.querySelector('blockquote p'),live=editorDoc.querySelector('[data-probe="blockquote"]');
   let expected=ref.prop(source,property),actual=editor.prop(live,property);
   if(property==='font-family'){expected=normalizeFamily(expected);actual=normalizeFamily(actual);}
   const passed=typeof expected==='number'?Math.abs(expected-actual)<.002:expected===actual;
   const c={surface:'CM quote line',sample:'blockquote paragraph',property,reference:expected,actual,passed};checks.push(c);if(!passed)differences.push(c);
  }
  for(const [surface,doc,eng,selector] of [['HTML',htmlDoc,html,'.md-render:not(.lp-table)'],['CM fixture',editorDoc,editor,'#editor .cm-content']]){
   const expected=ref.prop(referenceDoc.querySelector('#write'),'max-width'),actual=eng.prop(doc.querySelector(selector),'max-width');
   const passed=typeof expected==='number'?Math.abs(expected-actual)<.002:expected===actual;
   const c={surface,sample:'content width',property:'max-width',reference:expected,actual,passed};checks.push(c);if(!passed)differences.push(c);
  }
  const handles=[...editorDoc.querySelectorAll('.lp-table-colhead,.lp-table-corner,.lp-row-handle')].map(n=>({className:n.className,padding:editor.prop(n,'padding'),border:editor.prop(n,'border')}));
  for(const handle of handles){const passed=handle.padding==='0'&&['none','0'].includes(handle.border);if(!passed)differences.push({surface:'CM fixture',sample:handle.className,property:'handle box',actual:handle,passed});}
  const themeRules=declarations(themeCss,width);
  const foreignDoc=new JSDOM(`<body data-theme="github"><article class="md-render">${sample}</article></body>`).window.document;
  const leaks=themeRules.filter(r=>[...foreignDoc.querySelectorAll('*')].some(n=>{try{return n.matches(r.selector)}catch{return false}})).map(r=>r.selector);
  const result={theme,width,passed:!differences.length&&!unscoped.length&&!leaks.length&&faces.every(f=>f.exists),referenceCssSha256:digest(path.join(referenceRoot,theme+'.css')),themeCssSha256:digest(path.join(root,'src/themes',theme+'.css')),checks,differences,unscopedRules:unscoped,foreignThemeMatchingRules:[...new Set(leaks)],tableHandles:handles,fonts:faces};
  report.results.push(result);if(!result.passed)failures++;console.log(`${result.passed?'PASS':'FAIL'} ${theme} ${width}px: ${checks.length} selected declarations, ${differences.length} differences, ${faces.length} font files`);
 }
}
report.summary={passed:failures===0&&report.fontIntegrity.every(f=>f.passed),groups:report.results.length,failedGroups:failures,checks:report.results.reduce((n,r)=>n+r.checks.length,0),differences:report.results.reduce((n,r)=>n+r.differences.length,0),packagedFonts:report.fontIntegrity.length};
mkdirSync(path.join(root,'evidence'),{recursive:true});writeFileSync(path.join(root,'evidence/theme-styles-verification.json'),JSON.stringify(report,null,2)+'\n');
if(process.argv.includes('--fixtures')){
 const dir=path.join(root,'.cache/theme-style-probes');mkdirSync(dir,{recursive:true});
 for(const theme of themes){
  const referenceCss=read(path.join(referenceRoot,theme+'.css')).replace(/@include-when-export[^;]+;/g,'').replace(/@import[^;]+;/g,'').replace(/url\(['"]?\.\/([^)'" ]+)['"]?\)/g,(_,p)=>`url("/src/assets/fonts/${p}")`);
  writeFileSync(path.join(dir,theme+'-reference.html'),`<!doctype html><meta charset="utf-8"><title>${theme} reference sample</title><style>${sourceBase}</style><style>${referenceCss}</style><body><div id="write">${sample}</div>`);
  writeFileSync(path.join(dir,theme+'-html.html'),`<!doctype html><meta charset="utf-8"><title>${theme} HTML sample</title><style>${exportCss}</style><link rel="stylesheet" href="/src/themes/${theme}.css?direct"><body data-theme="${theme}"><article class="md-render">${sample}</article>`);
  writeFileSync(path.join(dir,theme+'-editor.html'),`<!doctype html><meta charset="utf-8"><title>${theme} CM fixture sample</title><link rel="stylesheet" href="/src/styles/base.css?direct"><link rel="stylesheet" href="/src/editor/table-editor.css?direct"><link rel="stylesheet" href="/src/themes/${theme}.css?direct"><body data-theme="${theme}"><div id="editor"><div class="cm-scroller"><div class="cm-content">${editorFixture}</div></div></div>`);
 }
 console.log('Wrote disposable pages under .cache/theme-style-probes; these are fixtures, not proof of browser verification.');
}
if(!report.summary.passed)process.exitCode=1;
