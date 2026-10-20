import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
const cli=process.env.AGENT_BROWSER||'/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const run=(...args)=>execFileSync(cli,['--session','gothic-qa',...args],{encoding:'utf8',timeout:30000});
const evaluate=code=>JSON.parse(execFileSync(cli,['--session','gothic-qa','eval','--stdin'],{input:code,encoding:'utf8',timeout:30000}));
const reference=JSON.parse(readFileSync('src/assets/fonts/gothic/STYLE-VERIFICATION.json')).reference;
const path='.cache/gothic-probe.html';
writeFileSync(path,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/styles/base.css?direct"><link rel="stylesheet" href="/src/themes/gothic.css?direct"><body data-theme="gothic"><article class="md-render"><h1>Heading</h1><h2>Heading</h2><h3>Heading</h3><h4>Heading</h4><h5>Heading</h5><h6>Heading</h6><p>Paragraph <a href="#">link</a> <code>inline code</code></p><blockquote><p>Quote</p></blockquote><pre><code>code</code></pre><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table></article></body>`);
const results=[];
try {
 run('open',(process.env.APP_URL||'http://127.0.0.1:5174')+'/.cache/gothic-probe.html');
 for(const width of [700,1200,1900]){
  run('set','viewport',String(width),'1000');
  const data=evaluate(`(async()=>{await Promise.all([...document.fonts].map(f=>f.load()));await document.fonts.ready;const keys=${JSON.stringify(reference[width].styles)};const styles={};for(const[tag,props]of Object.entries(keys)){const s=getComputedStyle(document.querySelector(tag));styles[tag]={};for(const k of Object.keys(props))styles[tag][k]=s[k];}return {styles,fonts:[...document.fonts].map(f=>({family:f.family,status:f.status}))}})()`);
  const differences=[];
  for(const[tag,props]of Object.entries(reference[width].styles))for(const[k,value]of Object.entries(props))if(data.styles[tag][k]!==value)differences.push({tag,property:k,expected:value,actual:data.styles[tag][k]});
  results.push({width,passed:differences.length===0&&data.fonts.length===6&&data.fonts.every(f=>f.status==='loaded'),differences,fonts:data.fonts});
 }
} finally {unlinkSync(path);}
writeFileSync('evidence/gothic-verification.json',JSON.stringify({scope:'HTML sample computed styles and font loading, not full editor pixel parity',results},null,2));
for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} Gothic ${r.width}px, ${r.differences.length} computed-style differences, ${r.fonts.length} fonts`);
if(results.some(r=>!r.passed))process.exitCode=1;
