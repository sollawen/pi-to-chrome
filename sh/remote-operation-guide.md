# Remote Chrome Operation Guide

## Scenario

Pi is running on a Linux server, Chrome is running on your Mac.

## On Mac (2 steps, order doesn't matter)

### Step 1: Start Chrome

```bash
./start-chrome.sh
```

### Step 2: Establish SSH tunnel

```bash
./start-tunnel.sh
```

Default connects to `Solla@208`. To specify a different server:

```bash
./start-tunnel.sh user@other-server
```

> Neither step requires keeping a terminal window open.

## On Linux

Run in Pi:

```
/chrome-start --remote
```

## Cleanup

Close the tunnel on Mac:

```bash
./close-tunnel.sh
```

---

## If developing locally on Mac

No tunnel needed, just run in Pi:

```
/chrome-start
```

---

## FAQ

**Q: If I close and reopen Chrome, does the tunnel still work?**
A: The tunnel is still there, but you must use `./start-chrome.sh` to restart Chrome. Double-clicking the Chrome icon won't work.

**Q: How to check if the tunnel is still active?**
A: Run `ps aux | grep "ssh.*9222"` in Mac terminal. If you see output, the tunnel is active.

**Q: How to check if Chrome's debug port is open?**
A: Run `curl -s http://127.0.0.1:9222/json/version` in Mac terminal. JSON output means it's open.