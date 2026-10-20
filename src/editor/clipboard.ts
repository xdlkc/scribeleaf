// Clipboard paste/drop: rich HTML → Markdown, exact plain text, native image files.
// Coordinator: add clipboardExtension in createEditorState; dispatch
// handleClipboardResult from window.typora.command('clipboardResult').
// Menu paste: pasteFromSystem(view, false|true). Native ⇧⌘V is root's pastePlainText
// + focused-element insertText. Do not add a renderer native plain-text bridge.
// New EditorState already gets a fresh docId. Same-view replace without setState:
// call resetClipboardDocument(view).

import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin } from '@codemirror/view';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import DOMPurify from 'dompurify';
import { renderClipboardMarkdown } from '../markdown-renderer';
import { handleNonImageFileDrop, isDirectoryDropFile, isDirectoryDropURI } from './file-drop';
import { store } from '../store';
import { imageDocumentPolicy, imageMarkdownDestination, type ImageDocumentPolicy } from '../image-preferences';

export const CLIPBOARD_RESULT_COMMAND = 'clipboardResult';
export const CLIPBOARD_ERROR_EVENT = 'typora-clipboard-error';

export type ClipboardResultPayload = {
  requestId: string;
  path?: string;
  paths?: string[];
  error?: string;
};

type ClipboardNativeMessage = {
  type: 'clipboardImage' | 'clipboardCancel';
  requestId: string;
  requestIds?: string[];
  remoteURL?: string;
  imagePolicy?: ImageDocumentPolicy;
  data?: string;
  mime?: string;
  name?: string;
  path?: string;
  usePasteboard?: boolean;
  lookupFileURLs?: boolean;
  source?: 'paste' | 'drop';
};

type NativeHandler = { postMessage(message: ClipboardNativeMessage): void };

interface PendingImage {
  requestId: string;
  batchId: number;
  order: number;
  pos: number;
  alt: string;
  path?: string;
  paths?: string[];
  error?: string;
  settled: boolean;
}

interface PendingPlain {
  requestId: string;
  from: number;
  to: number;
}

interface ClipboardField {
  docId: number;
  pending: PendingImage[];
  plain: PendingPlain | null;
}

let docIdSeq = 1;
let requestIdSeq = 1;
let batchIdSeq = 1;

const liveViews = new Set<EditorView>();
const sentImageRequests = new Set<string>();

let fileReadGate: (() => Promise<void>) | null = null;

/** Test hook: hold FileReader work until the returned promise settles. */
export function setClipboardFileReadGate(gate: (() => Promise<void>) | null): void {
  fileReadGate = gate;
}

const resetClipboardEffect = StateEffect.define<null>();
const queueImagesEffect = StateEffect.define<PendingImage[]>();
const settleImageEffect = StateEffect.define<{
  requestId: string;
  path?: string;
  paths?: string[];
  error?: string;
}>();
const dropPendingEffect = StateEffect.define<string[]>();
const queuePlainEffect = StateEffect.define<PendingPlain>();
const clearPlainEffect = StateEffect.define<null>();

const clipboardField = StateField.define<ClipboardField>({
  create() {
    return { docId: docIdSeq++, pending: [], plain: null };
  },
  update(value, tr) {
    if (tr.effects.some((e) => e.is(resetClipboardEffect))) {
      return { docId: docIdSeq++, pending: [], plain: null };
    }
    let pending = value.pending;
    let plain = value.plain;
    for (const e of tr.effects) {
      if (e.is(queueImagesEffect)) pending = pending.concat(e.value);
      if (e.is(queuePlainEffect)) plain = e.value;
    }
    if (tr.docChanged) {
      pending = pending.map((p) => ({ ...p, pos: tr.changes.mapPos(p.pos, 1) }));
      if (plain) {
        plain = {
          ...plain,
          from: tr.changes.mapPos(plain.from, 1),
          to: tr.changes.mapPos(plain.to, 1),
        };
      }
    }
    for (const e of tr.effects) {
      if (e.is(settleImageEffect)) {
        const v = e.value;
        pending = pending.map((p) =>
          p.requestId === v.requestId
            ? { ...p, settled: true, path: v.path, paths: v.paths, error: v.error }
            : p,
        );
      } else if (e.is(dropPendingEffect)) {
        const ids = new Set(e.value);
        pending = pending.filter((p) => !ids.has(p.requestId));
      } else if (e.is(clearPlainEffect)) {
        plain = null;
      }
    }
    if (pending === value.pending && plain === value.plain) return value;
    return { docId: value.docId, pending, plain };
  },
});

