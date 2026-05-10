/**
 * 将 Claude 的 Markdown 输出转换为飞书消息卡片 JSON
 */
export function formatAsCard(content: string, options: {
  title?: string;
  isFinal: boolean;
}): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: options.title || (options.isFinal ? 'Claude Code' : 'Claude Code (thinking...)'),
      },
      template: options.isFinal ? 'blue' : 'wathet',
    },
    elements: [
      {
        tag: 'markdown',
        content: truncate(content),
      },
      ...(options.isFinal ? [] : [{
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '⏳ 处理中...' }],
      }]),
    ],
  };

  return JSON.stringify(card);
}

/** 飞书卡片 Markdown 有大小限制，截断过长内容 */
function truncate(content: string, maxLen = 30_000): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '\n\n---\n*[内容已截断，总长度: ' + content.length + ' 字符]*';
}
