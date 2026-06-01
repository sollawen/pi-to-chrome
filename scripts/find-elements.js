/**
 * findElements - Search for elements by text keywords
 * Extracted from tools/find-elements.ts
 *
 * Matching tiers: Tier 1 (id/text-exact) > Tier 2 (class/attr) > Tier 3 (text-substr/tag)
 * Deduplication keeps deepest descendants, discards ancestors.
 * Selector is guaranteed unique via CSS path + nth-child fallback.
 *
 * Usage in browser console:
 *   findElements({ text: '灯泡/lamp/bulb' })
 */

function findElements(params) {
  var keywords = (params.text || '')
    .split('/')
    .map(function(k) { return k.trim().toLowerCase(); })
    .filter(function(k) { return k.length > 0; });

  if (keywords.length === 0) {
    var errMsg = '请提供搜索关键词';
    console.log(errMsg);
    return errMsg;
  }

  var debug = params.debug || false;

  // ─── Types (inline) ───────────────────────────
  // MatchResult, MatchWithEl, FindElementResult

  // ─── isVisible ─────────────────────────────────
  function isVisible(el) {
    if (el.tagName === 'BODY') return true;
    if (el.offsetParent === null) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  // ─── matchElement ──────────────────────────────
  function matchElement(el, keywords) {
    var bestTier = 99;
    var matchedBy = '';
    var matchedKeyword = '';

    var textContent = (el.textContent || '').trim().toLowerCase();
    var idLower = el.id.toLowerCase();
    var tagLower = el.tagName.toLowerCase();
    var classes = Array.from(el.classList);
    var SKIP_ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

    for (var ki = 0; ki < keywords.length; ki++) {
      var keyword = keywords[ki];

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
        for (var ci = 0; ci < classes.length; ci++) {
          var cls = classes[ci];
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
        for (var ai = 0; ai < SKIP_ATTRS.length; ai++) {
          var attr = SKIP_ATTRS[ai];
          var val = el.getAttribute(attr);
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

    return bestTier === 99 ? null : { tier: bestTier, matchedBy: matchedBy, matchedKeyword: matchedKeyword };
  }

  // ─── deduplicate ───────────────────────────────
  function deduplicate(matches) {
    return matches.filter(function(m) {
      return !matches.some(function(n) { return n !== m && m.el.contains(n.el); });
    });
  }

  // ─── rank ──────────────────────────────────────
  function rank(matches) {
    matches.sort(function(a, b) {
      var tierDiff = a.match.tier - b.match.tier;
      if (tierDiff !== 0) return tierDiff;
      if (a.area !== b.area) return a.area - b.area;
      return a.y - b.y;
    });
  }

  // ─── buildAncestorPath ──────────────────────────
  function buildAncestorPath(el) {
    var parts = [];
    var current = el.parentElement;
    var count = 0;
    while (current && current !== document.body && count < 5) {
      var s = current.tagName.toLowerCase();
      if (current.id) {
        s += '#' + current.id;
      }
      var cls = Array.from(current.classList).slice(0, 3);
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
  function buildSelector(el) {
    var tag = el.tagName.toLowerCase();
    var allClasses = Array.from(el.classList);

    // Strategy 1: id
    if (el.id) {
      var candidate = '#' + el.id;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }

    // Strategy 2: tag + all classes
    if (allClasses.length > 0) {
      var candidate2 = tag + '.' + allClasses.join('.');
      if (document.querySelectorAll(candidate2).length === 1) {
        return candidate2;
      }
    }

    // Strategy 3: ancestor path
    var path = [tag + (allClasses.length > 0 ? '.' + allClasses.join('.') : '')];
    var current = el.parentElement;
    while (current && current !== document.body) {
      var level = current.tagName.toLowerCase();
      if (current.id) {
        level += '#' + current.id;
      }
      var cls = Array.from(current.classList);
      if (cls.length > 0) {
        level += '.' + cls.join('.');
      }
      path.unshift(level);
      var candidate3 = path.join(' > ');
      if (document.querySelectorAll(candidate3).length === 1) {
        return candidate3;
      }
      current = current.parentElement;
    }

    // Strategy 4: nth-child fallback
    if (!el.parentElement) {
      return tag;
    }
    var parentChildren = el.parentElement.children;
    var index = Array.from(parentChildren).indexOf(el) + 1;
    return path.join(' > ') + ':nth-child(' + index + ')';
  }

  // ─── buildResult ───────────────────────────────
  function buildResult(el, matchInfo, debug) {
    var rect = el.getBoundingClientRect();
    var result = {
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
  function searchElements(keywords) {
    var SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT']);
    var matches = [];

    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      null
    );

    var node = walker.currentNode;
    while (node) {
      var el = node;
      if (!SKIP_TAGS.has(el.tagName)) {
        var match = matchElement(el, keywords);
        if (match !== null && isVisible(el)) {
          var rect = el.getBoundingClientRect();
          matches.push({ el: el, match: match, area: rect.width * rect.height, y: rect.y });
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

    var deduped = deduplicate(matches);
    rank(deduped);

    var top15 = deduped.slice(0, 15);
    return top15.map(function(m) { return buildResult(m.el, m.match, debug); });
  }

  var results = searchElements(keywords);

  var summaryLines = ['找到 ' + results.length + ' 个匹配「' + params.text + '」的元素:', ''];

  for (var i = 0; i < results.length; i++) {
    var r = results[i];

    // 标签描述: <tag.class1.class2#id>
    var label = '<' + r.tag;
    if (r.classes.length > 0) {
      label += '.' + r.classes.slice(0, 3).join('.');
    }
    if (r.id) {
      label += '#' + r.id;
    }
    label += '>';

    // 文本内容（截断 40 字符）
    var text = r.text ? ' "' + r.text.slice(0, 40) + '"' : '';

    summaryLines.push((i + 1) + '. ' + label + text);
    summaryLines.push('   selector: ' + r.selector);
  }

  var summary = summaryLines.join('\n');
  console.log(summary);
  return { content: [{ type: 'text', text: summary }], details: { total: results.length, results: results } };
}
