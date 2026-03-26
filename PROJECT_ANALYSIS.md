# Dev Browser 项目分析

## 项目概览

**项目名称**: dev-browser  
**版本**: 0.2.3  
**作者**: Sawyer Hood  
**仓库**: https://github.com/SawyerHood/dev-browser  
**类型**: CLI 工具 + 浏览器自动化

### 核心功能
- 让 AI 代理和开发者通过沙箱化 JavaScript 脚本控制浏览器
- 沙箱执行：脚本在 QuickJS WASM 沙箱中运行，无主机访问权限
- 持久化页面：一次导航，多次脚本交互
- 自动连接：连接正在运行的 Chrome 或启动新的 Chromium
- 完整的 Playwright API 支持

---

## 项目结构

```
dev-browser/
├── bin/                     # CLI 入口
│   └── dev-browser.js
├── cli/                     # Rust 原生 CLI
│   ├── src/                 # Rust 源代码
│   ├── Cargo.toml
│   └── llm-guide.txt        # LLM 使用指南
├── daemon/                  # TypeScript 守护进程
│   ├── src/                 # 守护进程源代码
│   ├── package.json
│   └── vitest.config.ts
├── skills/                  # AI Agent Skills
│   └── dev-browser/         # dev-browser skill
├── .claude-plugin/          # Claude Code 插件
├── scripts/                 # npm scripts
├── assets/                  # 图片资源
├── package.json
├── README.md
├── CLAUDE.md
├── CONTRIBUTING.md
├── RELEASING.md
└── CHANGELOG.md
```

---

## 技术架构

### 三层架构

1. **CLI 层 (Rust + Node.js)**
   - `cli/`: Rust 原生 CLI（Windows 原生支持）
   - `bin/dev-browser.js`: Node.js 入口脚本

2. **守护进程层 (TypeScript)**
   - `daemon/`: 浏览器控制守护进程
   - 使用 Playwright 进行浏览器自动化
   - 管理页面、连接、持久化状态

3. **沙箱执行层 (QuickJS WASM)**
   - 使用 `quickjs-emscripten` 进行脚本沙箱化
   - 脚本无法直接访问主机文件系统或网络
   - 仅暴露安全的 API：`browser`、`console`、`saveScreenshot` 等

### 关键依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `playwright` | ^1.52.0 | 浏览器自动化核心 |
| `playwright-core` | ^1.52.0 | Playwright 核心库 |
| `quickjs-emscripten` | ^0.32.0 | QuickJS WASM 沙箱 |

---

## 核心功能详解

### 1. 浏览器控制 API

```javascript
// 获取或创建命名页面
const page = await browser.getPage("main");

// 创建匿名页面（脚本结束后清理）
const page = await browser.newPage();

// 列出所有标签页
const tabs = await browser.listPages();

// 关闭页面
await browser.closePage("main");
```

### 2. 页面操作（完整 Playwright API）

```javascript
// 导航
await page.goto("https://example.com");

// 点击
await page.click("button");

// 填写表单
await page.fill("input", "text");

// 定位器
await page.locator(".item").first().click();

// 评估 JavaScript
await page.evaluate(() => document.title);

// 截图
const buffer = await page.screenshot();
```

### 3. AI 友好快照

```javascript
const { full, incremental } = await page.snapshotForAI({
  track: true,
  depth: 2,
  timeout: 5000
});
```

### 4. 受限文件 I/O

```javascript
// 保存截图（仅允许 ~/.dev-browser/tmp/）
const path = await saveScreenshot(buffer, "page.png");

// 写文件
const path = await writeFile("data.json", JSON.stringify(data));

// 读文件
const content = await readFile("data.json");
```

---

## 使用方式

### CLI 安装

```bash
npm install -g dev-browser
dev-browser install    # 安装 Playwright + Chromium
```

### Headless 模式

```bash
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF
```

### 连接运行中的 Chrome

```bash
# Chrome: chrome://inspect/#remote-debugging
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF
```

---

## Claude Code 集成

### 权限预批准

**项目级别** (`.claude/settings.json`):
```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)"
    ]
  }
}
```

**用户级别** (`~/.claude/settings.json`):
```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)",
      "Bash(npx dev-browser *)"
    ]
  }
}
```

### 插件安装

```
/plugin marketplace add sawyerhood/dev-browser
/plugin install dev-browser@sawyerhood/dev-browser
```

---

## 性能对比

| 方法 | 时间 | 成本 | 回合数 | 成功率 |
|------|------|------|--------|--------|
| **Dev Browser** | 3m 53s | $0.88 | 29 | 100% |
| Playwright MCP | 4m 31s | $1.45 | 51 | 100% |
| Playwright Skill | 8m 07s | $1.45 | 38 | 67% |
| Claude Chrome Extension | 12m 54s | $2.81 | 80 | 100% |

---

## 开发工作流

### 发布流程 (RELEASING.md)

1. 更新版本
2. 同步版本到 `cli/Cargo.toml` 和 `.claude-plugin/marketplace.json`
3. 提交变更
4. 创建 tag

### 贡献指南 (CONTRIBUTING.md)

- 遵循项目的代码风格
- 添加测试
- 更新文档

---

## 项目亮点

1. **安全性**：QuickJS WASM 沙箱完全隔离主机访问
2. **性能**：比 Playwright MCP 快 14%，成本低 39%
3. **易用性**：CLI 一行命令即可运行脚本
4. **AI 友好**：专为 AI 代理设计，包含 LLM 使用指南
5. **跨平台**：支持 macOS、Linux、Windows（原生 Rust）

---

## 进一步探索

- 查看 `cli/llm-guide.txt` 了解完整的 LLM 使用指南
- 查看 `daemon/src/` 了解守护进程实现
- 查看 `cli/src/` 了解 Rust CLI 实现
- 查看 `skills/dev-browser/` 了解 Skill 实现
