import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve('.');
const work = await mkdtemp(join(tmpdir(), 'typora-image-preferences-'));
const suite = 'com.typora-replica.image-preferences-test.' + work.split('-').pop();
const env = { ...process.env, TYPORA_REPLICA_DEFAULTS_SUITE: suite };
const sources=['native/Clipboard.swift','native/ImagePreferences.swift','native/ExportSettings.swift','native/DocumentConversion.swift','scripts/verify-image-preferences.swift'];
const sourceHashes={};
const frozen=[];
for(const path of sources){const data=await readFile(path);sourceHashes[path]=createHash('sha256').update(data).digest('hex');const target=join(work,path.split('/').at(-1));await writeFile(target,data);frozen.push(target);}
try {
  await mkdir('.cache', { recursive: true });
  await writeFile(join(work, 'stub.swift'), `import Foundation\nimport AppKit\nfinal class MarkdownDocument:NSDocument { var markdown = ""; var messages:[[String:Any]]=[]; func send(_ name:String,_ payload:Any?=nil) { if name == "clipboardResult", let item=payload as? [String:Any] { messages.append(item) } } }\n`);
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', '-module-cache-path', resolve('.cache/swift'), '-target', execFileSync('uname',['-m'],{encoding:'utf8'}).trim()+'-apple-macosx13.0', join(work,'stub.swift'), ...frozen, '-o', join(work,'verify'), '-framework','AppKit','-framework','WebKit','-framework','UniformTypeIdentifiers'], {cwd:root,stdio:'inherit'});
  execFileSync(join(work,'verify'), [resolve('evidence/image-preferences-native-verification.json')], {cwd:root,env,stdio:'inherit'});
  const reportPath='evidence/image-preferences-native-verification.json';
  const report=JSON.parse(await readFile(reportPath,'utf8'));
  report.sourceHashes=sourceHashes;
  report.sourceMatchesCurrent=Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')===sourceHashes[path]])));
  if(Object.values(report.sourceMatchesCurrent).some(value=>!value)){report.passed=false;process.exitCode=1;}
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
} finally {
  try { execFileSync('/usr/bin/defaults',['delete',suite],{stdio:'ignore'}); } catch { /* domain may be memory-only under sandbox */ }
  await rm(work,{recursive:true,force:true});
}
