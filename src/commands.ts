// Command registry. Feature modules register handlers; menus, shortcuts and the
// native bridge dispatch through runCommand().
import { handleTableCommand } from './editor/table-editor';

export type CommandHandler = (payload?: unknown) => void;

const handlers = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  handlers.set(name, handler);
}

export function hasCommand(name: string): boolean {
  return handlers.has(name);
}

export function runCommand(name: string, payload?: unknown): void {
  const control = typeof document === 'undefined' ? null : document.activeElement;
  if (control && /^(INPUT|TEXTAREA)$/.test(control.tagName)) {
    if (name === 'selectAll') { (control as HTMLInputElement).select(); return; }
    if (name === 'undo' || name === 'redo') { document.execCommand(name); return; }
  }
  if (handleTableCommand(name, payload)) return;
  const fn = handlers.get(name);
  if (fn) {
    fn(payload);
  } else {
    console.warn(`[commands] no handler for "${name}"`);
  }
}
