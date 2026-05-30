/**
 * chrome_find_elements v2 - Search for elements by text keywords
 *
 * New matching: Tier 1 (id/text-exact) > Tier 2 (class/attr) > Tier 3 (text-substr/tag)
 * Deduplication keeps deepest descendants, discards ancestors.
 * Selector is guaranteed unique via CSS path + nth-child fallback.
 */

import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

const DEBUG = false;

export const findElementsTool: ToolDefinition<{ text: string }> = {
  name: 'chrome_find_elements',
  label: 'Chrome Find Elements',
  description: '搜索当前页面上的元素。关键词同时匹配文本、class、id、标签名等，智能排序返回最相关的结果。',
  promptSnippet: '定位元素的 CSS selector',
  promptGuidelines: [
    '【定位元素的第一步】当你需要调试页面问题时，先用 chrome_find_elements 找到目标元素的 CSS selector，再用 chrome_trace_css 查样式来源、chrome_show_dom_tree 查结构、chrome_check_layout 查布局。',
    'text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"',
    '拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"',
    '返回的 selector 可直接传给 chrome_trace_css / chrome_show_dom_tree / chrome_check_layout。',
    '如果返回了多个结果，挑选目标元素对应的 selector 使用。'
  ],
  parameters: Type.Object({
    text: Type.String({
      description: '搜索关键词，/ 分隔多关键词（OR）。同时匹配文本、class、id、标签名等。'
    })
  }),

  async execute(page, params) {
    if (!params.text || params.text.trim().length === 0) {
      throw new Error('请提供搜索关键词');
    }

    const keywords = params.text
      .split('/')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);

    if (keywords.length === 0) {
      throw new Error('请提供搜索关键词');
    }

    const results = await page.evaluate(
      (keywords: string[], debug: boolean) => {
        // ╔══════════════════════════════════════════════╗
        // ║  Browser-side: no external vars, no imports ║
        // ╚══════════════════════════════════════════════╝

        // ─── Types (inline) ───────────────────────────
        interface MatchResult {
          tier: 1 | 2 | 3;
          matchedBy: string;
          matchedKeyword: string;
        }

        interface MatchWithEl {
          el: Element;
          match: MatchResult;
          area: number;
          y: number;
        }

        interface FindElementResult {
          selector: string;
          tag: string;
          id: string | null;
          classes: string[];
          text: string;
          ancestors: string;
          rect: { x: number; y: number; w: number; h: number } | null;
          _debug?: {
            tier: number;
            matchedBy: string;
            matchedKeyword: string;
            area: number;
          };
        }

        // ─── isVisible ─────────────────────────────────
        function isVisible(el: Element): boolean {
          if (el.tagName === 'BODY') return true;
          if ((el as HTMLElement).offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          return true;
        }

        // ─── matchElement ──────────────────────────────
        function matchElement(el: Element, keywords: string[]): MatchResult | null {
          let bestTier = 99;
          let matchedBy = '';
          let matchedKeyword = '';

          const textContent = (el.textContent || '').trim().toLowerCase();
          const idLower = el.id.toLowerCase();
          const tagLower = el.tagName.toLowerCase();
          const classes = Array.from(el.classList);
          const SKIP_ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

          for (const keyword of keywords) {
            // ── Tier 1: 精准 ──
            if (idLower.includes(keyword)) {
              if (1 < bestTier) {
                bestTier = 1;
                matchedBy = 'id:' + el.id;
                matchedKeyword = keyword;
              }
            }
            if (textContent === keyword) {
              if (1 < bestTier) {
                bestTier = 1;
                matchedBy = 'text-exact';
                matchedKeyword = keyword;
              }
            }

            // ── Tier 2: 语义 ──
            if (bestTier > 2) {
              for (const cls of classes) {
                if (cls.toLowerCase().includes(keyword)) {
                  if (2 < bestTier) {
                    bestTier = 2;
                    matchedBy = 'class:' + cls;
                    matchedKeyword = keyword;
                  }
                }
              }
            }

            if (bestTier > 2) {
              for (const attr of SKIP_ATTRS) {
                const val = el.getAttribute(attr);
                if (val && val.toLowerCase().includes(keyword)) {
                  if (2 < bestTier) {
                    bestTier = 2;
                    matchedBy = 'attr:' + attr;
                    matchedKeyword = keyword;
                  }
                }
              }
            }

            // ── Tier 3: 模糊 ──
            if (textContent.includes(keyword)) {
              if (3 < bestTier) {
                bestTier = 3;
                matchedBy = 'text-substr';
                matchedKeyword = keyword;
              }
            }
            if (tagLower === keyword) {
              if (3 < bestTier) {
                bestTier = 3;
                matchedBy = 'tag:' + tagLower;
                matchedKeyword = keyword;
              }
            }
          }

          return bestTier === 99 ? null : { tier: bestTier as 1 | 2 | 3, matchedBy, matchedKeyword };
        }

        // ─── deduplicate ───────────────────────────────
        function deduplicate(matches: MatchWithEl[]): MatchWithEl[] {
          return matches.filter(m =>
            !matches.some(n => n !== m && m.el.contains(n.el))
          );
        }

        // ─── rank ──────────────────────────────────────
        function rank(matches: MatchWithEl[]): void {
          matches.sort((a, b) => {
            const tierDiff = a.match.tier - b.match.tier;
            if (tierDiff !== 0) return tierDiff;
            if (a.area !== b.area) return a.area - b.area;
            return a.y - b.y;
          });
        }

        // ─── buildAncestorPath ──────────────────────────
        function buildAncestorPath(el: Element): string {
          const parts: string[] = [];
          let current = el.parentElement;
          let count = 0;
          while (current && current !== document.body && count < 5) {
            let s = current.tagName.toLowerCase();
            if (current.id) {
              s += '#' + current.id;
            }
            const cls = Array.from(current.classList).slice(0, 3);
            if (cls.length > 0) {
              s += '.' + cls.join('.');
            }
            parts.push(s);
            current = current.parentElement;
            count++;
          }
          return parts.join(' > ');
        }

        // ─── buildSelector ──────────────────────────────
        function buildSelector(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const allClasses = Array.from(el.classList);

          // Strategy 1: id
          if (el.id) {
            const candidate = '#' + el.id;
            if (document.querySelectorAll(candidate).length === 1) {
              return candidate;
            }
          }

          // Strategy 2: tag + all classes
          if (allClasses.length > 0) {
            const candidate = tag + '.' + allClasses.join('.');
            if (document.querySelectorAll(candidate).length === 1) {
              return candidate;
            }
          }

          // Strategy 3: ancestor path
          const path: string[] = [
            tag + (allClasses.length > 0 ? '.' + allClasses.join('.') : '')
          ];
          let current = el.parentElement;
          while (current && current !== document.body) {
            let level = current.tagName.toLowerCase();
            if (current.id) {
              level += '#' + current.id;
            }
            const cls = Array.from(current.classList);
            if (cls.length > 0) {
              level += '.' + cls.join('.');
            }
            path.unshift(level);
            const candidate = path.join(' > ');
            if (document.querySelectorAll(candidate).length === 1) {
              return candidate;
            }
            current = current.parentElement;
          }

          // Strategy 4: nth-child fallback
          if (!el.parentElement) {
            return tag;
          }
          const parentChildren = el.parentElement.children;
          const index = Array.from(parentChildren).indexOf(el) + 1;
          return path.join(' > ') + ':nth-child(' + index + ')';
        }

        // ─── buildResult ───────────────────────────────
        function buildResult(el: Element, matchInfo: MatchResult, debug: boolean): FindElementResult {
          const rect = el.getBoundingClientRect();
          const result: FindElementResult = {
            selector: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: Array.from(el.classList).slice(0, 10),
            text: (el.textContent || '').trim().slice(0, 80),
            ancestors: buildAncestorPath(el),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          };

          if (debug) {
            result._debug = {
              tier: matchInfo.tier,
              matchedBy: matchInfo.matchedBy,
              matchedKeyword: matchInfo.matchedKeyword,
              area: Math.round(rect.width * rect.height)
            };
          }

          return result;
        }

        // ─── searchElements (main entry) ───────────────
        function searchElements(keywords: string[]): FindElementResult[] {
          const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT']);
          const matches: MatchWithEl[] = [];

          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            null
          );

          let node: Node | null = walker.currentNode;
          while (node) {
            const el = node as Element;
            if (!SKIP_TAGS.has(el.tagName)) {
              const match = matchElement(el, keywords);
              if (match !== null && isVisible(el)) {
                const rect = el.getBoundingClientRect();
                matches.push({ el, match, area: rect.width * rect.height, y: rect.y });
                // 截断保护：大页面避免后续 deduplicate O(n²) 过慢
                if (matches.length > 500) break;
              }
            }
            node = walker.nextNode();
          }

          // 截断保护触发时，先粗排再截断，保留高质量结果
          if (matches.length > 500) {
            rank(matches);
            matches.length = 500;
          }

          const deduped = deduplicate(matches);
          rank(deduped);

          const top15 = deduped.slice(0, 15);
          return top15.map(m => buildResult(m.el, m.match, debug));
        }

        return searchElements(keywords);
      },
      keywords,
      DEBUG
    );

    const summaryLines = [`找到 ${results.length} 个匹配「${params.text}」的元素:`, ''];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];

      // 标签描述: <tag.class1.class2#id>
      let label = `<${r.tag}`;
      if (r.classes.length > 0) {
        label += '.' + r.classes.slice(0, 3).join('.');
      }
      if (r.id) {
        label += '#' + r.id;
      }
      label += '>';

      // 文本内容（截断 40 字符）
      const text = r.text ? ` "${r.text.slice(0, 40)}"` : '';

      summaryLines.push(`${i + 1}. ${label}${text}`);
      summaryLines.push(`   selector: ${r.selector}`);
    }

    const summary = summaryLines.join('\n');

    return {
      content: [{ type: 'text', text: summary }],
      details: { total: results.length, results }
    };
  }
};