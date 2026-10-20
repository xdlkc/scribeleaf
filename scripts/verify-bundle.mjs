import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';

// Production opens file://, where module/CORS loading differs from the dev server.
const root = resolve(process.argv[2] || 'dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
assert(!/type=["']module["']|modulepreload|\bcrossorigin\b/i.test(html), 'Native entry must use classic scripts without CORS');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
assert(scripts.length, 'Missing entry script');
for (const [, src] of scripts) new Script(readFileSync(resolve(root, src), 'utf8'), { filename: src });
const styles = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css)["'][^>]*>/gi)];
assert(styles.length, 'Missing stylesheet');
for (const [, href] of styles) {
  const path = resolve(root, href);
  const css = readFileSync(path, 'utf8');
  for (const [, url] of css.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
    if (/^(data:|https?:|#)/.test(url)) continue;
    assert(existsSync(resolve(dirname(path), url.split(/[?#]/)[0])), `Missing CSS asset: ${url}`);
  }
}
console.log(`PASS native bundle: ${scripts.length} classic script, ${styles.length} stylesheet, local CSS assets`);
