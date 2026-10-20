const language = navigator.language.toLowerCase();
export const usesSimplifiedChinese = language.startsWith('zh') && !/hant|-(tw|hk|mo)\b/.test(language);
const labels: Record<string, string> = {
  Files: '文件', Outline: '大纲', 'No Folder': '未打开文件夹',
  'Document List': '文档列表', 'File Tree': '文件树',
  'Filter files…': '筛选文件…', 'Open a folder to browse files': '打开文件夹以浏览文件',
  'No matching files': '没有匹配文件', 'No headings': '暂无标题',
  'Toggle Sidebar': '显示／隐藏侧边栏', 'Click to change count unit': '点击切换统计单位',
  Preferences: '偏好设置',
  Exported: '已导出',
  'Export with Previous': '使用上一次设置导出',
  'Export and Overwrite with Previous': '导出并覆盖上一次导出的文件',
};
export function uiText(english: string): string {
  return usesSimplifiedChinese ? labels[english] ?? english : english;
}
