/** Typora keeps pipes inside table code spans. This is a rendering transform;
 * the editable Markdown source is never changed. Both export and live tables
 * use it so their cell boundaries agree. */
export function prepareMarkdownTables(markdown: string): string {
  const lines = markdown.split('\n');
  const rows = new Set<number>();
  let fence: {character: string; length: number} | null = null;
  const unquote = (line: string) => line.replace(/^\s{0,3}(?:>\s*)*/, '');
  const divider = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length; index++) {
    const line = unquote(lines[index]);
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = {character: marker[1][0], length: marker[1].length}; continue; }
    if (index === 0 || !divider.test(line) || !lines[index - 1].includes('|')) continue;
    rows.add(index - 1);
    for (let row = index + 1; row < lines.length && lines[row].trim() && lines[row].includes('|'); row++) rows.add(row);
  }
  const escaped = (line: string, at: number) => {
    let count = 0;
    while (at > 0 && line[--at] === '\\') count++;
    return count % 2 === 1;
  };
  for (const row of rows) {
    const line = lines[row];
    let output = '';
    for (let index = 0; index < line.length;) {
      if (line[index] !== '`' || escaped(line, index)) { output += line[index++]; continue; }
      let openEnd = index;
      while (line[openEnd] === '`') openEnd++;
      const count = openEnd - index;
      let close = -1;
      for (let at = openEnd; at < line.length;) {
        if (line[at] !== '`') { at++; continue; }
        let end = at;
        while (line[end] === '`') end++;
        if (end - at === count) { close = at; break; }
        at = end;
      }
      if (close < 0) { output += line.slice(index, openEnd); index = openEnd; continue; }
      output += line.slice(index, openEnd);
      for (let at = openEnd; at < close; at++) output += line[at] === '|' && !escaped(line, at) ? '\\|' : line[at];
      output += line.slice(close, close + count);
      index = close + count;
    }
    lines[row] = output;
  }
  return lines.join('\n');
}
