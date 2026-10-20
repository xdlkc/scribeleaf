// Compare the actual exportPrepare renderer output with installed Typora CSS.
// A custom image font is an html root size, not the article/body font size.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const cli = process.env.AGENT_BROWSER ?? '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const session = process.env.TYPORA_QA_SESSION ?? 'typora-font-qa';
const evidence = process.env.TYPORA_FONT_EVIDENCE ?? 'evidence/image-font-browser-verification.json';
const dist = process.env.TYPORA_FONT_DIST ?? '.cache/export-settings-dist/editor';
const run = code => JSON.parse(execFileSync(cli, ['--session', session, 'eval', '--stdin'], {input:code, encoding:'utf8', timeout:45000}).trim());
const root = '/Applications/Typora.app/Contents/Resources/TypeMark';
const hashes = {};
function css(file, stack = []) {
  if (stack.includes(file)) throw new Error('Cyclic reference CSS import');
  const text = readFileSync(file, 'utf8');
  hashes[file] = createHash('sha256').update(text).digest('hex');
  return text.replace(/@import\s+["']([^"']+)["']\s*;/g, (_, name) => {
    const p = path.resolve(path.dirname(file), name);
    return p.startsWith(root + '/') && existsSync(p) ? css(p, [...stack, file]) : '';
  }).replace(/@include-when-export[^;]+;/g, '').replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (whole, _q, name) => {
    if (/^(data:|https?:|#)/i.test(name)) return whole;
    const p = path.resolve(path.dirname(file), decodeURIComponent(name.split(/[?#]/)[0]));
    if (!p.startsWith(root + '/') || !existsSync(p)) return whole;
    const bytes = readFileSync(p);
    hashes[p] = createHash('sha256').update(bytes).digest('hex');
    const mime = {'.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf'}[path.extname(p)] ?? 'application/octet-stream';
    return `url("data:${mime};base64,${bytes.toString('base64')}")`;
  });
}
const sample = `<h1 data-probe="h1">Image export heading</h1>
<p data-probe="p">Latin text and 中文 <strong>bold</strong> <code data-probe="code">inline_code()</code>.</p>
<pre class="md-fences" data-probe="pre">code_sample()</pre>
<table><thead><tr><th data-probe="th">Header</th></tr></thead><tbody><tr><td data-probe="td">Cell</td></tr></tbody></table>
<blockquote data-probe="quote"><p>Quote</p></blockquote>
<p data-probe="wrap">FONT_QA_LONG_UNBREAKABLE_LITERAL_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789</p>
<p><img data-probe="img" alt="fixed image" style="width:100px;height:20px" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZKAAAAAASUVORK5CYII="></p>`;
const props = ['font-size', 'line-height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom', 'border-top-width', 'overflow-wrap', 'word-break'];
const themes = ['github','gothic','night','newsprint','pixyll','whitey'];
const base = css(root + '/style/base.css');
const results = [];
const context = run('({userAgent:navigator.userAgent,url:location.href})');
for (const theme of themes) {
  const referenceCSS = base + css(root + '/style/themes/' + theme + '.css');
  for (const width of [320, 640, 1200]) {
  for (const custom of [false, true]) {
    const result = run(`(async()=>{
      const theme=${JSON.stringify(theme)}, custom=${custom}, width=${width};
      const old=window.webkit;
      window.__fontExportMessages=[];
      window.webkit={messageHandlers:{native:{postMessage:m=>window.__fontExportMessages.push(m)}}};
      window.typora.command('theme',theme);
      window.typora.command('load',{markdown:${JSON.stringify(sample)},path:'',name:'image-font.md'});
      window.typora.command('exportPrepare',{requestId:'font-probe',format:'image',identity:'font-probe',settings:{key:'image',type:'image',name:'Image',pandocPath:'',general:{},options:{type:'image',imageWidth:width,useThemeFontSize:custom?0:1,imageFontSize:24,exportTheme:theme}}});
      let message;
      for(let i=0;i<500;i++){message=window.__fontExportMessages.find(m=>m.type==='export');if(message)break;await new Promise(r=>setTimeout(r,10))}
      if(old===undefined)delete window.webkit;else window.webkit=old;
      delete window.__fontExportMessages;
      if(!message)throw new Error('No renderer export payload');
      const make=async html=>{const f=document.createElement('iframe');f.style.cssText='position:fixed;left:-10000px;top:0;width:'+width+'px;height:1600px;border:0;visibility:hidden';const loaded=new Promise((yes,no)=>{f.onload=yes;f.onerror=no});document.body.append(f);await loaded;const d=f.contentDocument;d.open();d.write(html);d.close();d.body.getBoundingClientRect();await d.fonts.ready;return f};
      const ref=await make('<!doctype html><html'+(custom?' style="font-size:24px!important"':'')+'><head><meta charset="utf-8"><style>'+${JSON.stringify(referenceCSS)}+'</style></head><body><div id="write">'+${JSON.stringify(sample)}+'</div></body></html>');
      const actual=await make(message.html);
      const checks=[];
      for(const name of ['p','h1','pre','code','th','td','quote','img']){
        const a=ref.contentDocument.querySelector('[data-probe="'+name+'"]');
        const b=actual.contentDocument.querySelector('[data-probe="'+name+'"]');
        if(!a||!b){checks.push({name,passed:false,missing:!a?'reference':'actual'});continue;}
        for(const property of name==='img'?[]:${JSON.stringify(props)}){
          const x=a.ownerDocument.defaultView.getComputedStyle(a).getPropertyValue(property),y=b.ownerDocument.defaultView.getComputedStyle(b).getPropertyValue(property);
          const equal=x===y||(/^-?[\\d.]+px$/.test(x)&&/^-?[\\d.]+px$/.test(y)&&Math.abs(parseFloat(x)-parseFloat(y))<.03);
          checks.push({name,property,reference:x,actual:y,passed:equal});
        }
        if(name==='img'){const x=a.getBoundingClientRect().width,y=b.getBoundingClientRect().width;checks.push({name,property:'fixed image width',reference:x,actual:y,passed:Math.abs(x-100)<.03&&Math.abs(y-100)<.03});}
      }
      const meta={referenceRoot:getComputedStyle(ref.contentDocument.documentElement).fontSize,actualRoot:getComputedStyle(actual.contentDocument.documentElement).fontSize,htmlHasScript:message.html.includes('<script>')};
      const aw=ref.contentDocument.querySelector('[data-probe="wrap"]'),bw=actual.contentDocument.querySelector('[data-probe="wrap"]');
      checks.push({name:'unbreakable literal paragraph',property:'wrap within content width',reference:[aw.scrollWidth,aw.clientWidth],actual:[bw.scrollWidth,bw.clientWidth],passed:aw.scrollWidth<=aw.clientWidth+1&&bw.scrollWidth<=bw.clientWidth+1});
      ref.remove();actual.remove();
      return {theme,width,custom,meta,checks,passed:checks.every(c=>c.passed)};
    })()`);
    results.push(result);
    console.log(`${result.passed?'PASS':'FAIL'} ${theme} ${width} ${custom?'root 24px':'theme font'}: ${result.checks.filter(c=>!c.passed).length} style differences`);
  }
  }
}
run("(()=>{window.typora.command('theme','github');return true})()");
const index = readFileSync(path.join(dist,'index.html'),'utf8');
const buildFiles = [...index.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(m=>path.join(dist,m[1]));
const buildHashes = Object.fromEntries(buildFiles.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
const passed = results.every(r=>r.passed);
writeFileSync(evidence, JSON.stringify({generatedAt:new Date().toISOString(),context,referenceHashes:hashes,buildHashes,results,passed,scope:'Actual exportPrepare renderer payload vs installed reference CSS, six themes in same Chromium at 320/640/1200 CSS px. Screen media. Root-font and selected typography/spacing checks, fixed 100px image. Not native PNG pixels or full-editor pixel parity.'},null,2)+'\n');
if(!passed)process.exitCode=1;
