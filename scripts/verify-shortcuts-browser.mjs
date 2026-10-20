import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const cli=process.env.AGENT_BROWSER||'/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const run=(...args)=>execFileSync(cli,['--session','typora-qa',...args],{encoding:'utf8',timeout:30000});
const evaluate=code=>JSON.parse(execFileSync(cli,['--session','typora-qa','eval','--stdin'],{input:code,encoding:'utf8',timeout:30000}));
const results=[];
const check=(name,code)=>{try{const detail=evaluate(code);results.push({name,passed:!!detail.ok,detail});}catch(e){results.push({name,passed:false,detail:e.message});}};
const load=(text,select=false)=>evaluate(`(()=>{window.typora.command('load',{markdown:${JSON.stringify(text)},name:'shortcuts.md'});const v=window.typora.editor;v.dispatch({selection:{anchor:0,head:${select?text.length:0}}});v.focus();return true})()`);
run('open',process.env.APP_URL||'http://127.0.0.1:5174');
run('wait','--fn','Boolean(window.typora?.editor)');
try {
  load('alpha',true);run('press','Control+`');
  check('Control backtick applies inline code',"({ok:window.typora.getMarkdown()==='`alpha`'})");
  load('alpha',true);run('press','Control+Shift+`');
  check('Control Shift backtick applies strikethrough',"({ok:window.typora.getMarkdown()==='~~alpha~~'})");
  load('alpha');run('press','Meta+Alt+r');
  check('Command Option R inserts a footnote',"({ok:/\\[\\^[^\\]]+\\]/.test(window.typora.getMarkdown())})");
  load('alpha');run('press','Meta+Alt+-');
  check('Command Option minus inserts a horizontal rule',"({ok:window.typora.getMarkdown().includes('---')})");
  load('alpha');run('press','Meta+Alt+f');
  check('Command Option F opens replacement',"({ok:!!document.querySelector('.cm-replace-row input')&&document.querySelector('.cm-replace-row').style.display!=='none'})");
  run('press','Escape');
  evaluate("(()=>{window.__shortcutMessages=[];window.__shortcutWebkit=window.webkit;window.webkit={messageHandlers:{native:{postMessage:m=>window.__shortcutMessages.push(m)}}};return true})()");
  load('save content');run('press','Meta+Alt+Shift+s');
  check('Command Option Shift S sends Save As',"({ok:window.__shortcutMessages.some(m=>m.type==='saveAs'&&m.markdown==='save content')})");
} catch(e){results.push({name:'Shortcut interaction',passed:false,detail:e.message});}
finally {evaluate("(()=>{if(window.__shortcutWebkit)window.webkit=window.__shortcutWebkit;else delete window.webkit;return true})()");}
writeFileSync('evidence/shortcut-verification.json',JSON.stringify({date:new Date().toISOString(),results},null,2));
for(const r of results)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}`);
if(results.some(r=>!r.passed))process.exitCode=1;
