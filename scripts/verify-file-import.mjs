import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const directory=await mkdtemp(join(tmpdir(),'typora-file-import-check-'));
const sources=['native/FileImport.swift','native/DocumentConversion.swift','native/ExportSettings.swift','scripts/verify-file-import.swift'];
const hashes={},frozen=[];
const pandoc=resolve('.cache/pandoc/pandoc-3.12.1-'+execFileSync('uname',['-m'],{encoding:'utf8'}).trim()+'/bin/pandoc');
try{
 await mkdir('.cache',{recursive:true});
 for(const path of sources){const data=await readFile(path);hashes[path]=createHash('sha256').update(data).digest('hex');const copy=join(directory,path.split('/').at(-1));await writeFile(copy,data);frozen.push(copy);}
 const executable=join(directory,'verify');
 await rm('evidence/file-import-verification.json',{force:true});
 execFileSync('xcrun',['swiftc','-swift-version','5','-parse-as-library','-module-cache-path',resolve('.cache/swift'),...frozen,'-o',executable,'-framework','AppKit','-framework','UniformTypeIdentifiers'],{stdio:'inherit'});
 let code=0;try{execFileSync(executable,[pandoc,resolve('evidence/file-import-verification.json'),join(directory,'fixtures')],{stdio:'inherit'})}catch(error){code=error.status??1;}
 const path='evidence/file-import-verification.json';let report;try{report=JSON.parse(await readFile(path,'utf8'));}catch{report={generatedAt:new Date().toISOString(),passed:false,checks:[],executionFailure:'Verifier did not complete or did not emit a report',exitCode:code};}report.sourceHashes=hashes;report.sourceMatchesCurrent=Object.fromEntries(await Promise.all(sources.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')===hashes[path]])));report.pandoc={path:pandoc,sha256:createHash('sha256').update(await readFile(pandoc)).digest('hex'),inputFormats:execFileSync(pandoc,['--list-input-formats'],{encoding:'utf8'}).trim().split('\n')};if(Object.values(report.sourceMatchesCurrent).some(value=>!value))report.passed=false;await writeFile(path,JSON.stringify(report,null,2)+'\n');if(code||!report.passed)process.exitCode=1;
}finally{await rm(directory,{recursive:true,force:true});}
