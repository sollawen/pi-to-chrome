/**
 * showDomTree - Show DOM subtree structure as a tree diagram
 * Extracted from tools/show-dom-tree.ts
 *
 * Usage in browser console:
 *   showDomTree({ selector: '#my-container' })
 *   showDomTree({ selector: '#my-container', depth: 5 })
 */

function showDomTree(params) {
  var sel = params.selector;
  var maxD = params.depth !== undefined ? params.depth : 3;

  var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
  var MAX_SIBLINGS = 5;
  var MAX_TEXT_LEN = 40;
  var MAX_CLASSES = 3;

  function buildNode(el, depth, maxDepth) {
    var tag = el.tagName.toLowerCase();
    var id = el.id || null;
    var classes = Array.from(el.classList).slice(0, MAX_CLASSES);
    var hasShadowRoot = el.shadowRoot !== null;

    // Direct text children only (no descendant text)
    var directText = '';
    for (var ci = 0; ci < el.childNodes.length; ci++) {
      var child = el.childNodes[ci];
      if (child.nodeType === Node.TEXT_NODE) {
        directText += child.textContent || '';
      }
    }
    directText = directText.trim();
    var text = directText.length > 0 ? directText.slice(0, MAX_TEXT_LEN) : null;

    var children = [];
    var truncated = 0;

    if (depth < maxDepth && !hasShadowRoot) {
      var childElements = Array.from(el.children).filter(function(c) { return !SKIP_TAGS.has(c.tagName); });

      for (var i = 0; i < Math.min(childElements.length, MAX_SIBLINGS); i++) {
        children.push(buildNode(childElements[i], depth + 1, maxDepth));
      }
      truncated = Math.max(0, childElements.length - MAX_SIBLINGS);
    }

    return { tag: tag, id: id, classes: classes, text: text, hasShadowRoot: hasShadowRoot, children: children, truncated: truncated };
  }

  function formatElementLabel(tag, id, classes) {
    var label = '<' + tag;
    if (id) label += '#' + id;
    if (classes.length > 0) label += '.' + classes.join('.');
    label += '>';
    return label;
  }

  function formatTree(node, prefix, isLast, isRoot) {
    var label = formatElementLabel(node.tag, node.id, node.classes);

    if (node.hasShadowRoot) label += ' [shadow-root]';
    if (node.text) label += ' "' + node.text + '"';

    var result = '';
    if (isRoot) {
      result = label + '\n';
    } else {
      result = prefix + (isLast ? '└─ ' : '├─ ') + label + '\n';
    }

    var childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      var childIsLast = i === node.children.length - 1 && node.truncated === 0;
      result += formatTree(child, childPrefix, childIsLast, false);
    }

    if (node.truncated > 0) {
      result += childPrefix + '... 还有 ' + node.truncated + ' 个子节点省略\n';
    }

    return result;
  }

  var root = document.querySelector(sel);
  if (!root) {
    var msg = '未找到匹配 "' + sel + '" 的元素';
    console.log(msg);
    return null;
  }

  var tree = buildNode(root, 0, maxD);
  var summary = formatTree(tree, '', false, true);

  console.log(summary);
  return { content: [{ type: 'text', text: summary }], details: { tree: tree } };
}
