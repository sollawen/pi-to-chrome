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
