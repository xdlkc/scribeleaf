import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

// This suite uses a private browser session and synthetic file metadata. It never
// opens, reads or writes user documents or the real system clipboard.
const cli = process.env.AGENT_BROWSER || '/Users/lkc/.npm/_npx/ad6c181e5b604bdb/node_modules/.bin/agent-browser';
const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const session = process.env.SIDEBAR_QA_SESSION || 'sidebar-qa';
const run = (...args) => execFileSync(cli, ['--session', session, ...args], { encoding: 'utf8', timeout: 30000 });
const evaluate = code => JSON.parse(execFileSync(cli, ['--session', session, 'eval', '--stdin'], { input: code, encoding: 'utf8', timeout: 30000 }));
const results = [];
const check = (name, code) => {
  try {
    const detail = evaluate(code);
    results.push({ name, passed: detail.ok === true, detail });
  } catch (error) {
    results.push({ name, passed: false, detail: error.message });
  }
};
const root = '/qa-sidebar';
const paths = ['Beta/same.md', 'file10.md', 'Alpha/Sub/deep.md', '10 Notes/z.md', 'file2.md', 'Alpha/same.md', '2 Notes/a.md', 'Alpha/item10.md', 'Alpha/item2.md'];
const files = paths.map(relativePath => ({ name: relativePath.split('/').at(-1), path: `${root}/${relativePath}`, relativePath }));
const setupFiles = () => evaluate(`(()=>{window.__sidebarOpens=[];window.webkit={messageHandlers:{native:{postMessage(msg){if(msg.type==='open'&&msg.path){window.__sidebarOpens.push(msg.path);queueMicrotask(()=>window.typora.command('load',{markdown:'# Synthetic sidebar fixture',path:msg.path,name:msg.path.split('/').at(-1)}));}}}}};window.typora.command('load',{markdown:'# Synthetic sidebar fixture',path:null,name:'sidebar-qa.md'});window.typora.command('files',${JSON.stringify({root,files})});window.typora.command('sidebarTree');return true})()`);
const treeFolder = rel => `[data-rel=${JSON.stringify(rel)}][aria-expanded]`;
const fileRow = rel => `[data-path=${JSON.stringify(`${root}/${rel}`)}]`;

