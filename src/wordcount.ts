// Word/character/paragraph counting. CJK characters count as individual words,
// matching Typora's behavior.

import { DocStats } from './types';

const WORD_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]|[\p{L}\p{N}]+(?:[’'\-_][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

export function countStats(
  docText: string,
  selFrom: number,
  selTo: number,
): DocStats {
  let paragraphs = 0;
  for (const line of docText.split('\n')) {
    if (line.trim() !== '') paragraphs++;
  }
  const selText = selTo > selFrom ? docText.slice(selFrom, selTo) : '';
  return {
    words: countWords(docText),
    chars: docText.length,
    paragraphs,
    selWords: selText ? countWords(selText) : 0,
    selChars: selText.length,
  };
}
