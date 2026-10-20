// Menu structure mirroring Typora 1.14 macOS menus (names/shortcuts observed
// from the installed app and its published shortcut list). Consumed by the
// in-browser menu bar; the native shell builds its own menus and sends the
// same command names through window.typora.command().
import { repeatExportAvailability } from '../export-formats';

export interface MenuItem {
  label?: string;
  command?: string;
  payload?: unknown;
  shortcut?: string; // display string, e.g. "⌘B"
  separator?: boolean;
  /** Pref key rendered as a checkmark toggle. */
  prefCheck?: 'sidebarVisible' | 'sourceMode' | 'focusMode' | 'typewriterMode' | 'autoSave' | 'spellcheck';
  /** Submenu listing themes; checkmark reflects active theme. */
  themeCheck?: string;
  disabledInBrowser?: boolean;
  /** Evaluated when a menu opens and when a command/shortcut is invoked. */
  enabled?: () => boolean;
}

export interface MenuSpec {
  label: string;
  items: MenuItem[];
}

const sep: MenuItem = { separator: true };

export const MENU_SPEC: MenuSpec[] = [
  {
    label: 'File',
    items: [
      { label: 'New', command: 'new', shortcut: '⌘N' },
      { label: 'Open…', command: 'open', shortcut: '⌘O' },
      { label: 'Open Folder…', command: 'openFolder' },
      { label: 'Open Quickly…', command: 'quickOpen', shortcut: '⇧⌘O' },
      sep,
      { label: 'Save', command: 'save', shortcut: '⌘S' },
      { label: 'Save As…', command: 'saveAs', shortcut: '⇧⌥⌘S' },
      { label: 'Auto Save', prefCheck: 'autoSave' },
      sep,
      { label: 'Export as HTML…', command: 'exportHtml' },
      { label: 'Export as PDF…', command: 'exportPdf' },
      { label: 'HTML (without styles)', command: 'exportFormat', payload: 'html-plain' },
      { label: 'Image…', command: 'exportFormat', payload: 'png', disabledInBrowser: true },
      ...([['Word (.docx)', 'docx'], ['OpenOffice', 'odt'], ['RTF', 'rtf'], ['Epub', 'epub'], ['LaTeX', 'latex'], ['Media Wiki', 'mediawiki'], ['reStructuredText', 'rst'], ['Textile', 'textile'], ['OPML', 'opml']] as const)
        .map(([label, payload]) => ({label, command: 'exportFormat', payload, disabledInBrowser: true})),
      { label: 'Export with Previous', command: 'exportLast', shortcut: '⌃⌘E', disabledInBrowser: true, enabled: () => repeatExportAvailability.previous },
      { label: 'Export and Overwrite with Previous', command: 'exportLastOverwrite', disabledInBrowser: true, enabled: () => repeatExportAvailability.overwrite },
      { label: 'Export Settings…', command: 'exportSettings' },
      { label: 'Print…', command: 'print', shortcut: '⌘P' },
      sep,
      { label: 'Close', command: 'close', shortcut: '⌘W', disabledInBrowser: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', command: 'undo', shortcut: '⌘Z' },
      { label: 'Redo', command: 'redo', shortcut: '⇧⌘Z' },
      sep,
      { label: 'Cut', command: 'cut', shortcut: '⌘X' },
      { label: 'Copy', command: 'copy', shortcut: '⌘C' },
      { label: 'Paste', command: 'paste', shortcut: '⌘V' },
      { label: 'Paste as Plain Text', command: 'pastePlainText', shortcut: '⇧⌘V' },
      { label: 'Select All', command: 'selectAll', shortcut: '⌘A' },
      sep,
      { label: 'Find…', command: 'find', shortcut: '⌘F' },
      { label: 'Find Next', command: 'findNext', shortcut: '⌘G' },
      { label: 'Find Previous', command: 'findPrev', shortcut: '⇧⌘G' },
      { label: 'Find and Replace…', command: 'replace', shortcut: '⌥⌘F' },
      sep,
      { label: 'Select Line', command: 'selectLine', shortcut: '⌘L' },
      { label: 'Delete Line', command: 'deleteLine', shortcut: '⇧⌘⌫' },
      { label: 'Duplicate Line', command: 'duplicateLine', shortcut: '⇧⌘D' },
      sep,
      { label: 'Jump to Top', command: 'jumpTop', shortcut: '⌘↑' },
      { label: 'Jump to Bottom', command: 'jumpBottom', shortcut: '⌘↓' },
    ],
  },
  {
    label: 'Paragraph',
    items: [
      { label: 'Heading 1', command: 'heading1', shortcut: '⌘1' },
      { label: 'Heading 2', command: 'heading2', shortcut: '⌘2' },
      { label: 'Heading 3', command: 'heading3', shortcut: '⌘3' },
      { label: 'Heading 4', command: 'heading4', shortcut: '⌘4' },
      { label: 'Heading 5', command: 'heading5', shortcut: '⌘5' },
      { label: 'Heading 6', command: 'heading6', shortcut: '⌘6' },
      { label: 'Paragraph', command: 'paragraph', shortcut: '⌘0' },
      sep,
      { label: 'Increase Heading Level', command: 'increaseHeading', shortcut: '⌘=' },
      { label: 'Decrease Heading Level', command: 'decreaseHeading', shortcut: '⌘-' },
      sep,
      { label: 'Insert Table…', command: 'table', shortcut: '⌥⌘T' },
      { label: 'Code Fences', command: 'codeFences', shortcut: '⌥⌘C' },
      { label: 'Math Block', command: 'mathBlock', shortcut: '⌥⌘B' },
      { label: 'Quote', command: 'quote', shortcut: '⌥⌘Q' },
      { label: 'Note', command: 'alertNote' },
      { label: 'Tip', command: 'alertTip' },
      { label: 'Important', command: 'alertImportant' },
      { label: 'Warning', command: 'alertWarning' },
      { label: 'Caution', command: 'alertCaution' },
      sep,
      { label: 'Ordered List', command: 'orderedList', shortcut: '⌥⌘O' },
      { label: 'Bullet List', command: 'bulletList', shortcut: '⌥⌘U' },
      { label: 'Task List', command: 'taskList', shortcut: '⌥⌘X' },
      { label: 'Toggle Task State', command: 'toggleTaskState', shortcut: '⌃X' },
      { label: 'Mark as Complete', command: 'taskChecked' },
      { label: 'Mark as Incomplete', command: 'taskUnchecked' },
      { label: 'Indent', command: 'indent', shortcut: '⌘]' },
      { label: 'Outdent', command: 'outdent', shortcut: '⌘[' },
      sep,
      { label: 'Horizontal Rule', command: 'horizontalRule', shortcut: '⌥⌘-' },
      { label: 'Footnote', command: 'footnote', shortcut: '⌥⌘R' },
      { label: 'Link Reference', command: 'linkReferenceDefinition', shortcut: '⌥⌘L' },
      { label: 'Insert Paragraph Above', command: 'insertParagraphAbove' },
      { label: 'Insert Paragraph Below', command: 'insertParagraphBelow' },
      { label: 'Table of Contents', command: 'toc' },
      { label: 'YAML Front Matter', command: 'yamlFrontMatter' },
    ],
  },
  {
    label: 'Format',
    items: [
      { label: 'Bold', command: 'bold', shortcut: '⌘B' },
      { label: 'Italic', command: 'italic', shortcut: '⌘I' },
      { label: 'Underline', command: 'underline', shortcut: '⌘U' },
      { label: 'Strikethrough', command: 'strike', shortcut: '⌃⇧`' },
      { label: 'Inline Code', command: 'inlineCode', shortcut: '⌃`' },
      { label: 'Highlight', command: 'highlight', shortcut: '⌃⇧H' },
      { label: 'Comment', command: 'comment', shortcut: '⌃-' },
      sep,
      { label: 'Hyperlink…', command: 'hyperlink', shortcut: '⌘K' },
      { label: 'Image…', command: 'image', shortcut: '⌃⌘I' },
      sep,
      { label: 'Clear Format', command: 'clearFormat', shortcut: '⌘\\' },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Toggle Sidebar', command: 'toggleSidebar', shortcut: '⇧⌘L', prefCheck: 'sidebarVisible' },
      { label: 'Outline', command: 'sidebarOutline', shortcut: '⌃⌘1' },
      { label: 'Document List', command: 'sidebarListFiles', shortcut: '⌃⌘2' },
      { label: 'File Tree', command: 'sidebarTree', shortcut: '⌃⌘3' },
      sep,
      { label: 'Source Code Mode', command: 'toggleSource', shortcut: '⌘/', prefCheck: 'sourceMode' },
      { label: 'Focus Mode', command: 'toggleFocus', shortcut: 'F8', prefCheck: 'focusMode' },
      { label: 'Typewriter Mode', command: 'toggleTypewriter', shortcut: 'F9', prefCheck: 'typewriterMode' },
      sep,
      { label: 'Zoom In', command: 'zoomIn', shortcut: '⇧⌘=' },
      { label: 'Zoom Out', command: 'zoomOut', shortcut: '⇧⌘-' },
      { label: 'Actual Size', command: 'actualSize', shortcut: '⇧⌘0' },
      sep,
      { label: 'Toggle Fullscreen', command: 'fullscreen', shortcut: '⌃⌘F' },
      { label: 'Spellcheck', prefCheck: 'spellcheck' },
    ],
  },
  {
    label: 'Theme',
    items: [
      { label: 'GitHub', command: 'theme', payload: 'github', themeCheck: 'github' },
      { label: 'Gothic', command: 'theme', payload: 'gothic', themeCheck: 'gothic' },
      { label: 'Night', command: 'theme', payload: 'night', themeCheck: 'night' },
      { label: 'Newsprint', command: 'theme', payload: 'newsprint', themeCheck: 'newsprint' },
      { label: 'Pixyll', command: 'theme', payload: 'pixyll', themeCheck: 'pixyll' },
      { label: 'Whitey', command: 'theme', payload: 'whitey', themeCheck: 'whitey' },
    ],
  },
  {
    label: 'Window',
    items: [
      { label: 'Minimize', command: 'minimize', shortcut: '⌘M', disabledInBrowser: true },
      { label: 'Close Window', command: 'close', shortcut: '⇧⌘W', disabledInBrowser: true },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'About Scribeleaf', command: 'about' },
      { label: 'Welcome & Sample Document', command: 'openSample' },
      sep,
      { label: 'Scribeleaf on GitHub', command: 'openExternal', payload: 'https://github.com/xdlkc/scribeleaf' },
    ],
  },
];
