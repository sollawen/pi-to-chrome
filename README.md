# pi-to-chrome

## What's new?

When developing on a Linux server with Chrome running on your Mac, you can use `/chrome-start --remote` in pi on server to connect and control that Chrome.

## Why?

I've used Claude and OpenCode for frontend development for a long time. Their MCP integrations for Chrome — built on Playwright and the like — feel like a starship: massive, feature-bloated, 90% of which I never use. And they burn through tokens like there's no tomorrow.

It frustrated me.

Suddenly I found Pi. Its simplicity, elegance, restraint — so refreshing. Just 4 essential tools. That's it. That's all you need.

Inspired and led by Pi's philosophy, I built **pi-to-chrome** for myself. The exact 4 tools I actually use. No more, no less.

The world went quiet, quickly, and clean.



## Only 4 tools

1. **find_elements** — Searching a jungle of hundreds of components and DOM nodes for the "Select Date" button? Use this to search the whole page and returns the element's id, className, and the full DOM hierarchy.
2. **inspect_styles** — When a CSS rule sneaks in from nowhere and ruins your layout, use this to dump every style definition — inherited, computed, cascading — for the LLM to untangle.
3. **read_console** — Chrome's console log is too tiny to read. Hundreds of entries and you still can't find what you want. Use this to stream all logs to the LLM for analysis.
4. **execute_js** — Throw any JavaScript at Chrome. Execute it, get results back, debug on the fly.

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
