export const CONVERSION_FORMATS = ['docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki', 'rst', 'textile', 'opml'] as const;
export type ConversionFormat = typeof CONVERSION_FORMATS[number];
export const EXPORT_FORMATS = ['html', 'html-plain', 'pdf', 'png', ...CONVERSION_FORMATS] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export const isConversionFormat = (value: string): value is ConversionFormat =>
  (CONVERSION_FORMATS as readonly string[]).includes(value);
export const isExportFormat = (value: string): value is ExportFormat =>
  (EXPORT_FORMATS as readonly string[]).includes(value);

/** Native-owned, window-local state. This is never stored as a preference. */
export const repeatExportAvailability = { previous: false, overwrite: false };

export interface RepeatExportRequest {
  format: ExportFormat;
  overwrite: boolean;
  requestId: string;
}
