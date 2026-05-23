# Chrome Inspect Extension

pi 扩展，用于检查 Chrome 浏览器页面。

## 功能

- **5 个检查工具**:搜索元素、查看样式、截图、读 Console、执行 JS
- **连接已有 Chrome**:通过远程调试端口（puppeteer.connect）
- **支持 SSH 隧道**:服务器上也能连接本机 Chrome

## 目录结构

```
~/.pi/agent/extensions/chrome-inspect/
├── index.ts              # 入口文件
└── tools/
    ├── find-elements.ts  # chrome_find_elements
    ├── inspect-styles.ts # chrome_inspect_styles
    ├── take-screenshot.ts # chrome_take_screenshot
    ├── read-console.ts  # chrome_read_console
    └── execute-js.ts    # chrome_execute_js
```

## 依赖

已添加到 `~/.pi/agent/npm/package.json`:
- `puppeteer-core` ^24.0.0

## 使用方法

### 1. 启动 Chrome（调试模式）

**方法 A: 命令行启动**
```bash
# 创建调试用 profile 目录（只需执行一次）
DEBUG_DIR="$HOME/Library/Application Support/Google/Chrome-Debug"
mkdir -p "$DEBUG_DIR"
ln -s "$HOME/Library/Application Support/Google/Chrome/Default" "$DEBUG_DIR/Default"

# 启动 Chrome
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$DEBUG_DIR"
```

**方法 B: 如果已有 Chrome 运行中**
直接执行 `/chrome-start`，扩展会询问是否关闭现有 Chrome 并重启为调试模式。

### 2. 在 pi 中使用

```bash
# 连接 Chrome
/chrome-start

# 列出所有 Tab
/chrome-tabs

# 断开并关闭
/chrome-stop
```

### 3. 可用工具

| 工具 | 用途 | 示例 |
|------|------|------|
| `chrome_find_elements` | 搜索页面元素 | 搜索包含"提交"的按钮 |
| `chrome_inspect_styles` | 查看 CSS 层叠链 | 检查按钮的颜色来源 |
| `chrome_take_screenshot` | 截取页面截图 | 查看页面当前外观 |
| `chrome_read_console` | 读取 Console 日志 | 查看页面报错 |
| `chrome_execute_js` | 执行 JavaScript | 查询页面状态 |

## 服务器场景（SSH 隧道）

```bash
# 在服务器上执行
ssh -R 9222:localhost:9222 user@本机-ip

# 然后在 pi 中执行
/chrome-start
```

## 已知限制

- Console 历史在 pi 重启后清空
- Shadow DOM 元素需要用 `>>>` 或 `/deep/` 选择器
- Chrome 最小化时无法判断活跃 Tab

## 安全注意

- `chrome_execute_js` 可执行任意 JS，仅用于调试
- 调试端口 9222 仅限 localhost 使用，不要暴露到公网