function viewOwningRequest(requestId: string): EditorView | null {
  for (const view of liveViews) {
    const field = view.state.field(clipboardField, false);
    if (field?.pending.some((p) => p.requestId === requestId)) return view;
  }
  return null;
}

const clipboardDomHandlers = EditorView.domEventHandlers({
  copy(event, view) { return handleCopyCutEvent(event, view); },
  cut(event, view) { return handleCopyCutEvent(event, view); },
  paste(event, view) {
    return handlePasteEvent(event, view);
  },
  drop(event, view) {
    return handleDropEvent(event, view);
  },
  dragover(event) {
    const dt = event.dataTransfer;
    if (!dt) return false;
    if (Array.from(dt.types).some((t) => t === 'Files' || t === 'text/uri-list')) {
      event.preventDefault();
      return true;
    }
    return false;
  },
});

function renderedCopy(source: string): { html: string; plain: string } {
  const html = DOMPurify.sanitize(renderClipboardMarkdown(source, store.prefs));
  const template = document.createElement('template');
  template.innerHTML = html;
  const holder = template.content; // Inert: copied image URLs are not fetched.
  for (const image of holder.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.alt));
  for (const br of holder.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
  for (const cell of holder.querySelectorAll('td,th')) cell.append(document.createTextNode('\t'));
  for (const block of holder.querySelectorAll('p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,tr,table,div')) {
    block.append(document.createTextNode('\n'));
  }
  return { html, plain: (holder.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() };
}

/** Runs before CM's default handler, whose implicit whole-line copy is always
 * enabled. It deliberately leaves nested table/cell DOM selections alone. */
export function handleCopyCutEvent(event: ClipboardEvent, view: EditorView): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const editable = target?.closest('[contenteditable="true"]');
  if (editable && editable !== view.contentDOM) return false;
  const data = event.clipboardData;
  if (!data) return false;
  let ranges = view.state.selection.ranges.filter(range => !range.empty).map(({ from, to }) => ({ from, to }));
  const linewise = ranges.length === 0;
  if (linewise) {
    if (!store.prefs.lineWiseCopyCut) { event.preventDefault(); return true; }
    const seen = new Set<number>();
    ranges = view.state.selection.ranges.flatMap(range => {
      const line = view.state.doc.lineAt(range.head);
      if (seen.has(line.number)) return [];
      seen.add(line.number);
      return [{ from: line.from, to: Math.min(view.state.doc.length, line.to + 1) }];
    });
  }
  // Whole-line ranges already contain their original line separator. Adding
  // another separator between cursors would create blank lines in the copy.
  const source = ranges.map(range => view.state.sliceDoc(range.from, range.to)).join(linewise ? '' : view.state.lineBreak);
  const rendered = renderedCopy(source);
  data.clearData();
  data.setData('text/plain', store.prefs.copyMarkdownAsPlainText || store.prefs.sourceMode ? source : rendered.plain);
  data.setData('text/html', rendered.html);
  if (event.type === 'cut' && !view.state.readOnly) {
    view.dispatch({ changes: ranges, scrollIntoView: true, userEvent: 'delete.cut' });
  }
  event.preventDefault();
  return true;
}

const clipboardKeymap = keymap.of([
  {
    key: 'Shift-Mod-v',
    run: (view) => {
      void pasteFromSystem(view, true);
      return true;
    },
  },
]);

const clipboardBinder = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      liveViews.add(view);
    }
    destroy(): void {
      cancelClipboardRequests(this.view.state.field(clipboardField, false)?.pending.map(item => item.requestId) ?? []);
      liveViews.delete(this.view);
    }
  },
);

export const clipboardExtension: Extension = [
  clipboardField,
  clipboardBinder,
  clipboardDomHandlers,
  clipboardKeymap,
];

