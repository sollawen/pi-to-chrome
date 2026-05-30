# pi-to-chrome

## What's new?

The inspection tool suite got a complete rewrite — four tools updated, including a tree-view DOM explorer, a layout debugger, and a CSS tracer that actually pinpoints stylesheet files. Now they are more smart.
   
## Why?

I've used Claude and OpenCode for frontend development for a long time. Their MCP integrations for Chrome — built on Playwright and the like — feel like a starship: massive, feature-bloated, 90% of which I never use. And they burn through tokens like there's no tomorrow.

It frustrated me.

Suddenly I found Pi. Its simplicity, elegance, restraint — so refreshing. Just 4 essential tools. That's it. That's all you need.

Inspired and led by Pi's philosophy, I built **pi-to-chrome** for myself. The exact 6 tools I actually use. No more, no less.

The world went quiet, quickly, and clean.



## Only 6 tools

1. **find_elements** — Searching a jungle of hundreds of components and DOM nodes for the "Select Date" button? Use this to search the whole page and returns the element's id, className, and the full DOM hierarchy. Summary now shows `<tag.class#id>`, text snippet, and directly usable selector.
2. **trace_css** — When a CSS rule sneaks in from nowhere and ruins your layout, use this to trace the exact stylesheet file and line — no more guessing where it came from.
3. **show_dom_tree** — Need to understand the DOM structure at a glance? Display the subtree as a tree with connectors, detect shadow roots, and truncate long sibling lists.
4. **check_layout** — Layout broken? Check element dimensions and layout properties, trace up the ancestor chain to find the height constraint or flex issue causing it.
5. **read_console** — Chrome's console log is too tiny to read. Hundreds of entries and you still can't find what you want. Use this to stream all logs to the LLM for analysis.
6. **execute_js** — Throw any JavaScript at Chrome. Execute it, get results back, debug on the fly.

## Only 2 commands

- `/chrome-start` — launch a Chrome instance (or connect to one already running), enable this toolbox
- `/chrome-stop` — closes the browser, and disable this toolbox

### How to work remotely?

When Chrome is running on your Mac but you want to control it from pi on a Linux server:

1. Copy the `sh/` directory (containing two shell scripts) to your Mac.
2. On your Mac:
   - First, run `./start-chrome.sh` to launch Chrome with the remote debugging port enabled.
   - Then, run `./start-tunnel.sh` (or `./start-tunnel.sh user@your-server` if the server address is different). This establishes an SSH reverse tunnel, forwarding Chrome's remote debugging port (9222) to your server. 
   - You can edit "start-tunnel.sh" to set your default server so you don't need to specify it every time.
3. On the server, run `/chrome-start --remote`. Pi will connect to Chrome on your Mac through the tunnel.
4. Session resume/fork/reload will automatically reconnect.
5. Run `/chrome-stop` in pi to disconnect (Chrome stays open on your Mac).

More details in [remote-operation-guide.md](sh/remote-operation-guide.md).



## Install

```bash
pi install npm:pi-to-chrome
```




## Requirements

- [Pi](https://pi.dev) — you already have it
- Chrome browser with DevTools protocol enabled

---

*Sollawen*

email: sollawen@163.com
