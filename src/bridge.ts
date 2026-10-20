// Native bridge with browser fallback.
//
// Native shell: window.webkit.messageHandlers.native.postMessage({type, ...}).
// Browser fallback: <input type=file> for open, Blob download for save/export,
// localStorage for recovery, window.print for PDF.

import { NativeMessage } from './types';
import type { ExportFormat } from './export-formats';

export function isNative(): boolean {
  return !!window.webkit?.messageHandlers?.native;
}

export function postToNative(msg: NativeMessage): boolean {
  const handler = window.webkit?.messageHandlers?.native;
  if (!handler) return false;
  try {
    handler.postMessage(msg);
    return true;
  } catch (err) {
    console.error('[bridge] postMessage failed', err);
    return false;
  }
}

export function notifyReady(): void {
  postToNative({ type: 'ready' });
}

export function notifyChange(markdown: string): void {
  postToNative({ type: 'change', markdown });
}

export function notifyTitle(title: string): void {
  postToNative({ type: 'title', title });
}

/** Ask native to open a file dialog (no path) or a specific file. */
export function nativeOpen(path?: string): boolean {
  return postToNative(path ? { type: 'open', path } : { type: 'open' });
}

export function nativeOpenFolder(): boolean {
  return postToNative({ type: 'openFolder' });
}

export function nativeSave(markdown: string, path?: string | null): boolean {
  return postToNative({ type: 'save', markdown, path: path ?? undefined });
}

export function nativeSaveAs(markdown: string): boolean {
  return postToNative({ type: 'saveAs', markdown });
}

export function nativeExport(
  format: ExportFormat | string,
  html: string,
  markdown: string,
  extras?: { overwrite?: boolean; requestId?: string; identity?: string; intent?: string; settings?: unknown },
): boolean {
  return postToNative({ type: 'export', format, html, markdown, ...extras });
}

export function nativeRepeatExport(overwrite: boolean): boolean {
  return postToNative({ type: 'repeatExport', overwrite });
}

export function openExternal(url: string): void {
  if (!postToNative({ type: 'openExternal', url })) {
    window.open(url, '_blank', 'noopener');
  }
}

// ---- browser fallback helpers ----

let fileInput: HTMLInputElement | null = null;

/** Open a local file via a picker. Resolves with null when cancelled. */
export function browserOpenFile(): Promise<{ name: string; markdown: string } | null> {
  return new Promise((resolve) => {
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.md,.markdown,.mdown,.txt,.text';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
    }
    const input = fileInput;
    const cleanup = () => {
      input.onchange = null;
      input.value = '';
    };
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        cleanup();
        resolve({ name: file.name, markdown: String(reader.result ?? '') });
      };
      reader.onerror = () => {
        cleanup();
        resolve(null);
      };
      reader.readAsText(file);
    };
    // Browsers have no reliable cancel event; window focus heuristic.
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup();
          resolve(null);
        }
        window.removeEventListener('focus', onFocus);
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

export function downloadText(filename: string, content: string, mime = 'text/markdown'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