/** Same-view document replacement without a new EditorState. */
export function resetClipboardDocument(view: EditorView): void {
  cancelClipboardRequests(clipboardPendingIds(view.state));
  view.dispatch({ effects: resetClipboardEffect.of(null) });
}

export function clipboardDocumentId(state: EditorState): number {
  return state.field(clipboardField).docId;
}

export function clipboardPendingIds(state: EditorState): string[] {
  return state.field(clipboardField).pending.map((p) => p.requestId);
}

export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);
  service.addRule('skipDataImages', {
    filter: (node) => {
      if (node.nodeName !== 'IMG') return false;
      const src = node.getAttribute('src') || '';
      return src.startsWith('data:') || src.startsWith('blob:');
    },
    replacement: () => '',
  });
  return service.turndown(html).replace(/[ \t]+\n/g, '\n').trim();
}

export function pasteTextFromClipboard(
  html: string | null,
  plain: string | null,
  forcePlain: boolean,
): string {
  if (forcePlain) return plain ?? '';
  if (html && html.trim()) return htmlToMarkdown(html);
  return plain ?? '';
}

export function markdownImage(alt: string, path: string): string {
  const safeAlt = alt.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/]/g, '\\]');
  const dest = imageMarkdownDestination(path, store.prefs.escapeImageURLs ?? true);
  return `![${safeAlt}](${dest})`;
}

export function handleClipboardResult(payload: ClipboardResultPayload): void {
  sentImageRequests.delete(payload.requestId);
  const view = viewOwningRequest(payload.requestId);
  if (!view) return;
  applyClipboardResult(view, payload);
}

export function applyClipboardResult(view: EditorView, payload: ClipboardResultPayload): void {
  const field = view.state.field(clipboardField, false);
  if (!field) return;
  if (!field.pending.some((p) => p.requestId === payload.requestId)) return;
  if (payload.error && payload.error !== 'cancelled') window.dispatchEvent(new CustomEvent(CLIPBOARD_ERROR_EVENT, { detail: { requestId: payload.requestId, error: payload.error } }));
  view.dispatch({
    effects: settleImageEffect.of({
      requestId: payload.requestId,
      path: payload.path,
      paths: payload.paths,
      error: payload.error,
    }),
  });
  flushReadyImages(view);
}

export function queueClipboardImages(
  view: EditorView,
  items: Array<{ requestId: string; alt?: string; pos?: number }>,
): void {
  const pos = view.state.selection.main.from;
  const batchId = batchIdSeq++;
  const pending: PendingImage[] = items.map((item, order) => ({
    requestId: item.requestId,
    batchId,
    order,
    pos: item.pos ?? pos,
    alt: item.alt ?? '',
    settled: false,
  }));
  view.dispatch({ effects: queueImagesEffect.of(pending) });
}

/**
 * Browser/menu paste. `plain` true = exact clipboard text (⇧⌘V in browser).
 * Native ⇧⌘V is owned by root (`pastePlainText` + focused insertText).
 * Captures focus and doc identity before any async clipboard read.
 * Nested `.lp-cell` contenteditable receives insertText; the CM caret is not used.
 */
