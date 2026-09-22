# coding:utf-8
"""回复卡片使用的轻量文本格式化。

设计取舍：不引入重量级 Markdown 库（如 mistune/markdown），
只支持回复中实际出现的几种结构，保持依赖最小、渲染可预期。
"""

import re


# 用于快速判断文本是否含有块级 Markdown 结构；
# 纯聊天文本（无列表/代码块/标题）会走更轻量的 inline 路径，避免不必要的行分割
_STRUCTURED_RE = re.compile(r'(?m)^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|---+\s*$|```)', re.M)


def has_structured_markdown(text):
    """是否包含需要稳定块级布局的 Markdown。"""
    return bool(_STRUCTURED_RE.search(str(text or '')))


def _escape(text):
    # 在任何 HTML 拼接前先转义，防止 LLM 输出中的 < > & 破坏卡片布局
    return str(text or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _format_inline(text):
    html = _escape(text)
    html = re.sub(r'`([^`]+)`', r'<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;">\1</code>', html)
    html = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', html)
    html = re.sub(r'\*([^*]+)\*', r'<i>\1</i>', html)
    return html


def _paragraph(lines):
    text = '<br>'.join(_format_inline(line.strip()) for line in lines if line.strip())
    if not text:
        return ''
    return '<p style="margin:0 0 5px 0;">%s</p>' % text


def _list_item(marker, content):
    # 用 table 布局而非 CSS flexbox，因为 Qt 富文本引擎对 flex 支持不完整，
    # table 能保证标记符和正文第一行对齐且不超宽
    return (
        '<table width="100%%" cellspacing="0" cellpadding="0" style="margin:1px 0 3px 0;">'
        '<tr>'
        '<td valign="top" width="14" style="padding:0 5px 0 0;">%s</td>'
        '<td valign="top" style="padding:0;">%s</td>'
        '</tr>'
        '</table>'
    ) % (_escape(marker), _format_inline(content.strip()))


def markdown_to_html(text):
    """支持回复卡片里常用的少量 Markdown，并先做 HTML 转义。

    两条路径：
    1. 无块级结构 → 只做 inline 格式化 + 换行转 <br>，性能更好
    2. 有块级结构 → 逐行状态机解析，维护 paragraph_lines 缓冲，
       遇到代码块开关符时切换 in_code 状态，代码块内容原样输出避免误格式化
    """
    if not text:
        return ''
    raw = str(text).replace('\r\n', '\n').replace('\r', '\n').strip()
    # 强制压缩：所有连续换行（段落空行）一律压成单换行，避免段落间隙
    # 造成卡片高度跳变；单换行仍转 <br> 保留分行
    raw = re.sub(r'\n{2,}', '\n', raw)
    if not has_structured_markdown(raw):
        html = _format_inline(raw)
        return html.replace('\n', '<br>')
    lines = raw.split('\n')
    blocks = []
    paragraph_lines = []
    in_code = False
    code_lines = []

    def flush_paragraph():
        if paragraph_lines:
            block = _paragraph(paragraph_lines)
            if block:
                blocks.append(block)
            paragraph_lines.clear()

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('```'):
            if in_code:
                blocks.append(
                    '<pre style="background:#f5f5f5;padding:7px;border-radius:5px;margin:4px 0;white-space:pre-wrap;">%s</pre>'
                    % _escape('\n'.join(code_lines))
                )
                code_lines = []
                in_code = False
            else:
                flush_paragraph()
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue

        if not stripped:
            flush_paragraph()
            continue
        if re.match(r'^---+\s*$', stripped):
            # 分隔线不再渲染：线条宽度/高度随排版变化易产生跳动感，直接省略
            flush_paragraph()
            continue

        heading = re.match(r'^(#{1,6})\s+(.+)$', stripped)
        if heading:
            flush_paragraph()
            size = 16 if len(heading.group(1)) <= 2 else 14
            blocks.append('<p style="margin:2px 0 5px 0;font-size:%dpx;font-weight:700;">%s</p>' % (size, _format_inline(heading.group(2))))
            continue

        item = re.match(r'^(\s*)([-*+]|\d+[.)])\s+(.+)$', line)
        if item:
            flush_paragraph()
            blocks.append(_list_item(item.group(2), item.group(3)))
            continue

        paragraph_lines.append(line)

    flush_paragraph()
    if in_code:
        blocks.append(
            '<pre style="background:#f5f5f5;padding:7px;border-radius:5px;margin:4px 0;white-space:pre-wrap;">%s</pre>'
            % _escape('\n'.join(code_lines))
        )
    return ''.join(blocks)
