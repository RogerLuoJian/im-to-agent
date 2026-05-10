/**
 * 企业微信消息格式化
 *
 * 企微 Markdown 消息限制:
 * - 最大 2048 字节
 * - 支持: 标题、加粗、链接、行内代码、引用、字体颜色
 * - 不支持: 表格、图片内嵌
 * - 代码块: 实际可渲染，但非官方文档列出
 *
 * 文档: https://developer.work.weixin.qq.com/document/path/90236
 */

const MAX_MARKDOWN_BYTES = 2048;

/** 构造发送给企微 API 的 Markdown 消息体 */
export function formatAsMarkdown(
  content: string,
  options: { isFinal: boolean },
): object {
  let text = adaptMarkdown(content);

  if (!options.isFinal) {
    text += '\n\n<font color="comment">⏳ 处理中...</font>';
  }

  text = truncateByBytes(text, MAX_MARKDOWN_BYTES);

  return {
    msgtype: 'markdown',
    markdown: { content: text },
  };
}

/** 构造文本消息体 */
export function formatAsText(content: string): object {
  return {
    msgtype: 'text',
    text: { content },
  };
}

/**
 * 将标准 Markdown 适配为企微支持的子集
 * - 表格 → 缩进纯文本
 * - 图片 → 链接
 */
function adaptMarkdown(content: string): string {
  let result = content;

  // 将图片 ![alt](url) 转为链接 [📷 alt](url)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[📷 $1]($2)');

  // 将简单表格转为缩进文本
  result = convertTables(result);

  return result;
}

/** 将 Markdown 表格转为缩进纯文本 */
function convertTables(content: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 检测表格行（包含 | 分隔符）
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // 收集整个表格
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      // 解析表格
      const rows = tableLines
        .filter((l) => !/^\s*\|[\s:-]+\|\s*$/.test(l)) // 过滤分隔行
        .map((l) =>
          l
            .split('|')
            .slice(1, -1) // 去掉首尾空元素
            .map((cell) => cell.trim()),
        );

      // 转为缩进文本
      if (rows.length > 0) {
        const header = rows[0];
        for (let r = 1; r < rows.length; r++) {
          const row = rows[r];
          const parts = header.map((h, idx) => `**${h}**: ${row[idx] ?? ''}`);
          output.push(parts.join('  |  '));
        }
        // 如果只有表头没有数据行
        if (rows.length === 1) {
          output.push(rows[0].map((h) => `**${h}**`).join('  |  '));
        }
      }
    } else {
      output.push(line);
      i++;
    }
  }

  return output.join('\n');
}

/** 按字节数截断 UTF-8 字符串 */
function truncateByBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;

  // 预留截断提示的空间
  const suffix = '\n\n---\n*[内容已截断]*';
  const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
  const targetBytes = maxBytes - suffixBytes;

  // 逐字符累积，确保不截断多字节字符
  let byteCount = 0;
  let charIndex = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (byteCount + charBytes > targetBytes) break;
    byteCount += charBytes;
    charIndex += char.length;
  }

  return text.slice(0, charIndex) + suffix;
}