export async function pasteFromSystem(view: EditorView, plain: boolean): Promise<void> {
  const docId = clipboardDocumentId(view.state);
  const nested = nestedEditableTarget(view, document.activeElement);
  const requestId = nextRequestId();
  if (!nested) {
    const { from, to } = view.state.selection.main;
    view.dispatch({ effects: queuePlainEffect.of({ requestId, from, to }) });
  }
  let clipboard: { text: string; html?: string };
  try {
    clipboard = await readSystemClipboard(plain);
  } catch {
    if (!stillSameSession(view, docId)) return;
    if (nested && (!nested.isConnected || !view.dom.contains(nested))) return;
    if (!nested) {
      const field = view.state.field(clipboardField, false);
      if (field?.plain?.requestId === requestId) {
        view.dispatch({ effects: clearPlainEffect.of(null) });
      }
    }
    window.dispatchEvent(
      new CustomEvent(CLIPBOARD_ERROR_EVENT, { detail: { requestId, error: 'unsupported' } }),
    );
    return;
  }
  if (!stillSameSession(view, docId)) return;
  if (nested) {
    if (!nested.isConnected || !view.dom.contains(nested)) return;
    nested.focus();
    const inserted = insertIntoNested(nested, clipboard.text);
    if (inserted) {
      nested.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      window.dispatchEvent(
        new CustomEvent(CLIPBOARD_ERROR_EVENT, { detail: { requestId, error: 'unsupported' } }),
      );
    }
    return;
  }
  const field = view.state.field(clipboardField);
  if (!field.plain || field.plain.requestId !== requestId) return;
  if (!plain && clipboard.html) {
    view.dispatch({ selection: { anchor: field.plain.from, head: field.plain.to } });
    if (ingestOnlineHTML(view, clipboard.html, docId, 'paste')) {
      view.dispatch({ effects: clearPlainEffect.of(null) });
      return;
    }
  }
  insertAtRange(view, field.plain.from, field.plain.to, clipboard.text);
  view.dispatch({ effects: clearPlainEffect.of(null) });
}

function stillSameSession(view: EditorView, docId: number): boolean {
  if (!liveViews.has(view)) return false;
  try {
    return clipboardDocumentId(view.state) === docId;
  } catch {
    return false;
  }
}

function insertIntoNested(nested: HTMLElement, text: string): boolean {
  try {
    if (document.execCommand('insertText', false, text)) return true;
  } catch {
    /* execCommand missing or throws */
  }
  const before = nested.textContent || '';
  nested.textContent = before + text;
  return (nested.textContent || '').length > before.length;
}

function nestedEditableTarget(view: EditorView, el: EventTarget | null): HTMLElement | null {
  if (!el || typeof (el as HTMLElement).closest !== 'function') return null;
  const node = el as HTMLElement;
  if (node === view.contentDOM) return null;
  const cell = node.closest('[contenteditable="true"], [contenteditable=""], .lp-cell');
  if (!cell || cell === view.contentDOM) return null;
  if (!view.dom.contains(cell)) return null;
  return cell as HTMLElement;
}

async function readSystemClipboard(plain: boolean): Promise<{ text: string; html?: string }> {
  if (!plain && navigator.clipboard && 'read' in navigator.clipboard) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        const html = await (await item.getType('text/html')).text();
        if (html.trim()) return { text: htmlToMarkdown(html), html };
      }
    }
    for (const item of items) {
      if (item.types.includes('text/plain')) {
        return { text: await (await item.getType('text/plain')).text() };
      }
    }
    const imageOnly = items.some((item) => item.types.some((t) => t.startsWith('image/')));
    if (imageOnly) throw new Error('unsupported');
  }
  if (!navigator.clipboard?.readText) throw new Error('unsupported');
  return { text: await navigator.clipboard.readText() };
}

function insertAtRange(view: EditorView, from: number, to: number, text: string): void {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
}

function flushReadyImages(view: EditorView): void {
  const field = view.state.field(clipboardField);
  const byBatch = new Map<number, PendingImage[]>();
  for (const p of field.pending) {
    const list = byBatch.get(p.batchId) ?? [];
    list.push(p);
    byBatch.set(p.batchId, list);
  }
  const changes: { from: number; insert: string }[] = [];
  const consumed: string[] = [];
  for (const list of byBatch.values()) {
    list.sort((a, b) => a.order - b.order);
    for (const item of list) {
      if (!item.settled) break;
      consumed.push(item.requestId);
      if (item.error) continue;
      const paths = item.paths?.length ? item.paths : item.path ? [item.path] : [];
      if (!paths.length) continue;
      const chunk = paths.map((path) => markdownImage(item.alt, path)).join('\n') + '\n';
      changes.push({ from: item.pos, insert: chunk });
    }
  }
  if (!consumed.length) return;
  view.dispatch({
    changes,
    effects: dropPendingEffect.of(consumed),
  });
}

function nextRequestId(): string {
  return `cb-${Date.now().toString(36)}-${requestIdSeq++}`;
}

