// Sequential UI driver. It never modifies the verifier's checks or app data.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const work=path.join(root,'.cache/export-settings-native-verifier');
const driver=path.join(root,'.cache/drive-export-settings-qa');
const app=path.join(work,'ExportSettingsVerifier.app');
const bundle=process.argv[2];
let pid=Number(process.argv[3]),stopped=false;
if(!/^com\.typora-replica\.export-settings-verifier\.[a-f0-9]{32}$/.test(bundle??'')||!Number.isInteger(pid)||pid<=0)throw new Error('Exact QA bundle and PID required');
const target=path.join(root,'evidence/export-settings-driver-run.json');
let report;
try {const old=JSON.parse(readFileSync(target,'utf8'));if(old.bundleIdentifier===bundle&&old.initialPID===pid)report=old}catch{}
report??={bundleIdentifier:bundle,initialPID:pid,startedAt:new Date().toISOString(),actions:[]};
if(report.error){(report.previousDriverErrors??=[]).push(report.error);delete report.error}
report.status='running';
const save=()=>writeFileSync(target,JSON.stringify(report,null,2)+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
process.on('SIGINT',()=>{stopped=true});
process.on('SIGTERM',()=>{stopped=true});
function state(){
  if(stopped)throw new Error('UI driver interrupted');
  const d=JSON.parse(readFileSync(path.join(work,'result.json'),'utf8'));
  if(d.bundleIdentifier!==bundle)throw new Error('QA bundle changed');
  const failed=d.checks.filter(c=>c.passed===false&&!c.pending);
  if(failed.length)throw new Error('Verifier failed: '+failed.map(c=>c.name).join(', '));
  return d;
}
function call(action,...args){
  const output=execFileSync(driver,[bundle,String(pid),action,...args],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:512*1024});
  if(action==='inspect-active')return JSON.parse(output);
  const entry={at:new Date().toISOString(),step:state().step,action,args,result:output.trim()};
  report.actions.push(entry);save();console.log(JSON.stringify(entry));
}
const fileNames={1:'styled.html',2:'plain.html',3:'image.png',4:'custom.pdf',5:'custom.docx',6:'custom.odt',7:'custom.epub',8:'custom.txt',13:'failure-target.txt',14:'repeat.pdf',15:'repeat-2.pdf'};
const performed=new Set(),started=new Map();
async function once(step,action,...args){
  const key=step+':'+action;
  if(performed.has(key))return false;
  call(action,...args);performed.add(key);return true;
}
try{
  save();
  while(true){
    const d=state();
    if(d.pid!==pid)throw new Error('Unexpected PID before restart');
    if(Array.from({length:16},(_,i)=>i).every(i=>d.completedStages.includes(i)))break;
    if(d.step<0||d.completedStages.includes(d.step)){
      await once(d.step+1,'next');await sleep(150);continue;
    }
    const step=d.step;
    if(!started.has(step))started.set(step,Date.now());
    if(Date.now()-started.get(step)>600000)throw new Error('UI driver watchdog: stage '+step);
    const ui=call('inspect-active');
    const titles=new Set(ui.filter(e=>e.role==='AXButton'&&e.enabled).map(e=>e.title));
    let acted=false;
    if(step===9&&['Open','Choose','打开','选择'].some(t=>titles.has(t)))acted=await once(step,'folder');
    else if(step===12&&['Cancel','取消'].some(t=>titles.has(t)))acted=await once(step,'cancel');
    else if(fileNames[step]&&['Save','保存'].some(t=>titles.has(t)))acted=await once(step,'save',fileNames[step]);
    else if(step===13&&['Replace','替换'].some(t=>titles.has(t)))acted=await once(step,'replace');
    else if(['OK','好','确定','Done','完成'].some(t=>titles.has(t))){
      if(![9,13].includes(step))throw new Error('Unexpected error dialog at stage '+step);
      acted=await once(step,'dismiss');
    }
    await sleep(acted?200:500);
  }
  if(state().status!=='restarting')call('restart');
  const exitDeadline=Date.now()+20000;
  while(Date.now()<exitDeadline){
    let alive=true;try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e}if(!alive)break;
    try{
      const ui=call('inspect-active');
      if(ui.some(e=>e.role==='AXButton'&&["Don’t Save","Don't Save","不保存"].includes(e.title)))call('discard');
    }catch(error){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')break;throw e}throw error}
    await sleep(100);
  }
  try{process.kill(pid,0);throw new Error('QA did not exit for restart')}catch(e){if(e.code!=='ESRCH')throw e}
  execFileSync('/usr/bin/open',['-n',app],{cwd:root,timeout:10000});
  const restartDeadline=Date.now()+60000;
  let done;
  while(Date.now()<restartDeadline){const d=state();if(d.pid!==pid&&d.restartVerified&&d.automaticScopePassed){done=d;break}await sleep(200)}
  if(!done)throw new Error('Restart verification did not finish');
  report.restartedPID=done.pid;report.completedStages=done.completedStages;report.status='native-stages-and-restart-passed';
  console.log('Native stages 0..15 and actual restart passed');
}catch(error){report.status='stopped';report.error=String(error.stack??error);console.error(report.error);process.exitCode=1}
finally{report.finishedAt=new Date().toISOString();save()}
