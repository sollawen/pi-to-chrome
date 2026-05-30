/**
 * chrome_show_dom_tree - 向下展开 DOM 子树，以树状结构清晰展示嵌套关系
 */

import { Type } from '@sinclair/typebox';
import { validateSelectorUniqueness, formatElementLabel } from '../core/selector-utils';
import type { ToolDefinition, ToolResult } from '../core/types';

// ─── Tree node type (shared between page.evaluate and formatter) ─────────

interface TreeNode {
  tag: string;
  id: string | null;
  classes: string[];
  text: string | null;
  hasShadowRoot: boolean;
  children: TreeNode[];
  truncated: number;
}

// ─── Tree formatting ──────────────────────────────────────────────────────────

function formatTree(node: TreeNode, prefix = '', isLast = true, isRoot = true): string {
  let label = formatElementLabel(node.tag, node.id, node.classes);

  if (node.hasShadowRoot) label += ' [shadow-root]';
  if (node.text) label += ` "${node.text}"`;

  let result = '';
  if (isRoot) {
    result = label + '\n';
  } else {
    result = prefix + (isLast ? '└─ ' : '├─ ') + label + '\n';
  }

  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childIsLast = i === node.children.length - 1 && node.truncated === 0;
    result += formatTree(child, childPrefix, childIsLast, false);
  }

  if (node.truncated > 0) {
    result += childPrefix + `... 还有 ${node.truncated} 个子节点省略\n`;
  }

  return result;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const TOOL_NAME = 'chrome_show_dom_tree';

export const showDomTreeTool: ToolDefinition = {
  name: TOOL_NAME,
  label: 'Chrome Show DOM Tree',
  description: '查看指定元素的 DOM 子树结构。以树状图展示嵌套关系、标签名、class、id 和文本内容。',
  promptSnippet: '查看 DOM 子树结构',
  promptGuidelines: [
    '【查看元素结构】当需要了解某个容器内部的 HTML 结构、子元素关系时使用。先用 chrome_find_elements 定位，再用 chrome_show_dom_tree 查看结构。',
    '默认展开 3 层深度。嵌套较深时可指定更大的 depth 值。',
    '只向下展开子树，不显示祖先链。如需查看祖先布局信息，用 chrome_check_layout。',
    '同级兄弟超过 5 个时自动截断，避免输出过长。',
    '遇到 open shadow DOM 时显示 [shadow-root] 标记，不展开。closed shadow DOM 无法检测。如需查看 shadow DOM 内部，通过 chrome_execute_js 使用 element.shadowRoot.querySelector() 手动穿透。'
  ],

  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector，应定位到唯一元素' }),
    depth: Type.Optional(Type.Number({
      description: '最大展开深度，默认 3',
      minimum: 1,
      maximum: 10,
      default: 3
    }))
  }),

  async execute(page, params): Promise<ToolResult> {
    // 1. 验证 selector 唯一性
    const validation = await validateSelectorUniqueness(page, params.selector);
    if (!validation.ok) {
      if (validation.kind === 'not_found') {
        throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
      }
      if (validation.kind === 'invalid') {
        throw new Error(`❌ 无效的 CSS selector: ${params.selector}\n${validation.message}`);
      }
      if (validation.kind === 'multiple') {
        const list = validation.items.map((item, i) =>
          `${i + 1}. <${item.tag}> "${item.text}"\n   → ${item.nthSelector}`
        ).join('\n');
        throw new Error(`❌ 该 selector 匹配了 ${validation.count} 个元素，请指定唯一元素:\n\n${list}`);
      }
    }

    // 2. 在 page.evaluate 内构建树（一次 round-trip）
    const maxDepth = params.depth ?? 3;
    const tree = await page.evaluate(
      (sel: string, maxD: number) => {
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
        const MAX_SIBLINGS = 5;
        const MAX_TEXT_LEN = 40;
        const MAX_CLASSES = 3;

        function buildNode(el: Element, depth: number, maxDepth: number) {
          const tag = el.tagName.toLowerCase();
          const id = el.id || null;
          const classes = Array.from(el.classList).slice(0, MAX_CLASSES);
          const hasShadowRoot = el.shadowRoot !== null;

          // Direct text children only (no descendant text)
          let directText = '';
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              directText += child.textContent || '';
            }
          }
          directText = directText.trim();
          const text = directText.length > 0 ? directText.slice(0, MAX_TEXT_LEN) : null;

          const children: any[] = [];
          let truncated = 0;

          if (depth < maxDepth && !hasShadowRoot) {
            const childElements = Array.from(el.children).filter(c => !SKIP_TAGS.has(c.tagName));

            for (let i = 0; i < Math.min(childElements.length, MAX_SIBLINGS); i++) {
              children.push(buildNode(childElements[i], depth + 1, maxDepth));
            }
            truncated = Math.max(0, childElements.length - MAX_SIBLINGS);
          }

          return { tag, id, classes, text, hasShadowRoot, children, truncated };
        }

        const root = document.querySelector(sel) as Element;
        return buildNode(root, 0, maxD);
      },
      params.selector,
      maxDepth
    );

    // 3. 格式化输出
    const summary = formatTree(tree);

    return {
      content: [{ type: 'text', text: summary }],
      details: { tree }
    };
  }
};