function cancelClipboardRequests(requestIds: string[]): void {
  const sent = requestIds.filter(id => sentImageRequests.has(id));
  sent.forEach(id => sentImageRequests.delete(id));
  if (sent.length) postClipboardNative({ type: 'clipboardCancel', requestId: '', requestIds: sent });
}

function postClipboardNative(msg: ClipboardNativeMessage): boolean {
  const native = window.webkit?.messageHandlers?.native as NativeHandler | undefined;
  if (!native) return false;
  if (msg.type === 'clipboardImage') sentImageRequests.add(msg.requestId);
  native.postMessage(msg);
  return true;
}

function reportUnsupported(view: EditorView, requestId: string, docId: number, message = 'unsupported'): void {
  if (clipboardDocumentId(view.state) !== docId) return;
  if (!view.state.field(clipboardField).pending.some((p) => p.requestId === requestId)) return;
  applyClipboardResult(view, { requestId, error: message });
}

function sendImageRequest(
  view: EditorView,
  docId: number,
  requestId: string,
  spec: {
    data?: string;
    mime?: string;
    name?: string;
    path?: string;
    remoteURL?: string;
    usePasteboard?: boolean;
    lookupFileURLs?: boolean;
    source?: 'paste' | 'drop';
  },
): boolean {
  if (clipboardDocumentId(view.state) !== docId) return false;
  if (!view.state.field(clipboardField).pending.some((p) => p.requestId === requestId)) return false;
  const sent = postClipboardNative({
    type: 'clipboardImage',
    requestId,
    data: spec.data,
    mime: spec.mime,
    name: spec.name,
    path: spec.path,
    remoteURL: spec.remoteURL,
    imagePolicy: imageDocumentPolicy(view.state.doc.toString(), store.prefs.sourceMode),
    usePasteboard: spec.usePasteboard,
    lookupFileURLs: spec.lookupFileURLs,
    source: spec.source,
  });
  if (!sent) reportUnsupported(view, requestId, docId);
  return sent;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|svg)$/i;

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/') || file.type === 'image/svg+xml') return true;
  return IMAGE_EXT.test(file.name);
}

function fileOsPath(file: File): string | null {
  const path = (file as File & { path?: string }).path;
  if (path && path.startsWith('/')) return path;
  return null;
}

