import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { isNative, postToNative } from '../bridge';
import { store } from '../store';
export const FILE_DROP_ERROR_EVENT = 'typora-file-drop-error';

type PendingDrop = { requestId: string; pos: number; nativeDocumentId: string; documentPath: string; baseURL: string };
let sequence = 0;
const views = new Set<EditorView>();
const queue = StateEffect.define<PendingDrop>();
const settle = StateEffect.define<string>();
const pending = StateField.define<{ documentId: string; requests: PendingDrop[] }>({
  create: () => ({ documentId: 'file-document-' + ++sequence, requests: [] }),
  update(value, transaction) {
    let requests = transaction.docChanged ? value.requests.map(item => ({ ...item, pos: transaction.changes.mapPos(item.pos, 1) })) : value.requests;
    for (const effect of transaction.effects) {
      if (effect.is(queue)) requests = [...requests, effect.value];
      if (effect.is(settle)) requests = requests.filter(item => item.requestId !== effect.value);
    }
    return requests === value.requests ? value : { documentId: value.documentId, requests };
  },
});

export function fileDropExtension(): Extension {
  return [pending, ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { views.add(view); }
    destroy() { views.delete(this.view); }
  })];
}

const imageName = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif|avif|ico)$/i;
function uriFilePaths(transfer: DataTransfer): string[] {
  const paths: string[] = [];
  for (const line of (transfer.getData('text/uri-list') || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    try {
      const url = new URL(text);
      if (url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost')) paths.push(decodeURIComponent(url.pathname));
    } catch { /* A non-file URI remains handled by normal text/image paste. */ }
  }
  return paths;
}
function filePath(file: File): string | null {
  const path = (file as File & { path?: string }).path;
  return path?.startsWith('/') ? path : null;
}
function entryKind(transfer: DataTransfer, file: File): 'directory' | 'file' | null {
  for (const item of Array.from(transfer.items ?? [])) {
    try {
      if (item.kind !== 'file' || item.getAsFile() !== file) continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) return 'directory';
      if (entry?.isFile) return 'file';
    } catch { /* Finder metadata is optional in WKWebView. */ }
  }
  return null;
}
/** Share directory evidence with the image pipeline. An image extension alone
 * cannot prove that a Finder item is a file. Never use entry.fullPath as an OS
 * path: that field may only describe a browser-relative virtual directory. */
export function isDirectoryDropFile(transfer: DataTransfer, file: File): boolean {
  const entry = entryKind(transfer, file);
  if (entry) return entry === 'directory';
  const path = filePath(file);
  const candidates = uriFilePaths(transfer).filter(candidate => path
    ? candidate.replace(/\/$/, '') === path.replace(/\/$/, '')
    : candidate.replace(/\/$/, '').split('/').pop() === file.name);
  return candidates.length > 0 && candidates.every(candidate => candidate.endsWith('/'));
}
export function isDirectoryDropURI(path: string, transfer?: DataTransfer): boolean {
  if (path.endsWith('/')) return true;
  if (!transfer) return false;
  const clean = path.replace(/\/$/, '');
  return Array.from(transfer.files ?? []).some(file => isDirectoryDropFile(transfer, file) &&
    (filePath(file) ? filePath(file)!.replace(/\/$/, '') === clean : clean.split('/').pop() === file.name));
}

/** Image insertion and file navigation share the same drop. Unknown image-name
 * candidates also reach native classification; real images stay in the image
 * pipeline and native ignores them in the file pipeline. */
export function handleNonImageFileDrop(event: DragEvent, view: EditorView): boolean {
  if (!isNative() || !event.dataTransfer || !store.nativeDocumentId) return false;
  const transfer = event.dataTransfer;
  const files = Array.from(transfer.files ?? []);
  const uris = uriFilePaths(transfer);
  const directories = new Set(files.filter(file => isDirectoryDropFile(transfer, file)));
  const explicitImages = new Set(files.filter(file => !directories.has(file) && (file.type.startsWith('image/') || (entryKind(transfer, file) === 'file' && imageName.test(file.name)))));
  const otherFiles = files.filter(file => !explicitImages.has(file));
  const paths: string[] = [];
  let hasImage = files.some(file => !directories.has(file) && (file.type.startsWith('image/') || imageName.test(file.name)));
  for (const path of uris) {
    const knownImage = files.some(file => explicitImages.has(file) && (filePath(file)?.replace(/\/$/, '') === path.replace(/\/$/, '')));
    if (imageName.test(path) && !isDirectoryDropURI(path, transfer)) hasImage = true;
    if (!knownImage) paths.push(path);
  }
  let needsPasteboard = false;
  for (const file of otherFiles) {
    const path = filePath(file);
    if (path) paths.push(path);
    else {
      // URI paths already identify this item only when its name is unique.
      const matches = uris.filter(uri => uri.replace(/\/$/, '').split('/').pop() === file.name);
      if (matches.length !== 1) needsPasteboard = true;
    }
  }
  for (const item of Array.from(transfer.items ?? [])) {
    try { if (item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory && !item.getAsFile()) needsPasteboard = true; }
    catch { /* The native drag pasteboard resolves missing Finder metadata. */ }
  }
  if (!otherFiles.length && !paths.length && !needsPasteboard) return false;
  const state = view.state.field(pending, false);
  if (!state) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
  const requestId = 'file-drop-' + ++sequence;
  const nativeDocumentId = store.nativeDocumentId;
  const documentPath = store.currentPath ?? '';
  view.dispatch({ effects: queue.of({ requestId, pos, nativeDocumentId, documentPath, baseURL: store.docBase }) });
  const sent = postToNative({ type: 'fileDrop', requestId, documentId: nativeDocumentId, rendererDocumentId: state.documentId, documentPath,
    paths: [...new Set(paths)], useDraggingPasteboard: needsPasteboard });
  if (!sent) { view.dispatch({ effects: settle.of(requestId) }); return false; }
  if (!hasImage) event.preventDefault();
  return !hasImage;
}

type FileLink = { path: string; name: string; isDirectory?: boolean };
export type FileDropResult = { requestId: string; documentId: string; rendererDocumentId: string; links?: FileLink[]; error?: string };

export function handleFileDropResult(result: FileDropResult): void {
  if (!result?.requestId || !result.documentId) return;
  for (const view of views) {
    const state = view.state.field(pending, false);
    const request = state?.requests.find(item => item.requestId === result.requestId);
    if (!state || !request || state.documentId !== result.rendererDocumentId || request.nativeDocumentId !== result.documentId
      || store.nativeDocumentId !== result.documentId || request.documentPath !== (store.currentPath ?? '')) continue;
    const text = (Array.isArray(result.links) ? result.links : []).filter(item => item && typeof item.path === 'string' && typeof item.name === 'string').map(item => {
      let path = item.path;
      try {
        const base = new URL(request.baseURL);
        if (base.protocol === 'file:') {
          const parent = decodeURIComponent(base.pathname).split('/').filter(Boolean);
          const target = path.split('/').filter(Boolean); let shared = 0;
          while (shared < parent.length && parent[shared] === target[shared]) shared++;
          path = [...parent.slice(shared).map(() => '..'), ...target.slice(shared)].join('/') || '.';
        }
      } catch { /* Unsaved documents use the absolute path. */ }
      const destination = encodeURI(path).replace(/[?#:<>\\\r\n]/g, character => encodeURIComponent(character));
      const label = item.name.replace(/[\\\[\]]/g, '\\$&');
      return `[${label}](<${destination}${item.isDirectory && !destination.endsWith('/') ? '/' : ''}>)`;
    }).join('\n');
    view.dispatch({ ...(text ? { changes: { from: request.pos, insert: text }, userEvent: 'input.drop' } : {}), effects: settle.of(result.requestId) });
    if (result.error) window.dispatchEvent(new CustomEvent(FILE_DROP_ERROR_EVENT, { detail: result.error }));
    return;
  }
}