run('open', appUrl);
run('wait', '--fn', 'Boolean(window.typora?.editor)');
// Check a real reload of legacy preferences, rather than only a fresh default.
evaluate(`(()=>{localStorage.setItem('typora-replica:prefs',JSON.stringify({sidebarVisible:true,sidebarTab:'files'}));return true})()`);
run('open', `${appUrl}/?sidebar-qa=legacy`);
run('wait', '--fn', 'Boolean(window.typora?.editor)');
check('Legacy preferences default to file tree', `(async()=>{const {store}=await import('/src/store.ts');return {ok:store.prefs.filesView==='tree',filesView:store.prefs.filesView}})()`);
setupFiles();
try {
  check('Root is first and expanded; folders precede naturally sorted files', `(()=>{const rows=[...document.querySelectorAll('[role="treeitem"]')];const top=rows.filter(r=>r.getAttribute('aria-level')==='2').map(r=>r.dataset.rel);return {ok:rows[0]?.dataset.rel===''&&rows[0]?.getAttribute('aria-expanded')==='true'&&JSON.stringify(top)===JSON.stringify(['2 Notes','10 Notes','Alpha','Beta','file2.md','file10.md']),top,root:rows[0]?.textContent}})()`);
  run('click', `${treeFolder('Alpha')} > .sidebar-tree-row`);
  check('Disclosure expands nested children in natural order', `(()=>{const r=document.querySelector(${JSON.stringify(treeFolder('Alpha'))});const rows=[...document.querySelectorAll('[role="treeitem"][aria-level="3"]')].map(r=>r.dataset.rel);return {ok:r?.getAttribute('aria-expanded')==='true'&&JSON.stringify(rows)===JSON.stringify(['Alpha/Sub','Alpha/item2.md','Alpha/item10.md','Alpha/same.md']),rows}})()`);
  run('click', `${treeFolder('Alpha')} > .sidebar-tree-row`);
  check('Disclosure collapses descendants', `({ok:document.querySelector(${JSON.stringify(treeFolder('Alpha'))})?.getAttribute('aria-expanded')==='false'&&!document.querySelector(${JSON.stringify(fileRow('Alpha/same.md'))})})`);
  run('click', `${treeFolder('Alpha')} > .sidebar-tree-row`);
  run('click', `${treeFolder('Beta')} > .sidebar-tree-row`);
  run('click', fileRow('Alpha/same.md'));
  run('click', fileRow('Beta/same.md'));
  check('Equal names open distinct absolute paths and active file updates', `(()=>{const paths=window.__sidebarOpens;const active=[...document.querySelectorAll('.active[data-path]')].map(r=>r.dataset.path);const row=document.querySelector(${JSON.stringify(fileRow('Beta/same.md'))});return {ok:JSON.stringify(paths)===JSON.stringify(['/qa-sidebar/Alpha/same.md','/qa-sidebar/Beta/same.md'])&&JSON.stringify(active)===JSON.stringify(['/qa-sidebar/Beta/same.md'])&&(row?.getAttribute('aria-current')==='page'||row?.getAttribute('aria-selected')==='true'),paths,active}})()`);
  run('click', `${treeFolder('Alpha')} > .sidebar-tree-row`);
  evaluate(`(()=>{window.typora.command('load',{markdown:'# Synthetic sidebar fixture',path:'/qa-sidebar/Alpha/Sub/deep.md',name:'deep.md'});return true})()`);
  check('Opening a nested file expands every ancestor', `({ok:document.querySelector(${JSON.stringify(treeFolder('Alpha'))})?.getAttribute('aria-expanded')==='true'&&document.querySelector(${JSON.stringify(treeFolder('Alpha/Sub'))})?.getAttribute('aria-expanded')==='true'&&document.querySelector(${JSON.stringify(fileRow('Alpha/Sub/deep.md'))})?.classList.contains('active')})`);
  run('click', `${treeFolder('Alpha')} > .sidebar-tree-row`);
  evaluate(`(async()=>{const {store}=await import('/src/store.ts');store.setDirty(true);store.setDirty(false);return true})()`);
  check('Dirty changes do not reopen a manually collapsed active ancestor', `({ok:document.querySelector(${JSON.stringify(treeFolder('Alpha'))})?.getAttribute('aria-expanded')==='false'&&!document.querySelector(${JSON.stringify(fileRow('Alpha/Sub/deep.md'))})})`);
  run('fill', '.sidebar-filter', 'alpha/sub/DEEP');
  check('Full relative path filter shows matching file and its ancestors', `(()=>{const rows=[...document.querySelectorAll('[role="treeitem"]')].map(r=>r.dataset.rel);return {ok:JSON.stringify(rows)===JSON.stringify(['','Alpha','Alpha/Sub','Alpha/Sub/deep.md'])&&document.activeElement?.classList.contains('sidebar-filter'),rows}})()`);
  run('fill', '.sidebar-filter', '');
  check('Clearing filter restores normal collapsed state', `({ok:document.querySelector(${JSON.stringify(treeFolder('Alpha'))})?.getAttribute('aria-expanded')==='false'&&!document.querySelector(${JSON.stringify(fileRow('Alpha/Sub/deep.md'))})})`);
  evaluate(`(()=>{window.typora.command('sidebarListFiles');return true})()`);
  check('List command retains all files and visible distinguishing paths', `(()=>{const rows=[...document.querySelectorAll('.sidebar-file-row[data-path]')];const same=rows.filter(r=>r.dataset.path.endsWith('/same.md'));return {ok:rows.length===${files.length}&&!document.querySelector('[role="tree"]')&&same.length===2&&same.every(r=>r.textContent.includes(r.dataset.path.replace('/qa-sidebar/',''))),count:rows.length,same:same.map(r=>r.textContent)}})()`);
  run('fill', '.sidebar-filter', 'Beta/same');
  check('List mode filter also matches relative paths', `(()=>{const rows=[...document.querySelectorAll('.sidebar-file-row[data-path]')];return {ok:rows.length===1&&rows[0].dataset.path==='/qa-sidebar/Beta/same.md',paths:rows.map(r=>r.dataset.path)}})()`);
  run('fill', '.sidebar-filter', '');
  evaluate(`(()=>{window.typora.command('sidebarTree');return true})()`);
  run('focus', treeFolder(''));
  run('press', 'ArrowDown');
  check('ArrowDown moves the roving tree focus', `({ok:document.activeElement?.dataset.rel==='2 Notes'&&document.activeElement?.tabIndex===0&&document.querySelectorAll('[role="treeitem"][tabindex="0"]').length===1,focused:document.activeElement?.dataset.rel})`);
  run('press', 'ArrowRight');
  run('press', 'ArrowRight');
  check('ArrowRight expands directory then focuses first child', `({ok:document.activeElement?.dataset.path==='/qa-sidebar/2 Notes/a.md'&&document.querySelector(${JSON.stringify(treeFolder('2 Notes'))})?.getAttribute('aria-expanded')==='true',focused:document.activeElement?.dataset.path})`);
  run('press', 'ArrowLeft');
  run('press', 'ArrowLeft');
  check('ArrowLeft returns to parent then collapses it', `({ok:document.activeElement?.dataset.rel==='2 Notes'&&document.querySelector(${JSON.stringify(treeFolder('2 Notes'))})?.getAttribute('aria-expanded')==='false',focused:document.activeElement?.dataset.rel})`);
  run('press', 'End');
  run('press', 'Enter');
  check('End and Enter open the last visible file', `({ok:window.__sidebarOpens.at(-1)==='/qa-sidebar/file10.md',path:window.__sidebarOpens.at(-1)})`);
  run('focus', fileRow('file10.md'));
  run('press', 'Home');
  check('Home returns focus to root and groups expose accessible hierarchy', `({ok:document.activeElement?.dataset.rel===''&&document.activeElement?.getAttribute('role')==='treeitem'&&document.querySelector('[role="group"]')!==null})`);
  run('fill', '.sidebar-filter', 'same');
  evaluate(`(()=>{window.typora.command('sidebarListFiles');return true})()`);
  check('Mode changes preserve focused filter and its value', `({ok:document.activeElement?.classList.contains('sidebar-filter')&&document.activeElement.value==='same'&&document.querySelectorAll('.sidebar-file-row[data-path]').length===2})`);
  evaluate(`(async()=>{const {store}=await import('/src/store.ts');store.setPrefs({filesView:'invalid'});return true})()`);
  check('Invalid view preference normalizes to tree', `(async()=>{const {store}=await import('/src/store.ts');return {ok:store.prefs.filesView==='tree',filesView:store.prefs.filesView}})()`);
  run('fill', '.sidebar-filter', '');
  evaluate(`(()=>{window.typora.command('sidebarFiles');return true})()`);
  check('Legacy sidebarFiles command selects tree', `(async()=>{const {store}=await import('/src/store.ts');return {ok:store.prefs.sidebarVisible&&store.prefs.sidebarTab==='files'&&store.prefs.filesView==='tree'}})()`);
  run('screenshot', 'evidence/sidebar-tree-browser.png');
  // Verify the actual native-shell CSS cascade; no native file I/O is involved.
  evaluate(`(()=>{document.body.classList.add('native-app');window.typora.command('sidebarListFiles');return true})()`);
  check('Native list style keeps relative path subtitles visible', `(()=>{const paths=[...document.querySelectorAll('.sidebar-file-path')];return {ok:paths.length===${files.length}&&paths.every(p=>getComputedStyle(p).display!=='none'),count:paths.length}})()`);
  evaluate(`(()=>{window.typora.command('sidebarTree');window.typora.command('load',{markdown:'# Synthetic sidebar fixture',path:'/qa-sidebar/Beta/same.md',name:'same.md'});return true})()`);
  check('Tree shows one root row and no permanent extra toolbar', `({ok:document.querySelectorAll('[role="treeitem"][aria-level="1"]').length===1&&!document.querySelector('.sidebar-files-tree .sidebar-root-header')&&!document.querySelector('.sidebar-root-toggle')})`);
  run('screenshot', 'evidence/sidebar-tree-native-style.png');

} catch (error) {
  results.push({ name: 'Sidebar browser interaction', passed: false, detail: error.message });
}
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/sidebar-tree-verification.json', JSON.stringify({ date: new Date().toISOString(), session, appUrl, fixture: { root, files }, results }, null, 2));
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
