## v0.3.0 v3 Tool Suite — trace_css / show_dom_tree / check_layout

Complete rewrite of the inspection tool suite. Four tools added, replaced, or improved.

### New Tools

- **chrome_show_dom_tree** — Display DOM subtree structure as a tree (├─└─│ connectors, shadow root detection, sibling truncation at >5)
- **chrome_check_layout** — Check element layout properties and dimension values, trace up the ancestor chain for height constraint breaks, flex issues, etc.

### Replaced

- **chrome_inspect_styles** → **chrome_trace_css** — Fixed the root cause issue where all style sources were shown as `inline`/`unknown`
  - Old approach: CDP `rule.rule.sourceURL` (always `undefined`)
  - New approach: CSSOM `document.styleSheets` + `el.matches()`, zero CDP listeners, get filename in one step
  - Attribute filtering: automatically skip noisy values like `initial`/`inherit`/`unset`/`revert`

### Improved

- **chrome_find_elements** — summary output changed to multi-line list format, each element shows `<tag.class#id>`, text snippet, and directly usable selector

### Infrastructure

- Added shared module `core/selector-utils.ts` (`validateSelectorUniqueness` + `formatElementLabel`), used by all three new tools
- Unified error handling: consistent error format for no matches / multiple matches / invalid selector cases
- Added project-level skill: `.pi/skills/page-evaluate-context/` — prevents `page.evaluate` context boundary errors

## v0.2.0 Auto-reconnect and concurrent safety

When developing on a Linux server with Chrome running on your Mac, you can use `/chrome-start --remote` in pi on server to connect and control that Chrome.

- Added automatic reconnection on session resume/fork/reload via persistent connection state.
- Implemented mutual exclusion lock to prevent concurrent CDP operations from conflicting.
- Fixed crash when initializing connection in certain session scenarios.
- Improved message display formatting for connection status updates.

## v0.1.2 Smarter and more efficient find_elements

- Improved element search algorithm to reduce redundant DOM queries.
- Added caching layer for repeated lookups within the same page context.
- Better handling of stale elements with automatic retry on detached nodes.

## v0.1.1 Remote Chrome connection support

- Added ability to connect to a remote Chrome instance via WebSocket URL.
- Support for authentication headers when connecting to remote browsers.
- New configuration options for host, port, and secure (wss) connections.

## v0.1.0 Initial release

- Basic Chrome DevTools Protocol (CDP) integration for browser automation.
- Core actions: navigate, click, type, screenshot, and evaluate JavaScript.
- Initial project scaffolding with TypeScript build and test setup.
