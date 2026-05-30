/**
 * chrome_check_layout - 检查元素的布局属性和尺寸数值，沿祖先链向上展示各层布局信息
 */

import { Type } from '@sinclair/typebox';
import { validateSelectorUniqueness } from '../core/selector-utils';
import type { ToolDefinition, ToolResult } from '../core/types';

// ─── Page evaluate types ──────────────────────────────────────────────────────

interface AncestorInfo {
  label: string;
  propsSummary: string;
}

interface LayoutData {
  label: string;
  layoutProps: Record<string, string>;
  dimensions: {
    offsetWidth: number;
    offsetHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  ancestors: AncestorInfo[];
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const TOOL_NAME = 'chrome_check_layout';

export const checkLayoutTool: ToolDefinition = {
  name: TOOL_NAME,
  label: 'Chrome Check Layout',
  description: '检查元素的布局属性和尺寸数值，沿祖先链向上展示各层布局信息。用于排查溢出、高度约束断裂、flex 布局等问题。',
  promptSnippet: '检查元素布局属性和尺寸',
  promptGuidelines: [
    '【排查布局问题】当内容溢出、滚动条异常、尺寸不对、flex/grid 不生效时，用 chrome_check_layout 查看元素的布局属性和尺寸数值。',
    '默认沿祖先链向上查 5 层，展示每层的 display、overflow、height、box-sizing 等属性。排查"高度约束断裂"时特别有用。',
    '工具只返回数据，不做诊断。请根据返回的数值自行判断问题所在。',
    '先找到元素: chrome_find_elements → chrome_check_layout(selector)',
    '如需查看样式来源（哪条规则设置的 display:flex），用 chrome_trace_css。'
  ],

  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector，应定位到唯一元素' }),
    ancestors: Type.Optional(Type.Number({
      description: '向上排查祖先链的层数，默认 5，设为 0 跳过',
      minimum: 0,
      maximum: 20,
      default: 5
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

    // 2. 收集布局数据
    const ancestorCount = params.ancestors ?? 5;
    const data = await page.evaluate(
      (sel: string, ancestorCount: number): LayoutData | null => {
        // 元素自身收集的属性
        const LAYOUT_PROPS = [
          'display', 'overflow-x', 'overflow-y',
          'position', 'height', 'min-height', 'max-height',
          'flex-direction', 'flex-wrap', 'box-sizing'
        ];

        // 祖先链每层收集的属性
        const ANCESTOR_PROPS = [
          'display', 'overflow', 'height', 'min-height', 'max-height',
          'position', 'box-sizing'
        ];

        function collectLayoutProps(el: Element): Record<string, string> {
          const computed = getComputedStyle(el);
          const props: Record<string, string> = {};
          for (const prop of LAYOUT_PROPS) {
            const val = computed.getPropertyValue(prop);
            if (val) props[prop] = val;
          }
          return props;
        }

        function collectDimensions(el: HTMLElement) {
          return {
            offsetWidth: el.offsetWidth,
            offsetHeight: el.offsetHeight,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight,
          };
        }

        function formatLabel(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const id = el.id;
          const classes = Array.from(el.classList).slice(0, 3);
          let label = '<' + tag;
          if (id) label += '#' + id;
          if (classes.length > 0) label += '.' + classes.join('.');
          label += '>';
          return label;
        }

        function collectAncestorProps(el: Element): Record<string, string> {
          const computed = getComputedStyle(el);
          const props: Record<string, string> = {};
          for (const prop of ANCESTOR_PROPS) {
            const val = computed.getPropertyValue(prop);
            if (val && val !== 'normal') {
              props[prop] = val;
            }
          }
          return props;
        }

        const el = document.querySelector(sel) as HTMLElement;
        if (!el) return null;

        const label = formatLabel(el);
        const layoutProps = collectLayoutProps(el);
        const dimensions = collectDimensions(el);

        // 祖先链
        const ancestors: AncestorInfo[] = [];
        if (ancestorCount > 0) {
          let current = el.parentElement;
          let depth = 0;
          while (current && depth < ancestorCount) {
            const props = collectAncestorProps(current);
            const parts: string[] = [];
            for (const [prop, val] of Object.entries(props)) {
              parts.push(`${prop}:${val}`);
            }
            ancestors.push({
              label: formatLabel(current),
              propsSummary: parts.join(', ')
            });

            // 到达 <html> 时停止（包含 <html> 本身）
            if (current === document.documentElement) break;
            current = current.parentElement;
            depth++;
          }
        }

        return { label, layoutProps, dimensions, ancestors };
      },
      params.selector,
      ancestorCount
    );

    if (!data) {
      throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
    }

    // 3. 格式化输出
    const summary = formatLayout(data, ancestorCount);

    return {
      content: [{ type: 'text', text: summary }],
      details: data
    };
  }
};

// ─── Formatting ────────────────────────────────────────────────────────────────

function formatLayout(data: LayoutData, ancestorCount: number): string {
  const lines: string[] = [];

  // 标题
  lines.push(`== 布局信息: ${data.label} ==`);
  lines.push('');

  // 元素布局属性
  lines.push('元素布局属性:');
  const displayOrder = [
    'display', 'position', 'box-sizing',
    'overflow-x', 'overflow-y',
    'height', 'min-height', 'max-height',
    'flex-direction', 'flex-wrap'
  ];
  for (const prop of displayOrder) {
    const val = data.layoutProps[prop];
    if (val !== undefined) {
      lines.push(`  ${prop}: ${val}`);
    }
  }
  lines.push('');

  // 尺寸数值
  lines.push('尺寸数值:');
  const d = data.dimensions;
  lines.push(`  垂直: offsetHeight=${d.offsetHeight}  scrollHeight=${d.scrollHeight}  clientHeight=${d.clientHeight}`);
  lines.push(`  水平: offsetWidth=${d.offsetWidth}   scrollWidth=${d.scrollWidth}    clientWidth=${d.clientWidth}`);

  // 祖先链
  if (data.ancestors.length > 0) {
    lines.push('');
    lines.push(`== 祖先链 (向上 ${ancestorCount} 层) ==`);
    lines.push('');

    for (let i = 0; i < data.ancestors.length; i++) {
      const ancestor = data.ancestors[i];
      if (i === 0) {
        lines.push(`${ancestor.label} [${ancestor.propsSummary}]`);
      } else {
        lines.push(`${'  '.repeat(i - 1)}  └─ ${ancestor.label} [${ancestor.propsSummary}]`);
      }
    }
  }

  return lines.join('\n');
}