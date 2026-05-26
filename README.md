# pi-to-chrome

## Why?

I've used Claude and OpenCode for frontend development for a long time. Their MCP integrations for Chrome — built on Playwright and the like — feel like starships: massive, feature-bloated, 90% of which I never use. And they burn through tokens like there's no tomorrow.

It frustrated me.

Suddenly I found Pi. Its simplicity, elegance, restraint — so refreshing. Just 4 essential tools. That's it. That's all you need.

Inspired and led by Pi's philosophy, I built **pi-to-chrome** for myself. The exact 4 tools I actually use. No more, no less.

The world went quiet, quickly, and clean.

---

## Only 4 tools

1. **find_elements** — Searching a jungle of hundreds of components and DOM nodes for the "Select Date" button? Use this to search the whole page and returns the element's id, className, and the full DOM hierarchy.
2. **inspect_styles** — When a CSS rule sneaks in from nowhere and ruins your layout, use this to dump every style definition — inherited, computed, cascading — for the LLM to untangle.
3. **read_console** — Chrome's console log is too tiny to read. Hundreds of entries and you still can't find what you want. Use this to stream all logs to the LLM for analysis.
4. **execute_js** — Throw any JavaScript at Chrome. Execute it, get results back, debug on the fly.

## Only 2 commands

- `/chrome-start` — launch a Chrome instance (or connect to one already running), enable this toolbox
- `/chrome-stop` — closes the browser, and disable this toolbox


---

## Install

```bash
pi install npm:pi-to-chrome
```

---


## Requirements

- [Pi](https://pi.dev) — you already have it
- Chrome browser with DevTools protocol enabled

---

### Sollawen

email: sollawen@163.com
