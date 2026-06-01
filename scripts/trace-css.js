/**
 * traceCss - Trace CSS style sources for an element
 * Extracted from tools/trace-css.ts
 *
 * Uses CSSOM (document.styleSheets) to identify which file
 * each CSS rule comes from.
 *
 * Usage in browser console:
 *   traceCss({ selector: '#my-element' })
 */

function traceCss(params) {
  var sel = params.selector;

  // ─── Get element info ────────────────────────────
  var el = document.querySelector(sel);
  if (!el) {
    var msg1 = '未找到匹配 "' + sel + '" 的元素';
    console.log(msg1);
    return null;
  }

  var elementInfo = {
    tagName: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el.className
      ? Array.from(el.classList).filter(function(c) { return typeof c === 'string'; }).slice(0, 10)
      : [],
    text: (el.textContent || '').trim().slice(0, 100).replace(/\s+/g, ' '),
    boundingRect: (function() {
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()
  };

  // ─── Collect CSS rules ───────────────────────────
  var rules = [];

  // Helper: extract meaningful properties (skip initial/inherit/unset/revert)
  var SKIP_VALUES = new Set(['initial', 'inherit', 'unset', 'revert', '']);
  function extractProps(style) {
    var result = [];
    for (var i = 0; i < style.length; i++) {
      var name = style[i];
      var value = style.getPropertyValue(name);
      if (SKIP_VALUES.has(value)) continue;
      var priority = style.getPropertyPriority(name);
      result.push({ name: name, value: value, important: priority === 'important' });
    }
    return result;
  }

  // 1. Inline style
  if (el instanceof HTMLElement && el.style && el.style.cssText) {
    rules.push({
      type: 'inline',
      source: 'inline style',
      selector: '<inline>',
      properties: el.style.cssText,
      propertiesDetailed: extractProps(el.style)
    });
  }

  // 2. Traverse document.styleSheets to find matching rules
  var sheets = Array.from(document.styleSheets);
  for (var si = 0; si < sheets.length; si++) {
    var sheet = sheets[si];

    // Determine source filename
    var source = '<style>';
    if (sheet.href) {
      var urlParts = sheet.href.split('/');
      source = urlParts[urlParts.length - 1] || sheet.href;
      source = source.split('?')[0];
    }

    try {
      var cssRules = sheet.cssRules;
      for (var ri = 0; ri < cssRules.length; ri++) {
        var rule = cssRules[ri];
        if (rule instanceof CSSStyleRule) {
          try {
            // try/catch here for vendor-prefixed selector safety
            if (el.matches(rule.selectorText)) {
              rules.push({
                type: 'regular',
                source: source,
                selector: rule.selectorText,
                properties: rule.style.cssText,
                propertiesDetailed: extractProps(rule.style)
              });
            }
          } catch (e) {
            // Selector might have compatibility issues with el.matches()
          }
        }
      }
    } catch (e) {
      // Cross-origin stylesheet, cannot access cssRules
    }
  }

  // ─── Build summary ─────────────────────────────
  var summaryLines = [
    '元素 <' + elementInfo.tagName + '> 的 CSS 层叠链 (' + rules.length + ' 条规则):'
  ];

  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    summaryLines.push('  ' + (i + 1) + '. [' + rule.type + '] ' + rule.source);
    summaryLines.push('     选择器: ' + rule.selector);

    if (rule.propertiesDetailed && rule.propertiesDetailed.length > 0) {
      var propLines = rule.propertiesDetailed.map(function(p) {
        return '  ' + p.name + ': ' + p.value + (p.important ? ' !important' : '');
      });
      summaryLines.push('     属性:');
      for (var pi = 0; pi < propLines.length; pi++) {
        summaryLines.push('    ' + propLines[pi]);
      }
    } else {
      summaryLines.push('     属性: ' + rule.properties);
    }
  }

  var summary = summaryLines.join('\n');
  console.log(summary);

  var result = { element: elementInfo, cssRules: rules };
  console.log(result);
  return { content: [{ type: 'text', text: summary }], details: { element: elementInfo, cssRules: rules } };
}
