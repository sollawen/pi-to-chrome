/**
 * checkLayout - Check element layout properties and dimensions
 * Extracted from tools/check-layout.ts
 *
 * Usage in browser console:
 *   checkLayout({ selector: '#my-element' })
 *   checkLayout({ selector: '#my-element', ancestors: 5 })
 */

function checkLayout(params) {
  var sel = params.selector;
  var ancestorCount = params.ancestors !== undefined ? params.ancestors : 5;

  // 元素自身收集的属性
  var LAYOUT_PROPS = [
    'display', 'overflow-x', 'overflow-y',
    'position', 'height', 'min-height', 'max-height',
    'flex-direction', 'flex-wrap', 'box-sizing'
  ];

  // 祖先链每层收集的属性
  var ANCESTOR_PROPS = [
    'display', 'overflow', 'height', 'min-height', 'max-height',
    'position', 'box-sizing'
  ];

  function collectLayoutProps(el) {
    var computed = getComputedStyle(el);
    var props = {};
    for (var pi = 0; pi < LAYOUT_PROPS.length; pi++) {
      var prop = LAYOUT_PROPS[pi];
      var val = computed.getPropertyValue(prop);
      if (val) props[prop] = val;
    }
    return props;
  }

  function collectDimensions(el) {
    return {
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    };
  }

  function formatLabel(el) {
    var tag = el.tagName.toLowerCase();
    var id = el.id;
    var classes = Array.from(el.classList).slice(0, 3);
    var label = '<' + tag;
    if (id) label += '#' + id;
    if (classes.length > 0) label += '.' + classes.join('.');
    label += '>';
    return label;
  }

  function collectAncestorProps(el) {
    var computed = getComputedStyle(el);
    var props = {};
    for (var pi = 0; pi < ANCESTOR_PROPS.length; pi++) {
      var prop = ANCESTOR_PROPS[pi];
      var val = computed.getPropertyValue(prop);
      if (val && val !== 'normal') {
        props[prop] = val;
      }
    }
    return props;
  }

  var el = document.querySelector(sel);
  if (!el) {
    var msg = '未找到匹配 "' + sel + '" 的元素';
    console.log(msg);
    return null;
  }

  var label = formatLabel(el);
  var layoutProps = collectLayoutProps(el);
  var dimensions = collectDimensions(el);

  // 祖先链
  var ancestors = [];
  if (ancestorCount > 0) {
    var current = el.parentElement;
    var depth = 0;
    while (current && depth < ancestorCount) {
      var props = collectAncestorProps(current);
      var parts = [];
      var keys = Object.keys(props);
      for (var ki = 0; ki < keys.length; ki++) {
        var prop = keys[ki];
        parts.push(prop + ':' + props[prop]);
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

  var data = { label: label, layoutProps: layoutProps, dimensions: dimensions, ancestors: ancestors };

  // ─── Format output ─────────────────────────────
  var lines = [];

  lines.push('== 布局信息: ' + data.label + ' ==');
  lines.push('');

  lines.push('元素布局属性:');
  var displayOrder = [
    'display', 'position', 'box-sizing',
    'overflow-x', 'overflow-y',
    'height', 'min-height', 'max-height',
    'flex-direction', 'flex-wrap'
  ];
  for (var doi = 0; doi < displayOrder.length; doi++) {
    var prop = displayOrder[doi];
    var val = data.layoutProps[prop];
    if (val !== undefined) {
      lines.push('  ' + prop + ': ' + val);
    }
  }
  lines.push('');

  lines.push('尺寸数值:');
  var d = data.dimensions;
  lines.push('  垂直: offsetHeight=' + d.offsetHeight + '  scrollHeight=' + d.scrollHeight + '  clientHeight=' + d.clientHeight);
  lines.push('  水平: offsetWidth=' + d.offsetWidth + '   scrollWidth=' + d.scrollWidth + '    clientWidth=' + d.clientWidth);

  if (data.ancestors.length > 0) {
    lines.push('');
    lines.push('== 祖先链 (向上 ' + ancestorCount + ' 层) ==');
    lines.push('');

    for (var i = 0; i < data.ancestors.length; i++) {
      var ancestor = data.ancestors[i];
      if (i === 0) {
        lines.push(ancestor.label + ' [' + ancestor.propsSummary + ']');
      } else {
        var indent = '';
        for (var j = 0; j < i - 1; j++) indent += '  ';
        lines.push(indent + '  └─ ' + ancestor.label + ' [' + ancestor.propsSummary + ']');
      }
    }
  }

  var summary = lines.join('\n');
  console.log(summary);
  return { content: [{ type: 'text', text: summary }], details: data };
}
