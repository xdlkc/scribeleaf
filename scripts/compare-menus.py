"""Compare the captured product menu labels; this does not prove behavior parity."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
aliases = {
    'Scribeleaf': 'Typora', '另存为': '保存为', '偏好设置': '设置',
    '表格…': '表格', '超链接…': '超链接', '图像…': '图像',
    'Markdown 参考': 'Markdown Reference', 'GitHub': 'Github',
    '进入全屏': '全屏', '复制文稿': '复制',
}

def normalized(text):
    text = text.rstrip('….')
    return aliases.get(text, text)

def entries(node, parents=()):
    title = node.get('title', '')
    path = parents + ((title,) if title else ())
    children = node.get('children', [])
    if node.get('role') == 'AXMenuItem' and title:
        yield {'path': list(path), 'key': node.get('key', ''),
               'modifiers': node.get('modifiers', 8), 'virtualKey': node.get('virtualKey'),
               'hasSubmenu': bool(children)}
    for child in children:
        yield from entries(child, path)

reference = json.loads((root / 'evidence/typora-menus.json').read_text())
replica = json.loads((root / 'evidence/replica-menus.json').read_text())
target = list(entries(reference['menu']))
actual = list(entries(replica['menu']))
rows = []
for item in target:
    path = item['path']
    # Cocoa/OS generated Window controls are retained in the capture, but not
    # counted as manually implemented product features by this comparison.
    if path[0] == '窗口':
        continue
    matches = [candidate for candidate in actual
               if normalized(candidate['path'][0]) == normalized(path[0])
               and normalized(candidate['path'][-1]) == normalized(path[-1])]
    row = dict(item)
    row['labelFound'] = bool(matches)
    row['replicaPaths'] = [m['path'] for m in matches]
    row['keyFound'] = any(m['key'].lower() == item['key'].lower()
                          and m['modifiers'] == item['modifiers'] for m in matches)
    rows.append(row)

data = {'reference': reference['capturedAt'], 'replica': replica['capturedAt'],
        'scope': 'Product menu labels and key attributes only. Presence does not prove behavior. '
                 'Dynamic user documents, Services, Apple and OS Window controls excluded.',
        'totalReferenceItems': len(rows), 'labelsFound': sum(r['labelFound'] for r in rows),
        'items': rows}
(root / 'evidence/menu-comparison.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
lines = ['# 菜单实机差距表', '',
         '仅对照菜单入口。`入口已找到` 不代表行为、启用条件或视觉已验收。',
         '原版与副本可能不是同一焦点状态，因此不据 enabled 字段推断功能缺失。',
         '动态文档、服务、Apple 菜单及 macOS 自动 Window 控件不计入下表。', '',
         '| 原版菜单路径 | 副本入口 | 快捷键属性 |', '| --- | --- | --- |']
for row in rows:
    path = ' → '.join(row['path']).replace('|', '\\|')
    found = '入口已找到' if row['labelFound'] else '待补齐或核实名称'
    key = '一致' if row['keyFound'] else '待核实'
    lines.append(f'| {path} | {found} | {key} |')
(root / 'PARITY-MENUS.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({k: data[k] for k in ['totalReferenceItems', 'labelsFound']}, ensure_ascii=False))
