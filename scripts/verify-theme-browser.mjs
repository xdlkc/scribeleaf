import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const cli=process.env.AGENT_BROWSER??'/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const session=process.env.TYPORA_QA_SESSION??'typora-final-qa';
const evaluate=code=>JSON.parse(execFileSync(cli,['--session',session,'eval','--stdin'],{input:code,encoding:'utf8',timeout:45000}).trim());
const root='/Applications/Typora.app/Contents/Resources/TypeMark';
const local=readFileSync('scripts/verify-theme-styles.mjs','utf8');
const sample=/const sample=`([^`]+)`;/.exec(local)?.[1];
if(!sample)throw new Error('Shared theme sample changed.');
const staticEvidence=JSON.parse(readFileSync('evidence/theme-styles-verification.json','utf8'));
const missingResources=[];
const referenceHashes={};
function css(file,stack=[]){
  if(stack.includes(file))throw new Error('Cyclic CSS import');
  const text=readFileSync(file,'utf8');
  referenceHashes[file]=createHash('sha256').update(text).digest('hex');
  return text.replace(/@import\s+["']([^"']+)["']\s*;/g,(_,name)=>{
    const p=path.resolve(path.dirname(file),name);return p.startsWith(root+'/')&&existsSync(p)?css(p,[...stack,file]):'';
  }).replace(/@include-when-export[^;]+;/g,'').replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,(whole,_quote,name)=>{
    if(/^(data:|https?:|#)/i.test(name))return whole;
    const filePath=path.resolve(path.dirname(file),decodeURIComponent(name.split(/[?#]/)[0]));
    if(!filePath.startsWith(root+'/')||!existsSync(filePath)){missingResources.push(filePath);return whole;}
    const mime={'.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.eot':'application/vnd.ms-fontobject','.svg':'image/svg+xml'}[path.extname(filePath)]??'application/octet-stream';
    const bytes=readFileSync(filePath);referenceHashes[filePath]=createHash('sha256').update(bytes).digest('hex');
    return `url("data:${mime};base64,${bytes.toString('base64')}")`;
  });
}
const base=css(root+'/style/base.css');
const results=[];
const fontResults=[];
const context=evaluate('({userAgent:navigator.userAgent,url:location.href})');
for(const theme of ['night','newsprint','pixyll','whitey']){
  const reference=base+css(root+'/style/themes/'+theme+'.css');
  const fonts=staticEvidence.results.find(g=>g.theme===theme).fonts;
  const prepared=evaluate(`(async()=>{
    window.typora.command('theme',${JSON.stringify(theme)});
    window.typora.command('load',{markdown:${JSON.stringify(sample)},path:'',name:'theme-browser.html'});
    const statuses=[];
    for(const face of ${JSON.stringify(fonts)}){
      const family=face.family.replace(/['"]/g,'');
      const loaded=await document.fonts.load(face.style+' '+face.weight+' 16px '+JSON.stringify(family),'Latin Font Check');
      statuses.push({family,style:face.style,weight:face.weight,count:loaded.length,loaded:loaded.length>0&&loaded.every(f=>f.status==='loaded')});
    }
    window.__themeBrowserHtml=await window.typora.renderHtml();
    return {theme:${JSON.stringify(theme)},fonts:statuses,editorFamily:getComputedStyle(document.querySelector('.cm-content')).fontFamily};
  })()`);
  fontResults.push(prepared);
  for(const width of [700,1200,1900]){
    const probes=staticEvidence.results.find(g=>g.theme===theme&&g.width===width).checks.filter(c=>c.surface==='HTML').map(c=>({sample:c.sample,property:c.property}));
    const result=evaluate(String.raw`(async()=>{
      const make=async html=>{const f=document.createElement('iframe');f.style.cssText='position:fixed;left:-10000px;top:0;width:${width}px;height:1600px;border:0;visibility:hidden';const done=new Promise((yes,no)=>{f.onload=yes;f.onerror=no});document.body.append(f);await done;const d=f.contentDocument;d.open();d.write(html);d.close();d.body.getBoundingClientRect();await d.fonts.ready;return f};
      const reference=await make('<!doctype html><meta charset="utf-8"><style>'+${JSON.stringify(reference)}+'</style><body><div id="write">'+${JSON.stringify(sample)}+'</div>');
      const replica=await make(window.__themeBrowserHtml);
      const normFamily=s=>s.toLowerCase().replace(/['"]/g,'').replace(/replica newsprint pt serif,?\s*/,'').replace(/replica pixyll merriweather,?\s*/,'').replace(/replica pixyll lato,?\s*/,'').replace(/\s*,\s*/g,',').replace(/\s+/g,' ').trim();
      const background=node=>{
        let red=0,green=0,blue=0,alpha=0;
        for(let n=node;n&&alpha<1;n=n.parentElement){const v=n.ownerDocument.defaultView.getComputedStyle(n).backgroundColor;const m=/^rgba?\(([^)]+)\)/.exec(v);if(!m)continue;const c=m[1].split(',').map(Number),a=c.length===4?c[3]:1;red+=c[0]*a*(1-alpha);green+=c[1]*a*(1-alpha);blue+=c[2]*a*(1-alpha);alpha+=a*(1-alpha)}
        return [red,green,blue].map(v=>Math.round(v+255*(1-alpha))).join(',');
      };
      const checks=[];
      for(const probe of ${JSON.stringify(probes)}){
        const a=probe.sample==='content width'?reference.contentDocument.querySelector('#write'):reference.contentDocument.querySelector('[data-probe="'+probe.sample+'"]');
        const b=probe.sample==='content width'?replica.contentDocument.querySelector('.md-render'):replica.contentDocument.querySelector('[data-probe="'+probe.sample+'"]');
        if(!a||!b){checks.push({...probe,passed:false,missing:!a?'reference':'replica'});continue;}
        let x=a.ownerDocument.defaultView.getComputedStyle(a).getPropertyValue(probe.property),y=b.ownerDocument.defaultView.getComputedStyle(b).getPropertyValue(probe.property);
        if(probe.property==='font-family'){x=normFamily(x);y=normFamily(y)}
        if(probe.property==='background-color'){x=background(a);y=background(b)}
        if(probe.property==='text-align'){if(x==='start')x='left';if(y==='start')y='left'}
        const passed=x===y||(/^-?[\d.]+px$/.test(x)&&/^-?[\d.]+px$/.test(y)&&Math.abs(parseFloat(x)-parseFloat(y))<.02);
        checks.push({...probe,reference:x,actual:y,passed});
      }
      reference.remove();replica.remove();
      return {theme:${JSON.stringify(theme)},width:${width},checks,passed:checks.every(c=>c.passed)};
    })()`);
    results.push(result);
    console.log(`${result.passed?'PASS':'FAIL'} ${theme} ${width}: ${result.checks.filter(c=>!c.passed).length} computed style differences`);
  }
}
evaluate(`(()=>{delete window.__themeBrowserHtml;window.typora.command('theme','github');return true})()`);
const passed=results.every(r=>r.passed)&&fontResults.every(r=>r.fonts.every(f=>f.loaded));
writeFileSync('evidence/theme-browser-verification.json',JSON.stringify({date:new Date().toISOString(),browserVerified:true,environment:'Real isolated Chromium via agent-browser; original CSS and actual exported HTML in same-browser iframes',context,referenceHashes,missingResources:[...new Set(missingResources)],results,fontResults,passed,limitations:['Selected computed typography/box declarations and font loads only; not a pixel comparison or full editor block spacing proof.','Reference and replica run in Chromium, not the original Typora WebKit view.','Background checks compare painted colors over ancestors; font aliases and LTR start/left alignment are normalized.','Only the displayed sample and requested Latin font faces are covered; platform CJK fallback is not proved.']},null,2)+'\n');
console.log('Packaged font face loads:',fontResults.flatMap(r=>r.fonts).filter(f=>f.loaded).length,'/',fontResults.flatMap(r=>r.fonts).length);
if(!passed)process.exitCode=1;
