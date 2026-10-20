// Independent image insertion options. Defaults preserve the replica's existing
// path behavior; they do not assert Typora's native factory values.
import { parseDocument } from 'yaml';

export type ImageInsertAction = '' | 'folder' | 'assert' | 'per-file-assert' | 'ipic' | 'custom';
export type ImageUploader = '' | 'ipic' | 'upic' | 'picsee' | 'picgo-app' | 'piclist-app' | 'custom';
export interface ImagePreferences {
  imageInsertAction: ImageInsertAction;
  imageCopyLocal: boolean;
  imageCopyOnline: boolean;
  allowImageUpload: boolean;
  useRelativeImagePaths: boolean;
  relativeImageDotPrefix: boolean;
  escapeImageURLs: boolean;
  imageUploader: ImageUploader;
  customImageFolder: string;
  customImageUploadCommand: string;
}
export const DEFAULT_IMAGE_PREFERENCES: ImagePreferences = {
  imageInsertAction: '', imageCopyLocal: false, imageCopyOnline: false,
  allowImageUpload: true, useRelativeImagePaths: true,
  relativeImageDotPrefix: false, escapeImageURLs: true,
  imageUploader: '', customImageFolder: './${filename}', customImageUploadCommand: '',
};
export function normalizeImagePreferences(value: Partial<ImagePreferences> | null | undefined): ImagePreferences {
  const result = { ...DEFAULT_IMAGE_PREFERENCES };
  if (!value || typeof value !== 'object') return result;
  const actions = ['', 'folder', 'assert', 'per-file-assert', 'ipic', 'custom'];
  const uploaders = ['', 'ipic', 'upic', 'picsee', 'picgo-app', 'piclist-app', 'custom'];
  if (actions.includes(value.imageInsertAction as string)) result.imageInsertAction = value.imageInsertAction!;
  if (uploaders.includes(value.imageUploader as string)) result.imageUploader = value.imageUploader!;
  for (const key of ['imageCopyLocal', 'imageCopyOnline', 'allowImageUpload', 'useRelativeImagePaths', 'relativeImageDotPrefix', 'escapeImageURLs'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of ['customImageFolder', 'customImageUploadCommand'] as const) {
    if (typeof value[key] === 'string' && !value[key].includes('\0')) result[key] = value[key];
  }
  return result;
}

export interface ImageDocumentPolicy { copyImagesTo?: string; copyImagesInvalid?: boolean }
/** Read the current snapshot, not the last saved native document. Typora's
 * source mode ignores document YAML for automatic image placement. */
export function imageDocumentPolicy(markdown: string, sourceMode = false): ImageDocumentPolicy {
  if (sourceMode) return {};
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return {};
  const close = /^---(?:\n|$)/m.exec(text.slice(4));
  const end = close ? 4 + close.index : -1;
  if (end < 0) {
    return text.includes('typora-copy-images-to') ? { copyImagesInvalid: true } : {};
  }
  try {
    const document = parseDocument(text.slice(4, end), { uniqueKeys: true });
    if (document.errors.length) return { copyImagesInvalid: true };
    const data = document.toJS({ maxAliasCount: 100 }) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const value = (data as Record<string, unknown>)['typora-copy-images-to'];
    if (value === undefined || value === null || value === false || value === '' || value === 'unset' || value === 'undefined') return {};
    return typeof value === 'string' ? { copyImagesTo: value } : { copyImagesInvalid: true };
  } catch { return { copyImagesInvalid: true }; }
}

/** Angle destinations preserve readable spaces/Unicode when URL escaping is
 * disabled. Literal percent signs in file paths still need encoding so a file
 * named "%20" does not silently become a file named " ". */
export function imageMarkdownDestination(path: string, escapeURLs: boolean): string {
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
  if (remote) return '<' + path.replace(/[<>\\\r\n]/g, char => encodeURIComponent(char)) + '>';
  const mandatory = (text: string) => text.replace(remote ? /[<>\\\r\n]/g : /[%#?<>\\:\r\n]/g, char => encodeURIComponent(char));
  let value = mandatory(path);
  if (escapeURLs) {
    // Encode each UTF-8 code point, retaining existing escapes and URI syntax.
    value = Array.from(value).map(char => /[\u0021-\u007e]/.test(char) ? (char === '"' ? '%22' : char) : encodeURIComponent(char)).join('');
  }
  return '<' + value + '>';
}