function pathsFromUriList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'file:') out.push(decodeURIComponent(url.pathname));
    } catch {
      if (trimmed.startsWith('/') && IMAGE_EXT.test(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

async function fileToBase64(file: File): Promise<{ data: string; mime: string; name: string }> {
  if (fileReadGate) await fileReadGate();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve({
        data: comma >= 0 ? result.slice(comma + 1) : result,
        mime: file.type || guessMime(file.name),
        name: file.name || 'image.png',
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/png';
}

function htmlLooksLikeImageOnly(html: string): boolean {
  const stripped = html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?(html|head|body|meta|br|div|p|span|figure|a)[^>]*>/gi, '')
    .replace(/&nbsp;/gi, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

function extractHtmlFileImages(html: string): string[] {
  const paths: string[] = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (src.startsWith('file:')) {
      try {
        paths.push(decodeURIComponent(new URL(src).pathname));
      } catch {
        /* ignore */
      }
    }
  }
  return paths;
}

function ingestOnlineHTML(view: EditorView, html: string, docId: number, source: 'paste' | 'drop'): boolean {
  const policy = imageDocumentPolicy(view.state.doc.toString(), store.prefs.sourceMode);
  if (!store.prefs.imageCopyOnline || (!store.prefs.imageInsertAction && !policy.copyImagesTo && !policy.copyImagesInvalid)) return false;
  const holder = document.createElement('template');
  holder.innerHTML = html;
  const images = Array.from(holder.content.querySelectorAll('img')).filter(img => /^https?:\/\//i.test(img.getAttribute('src') ?? ''));
  if (!images.length) return false;
  const marker = 'TYPORAIMAGE' + Date.now().toString(36) + requestIdSeq++ + 'MARKER';
  const specs = images.map((img, index) => ({
    requestId: nextRequestId(), alt: img.alt, remoteURL: img.getAttribute('src')!,
    marker: marker + index + 'END', pos: 0,
  }));
  images.forEach((img, index) => img.replaceWith(document.createTextNode(specs[index].marker)));
  const transformed = htmlToMarkdown(holder.innerHTML);
  let content = transformed;
  const placements = specs.map(spec => ({ spec, offset: transformed.indexOf(spec.marker) })).filter(item => item.offset >= 0).sort((a, b) => a.offset - b.offset);
  if (!placements.length) return false;
  let removed = 0;
  const from = view.state.selection.main.from;
  for (const item of placements) {
    item.spec.pos = from + item.offset - removed;
    content = content.replace(item.spec.marker, '');
    removed += item.spec.marker.length;
  }
  insertText(view, content);
  queueClipboardImages(view, placements.map(item => item.spec));
  for (const { spec } of placements) sendImageRequest(view, docId, spec.requestId, { remoteURL: spec.remoteURL, source });
  return true;
}

function insertText(view: EditorView, text: string): void {
  const range = view.state.selection.main;
  insertAtRange(view, range.from, range.to, text);
}

function handlePasteEvent(event: ClipboardEvent, view: EditorView): boolean {
  if (nestedEditableTarget(view, event.target as Element | null)) {
    return false;
  }
  const dt = event.clipboardData;
  if (!dt) return false;
  event.preventDefault();
  void ingestDataTransfer(view, dt, true);
  return true;
}

function handleDropEvent(event: DragEvent, view: EditorView): boolean {
  const dt = event.dataTransfer;
  if (!dt) return false;
  if (handleNonImageFileDrop(event, view)) return true;
  const types = Array.from(dt.types);
  if (!types.includes('Files') && !types.includes('text/uri-list') && !dt.files.length) {
    return false;
  }
  event.preventDefault();
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos != null) view.dispatch({ selection: { anchor: pos } });
  void ingestDataTransfer(view, dt, false);
  return true;
}

type ImageSpec = {
  requestId: string;
  alt: string;
  path?: string;
  remoteURL?: string;
  file?: File;
  usePasteboard?: boolean;
  lookupFileURLs?: boolean;
  name?: string;
  source: 'paste' | 'drop';
};

async function ingestDataTransfer(view: EditorView, dt: DataTransfer, isPaste: boolean): Promise<void> {
  const docId = clipboardDocumentId(view.state);
  const files = Array.from(dt.files || []).filter(file => isImageFile(file) && (isPaste || !isDirectoryDropFile(dt, file)));
  const uriPaths = pathsFromUriList(dt.getData('text/uri-list') || '').filter(path => IMAGE_EXT.test(path) && (isPaste || !isDirectoryDropURI(path, dt)));
  const html = dt.getData('text/html') || '';
  const plain = dt.getData('text/plain');
  const htmlFilePaths = html ? extractHtmlFileImages(html) : [];
  // An HTML image URL is processed natively so copy/upload and cancellation
  // rules also apply to online images. The inert template never fetches it.
  if (!files.length && !uriPaths.length && !htmlFilePaths.length && html && ingestOnlineHTML(view, html, docId, isPaste ? 'paste' : 'drop')) return;

  const source: 'paste' | 'drop' = isPaste ? 'paste' : 'drop';
  const specs: ImageSpec[] = [];
  const usedPaths = new Set<string>();

  const addPath = (path: string, name?: string) => {
    if (usedPaths.has(path)) return;
    usedPaths.add(path);
    const base = name || path.split('/').pop() || 'image';
    specs.push({
      requestId: nextRequestId(),
      alt: base.replace(/\.[^.]+$/, ''),
      path,
      name: base,
      source,
    });
  };

  for (const file of files) {
    const osPath = fileOsPath(file);
    if (osPath) addPath(osPath, file.name);
    else {
      const same = [...uriPaths, ...htmlFilePaths].find(
        (p) => !usedPaths.has(p) && (p.split('/').pop() || '') === file.name,
      );
      if (same) addPath(same, file.name);
      else {
        specs.push({
          requestId: nextRequestId(),
          alt: file.name.replace(/\.[^.]+$/, '') || 'image',
          file,
          lookupFileURLs: true,
          name: file.name,
          source,
        });
      }
    }
  }
  for (const p of uriPaths) {
    if (usedPaths.has(p)) continue;
    addPath(p);
  }
  for (const p of htmlFilePaths) {
    if (usedPaths.has(p)) continue;
    addPath(p);
  }

  if (!specs.length) {
    const imageItems = Array.from(dt.items || []).filter(
      (i) => i.kind === 'file' && i.type.startsWith('image/'),
    );
    if (imageItems.length) {
      for (const item of imageItems) {
        const file = item.getAsFile();
        if (!file) continue;
        if (fileOsPath(file)) addPath(fileOsPath(file)!, file.name);
        else {
          specs.push({
            requestId: nextRequestId(),
            alt: 'image',
            file,
            lookupFileURLs: true,
            name: file.name || 'image.png',
            source,
          });
        }
      }
    } else if (isPaste && looksLikeOsImagePaste(dt)) {
      specs.push({
        requestId: nextRequestId(),
        alt: 'image',
        usePasteboard: true,
        name: 'image.png',
        source,
      });
    }
  }

  if (!specs.length && !html) {
    for (const line of (dt.getData('text/uri-list') || '').split(/\r?\n/)) {
      try {
        const url = new URL(line.trim());
        if (!/^https?:$/.test(url.protocol) || !IMAGE_EXT.test(url.pathname)) continue;
        specs.push({ requestId: nextRequestId(), alt: '', remoteURL: url.href, source });
      } catch { /* Non-URL clipboard text remains ordinary text. */ }
    }
  }

  if (specs.length) {
    queueClipboardImages(
      view,
      specs.map((s) => ({ requestId: s.requestId, alt: s.alt })),
    );
  }

  const imageOnlyHtml = html ? htmlLooksLikeImageOnly(html) : false;
  if (clipboardDocumentId(view.state) === docId) {
    if (specs.length) {
      if (html && !imageOnlyHtml) insertText(view, '\n' + htmlToMarkdown(html));
      else if (plain && !imageOnlyHtml && !html && !specs.every(spec => spec.remoteURL)) insertText(view, '\n' + plain);
    } else if (html) {
      insertText(view, htmlToMarkdown(html));
    } else if (plain) {
      insertText(view, plain);
    }
  }

  for (const spec of specs) {
    if (clipboardDocumentId(view.state) !== docId) return;
    if (!view.state.field(clipboardField).pending.some((p) => p.requestId === spec.requestId)) return;
    if (spec.remoteURL) {
      sendImageRequest(view, docId, spec.requestId, { remoteURL: spec.remoteURL, name: spec.name, source: spec.source });
      continue;
    }
    if (spec.path) {
      sendImageRequest(view, docId, spec.requestId, {
        path: spec.path,
        name: spec.name,
        source: spec.source,
      });
      continue;
    }
    if (spec.usePasteboard) {
      sendImageRequest(view, docId, spec.requestId, {
        usePasteboard: true,
        name: spec.name,
        source: spec.source,
      });
      continue;
    }
    if (spec.file) {
      try {
        const encoded = await fileToBase64(spec.file);
        if (clipboardDocumentId(view.state) !== docId) return;
        if (!view.state.field(clipboardField).pending.some((p) => p.requestId === spec.requestId)) return;
        sendImageRequest(view, docId, spec.requestId, {
          data: encoded.data,
          mime: encoded.mime,
          name: encoded.name,
          lookupFileURLs: true,
          source: spec.source,
        });
      } catch {
        if (clipboardDocumentId(view.state) !== docId) return;
        sendImageRequest(view, docId, spec.requestId, {
          lookupFileURLs: true,
          usePasteboard: true,
          name: spec.name,
          source: spec.source,
        });
      }
    }
  }
}

function looksLikeOsImagePaste(dt: DataTransfer): boolean {
  const types = Array.from(dt.types);
  if (types.some((t) => t.startsWith('image/'))) return true;
  if (types.includes('Files') && !dt.getData('text/plain') && !dt.getData('text/html')) return true;
  const html = dt.getData('text/html');
  return Boolean(
    html &&
      htmlLooksLikeImageOnly(html) &&
      /<img\b[^>]*\bsrc=["'](?:data|blob|file):/i.test(html),
  );
}
