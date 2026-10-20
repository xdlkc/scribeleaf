// Outline extraction from raw markdown source (fence/math aware).

import { HeadingItem } from './types';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const MATH_RE = /^\s*\$\$/;

export function extractOutline(markdown: string): HeadingItem[] {
  const items: HeadingItem[] = [];
  const lines = markdown.split('\n');
  let pos = 0;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let inMath = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inFence) {
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) inFence = false;
    } else if (inMath) {
      if (/\$\$\s*$/.test(trimmed) && trimmed.length > 2) inMath = false;
      else if (trimmed === '$$') inMath = false;
    } else {
      const f = FENCE_RE.exec(line);
      if (f) {
        inFence = true;
        fenceChar = f[1][0];
        fenceLen = f[1].length;
      } else if (MATH_RE.test(line) && trimmed !== '$$') {
        // single-line $$x$$ does not enter math mode
        if (!/^\s*\$\$.*\S\$\$\s*$/.test(line)) inMath = true;
      } else if (trimmed === '$$') {
        inMath = true;
      } else {
        const h = HEADING_RE.exec(line);
        if (h) {
          items.push({
            level: h[1].length,
            text: h[2].replace(/[*`~]/g, '').trim(),
            pos,
          });
        }
      }
    }
    pos += line.length + 1;
  }
  return items;
}

/** Pos of the heading at or before `pos`, or -1. */
export function activeHeadingPos(outline: HeadingItem[], pos: number): number {
  let current = -1;
  for (const h of outline) {
    if (h.pos <= pos) current = h.pos;
    else break;
  }
  return current;
}
