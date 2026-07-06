# SkillQuick（技能速查）

SkillQuick 是一个 Tauri v2 桌面工具。它常驻后台，按全局快捷键弹出搜索窗口，搜索本地 skill 目录下的 `skill.md` / `SKILL.md`，选中后只把该文件的绝对路径复制到系统剪贴板。

## 当前架构

- 默认快捷键：`CommandOrControl+Shift+S`，macOS 等价于 `Cmd+Shift+S`
- 默认目录：优先 `~/skill-manage`；若不存在，自动兜底到本机存在的 `~/.skills-manager/skills`
- 扫描规则：只扫描配置目录的一级子目录；每个子目录内查找大小写不敏感的 `skill.md`
- 解析规则：Rust 读取 YAML frontmatter，必填 `name`；描述字段优先 `description`，其次 `describe`
- 搜索与排序：全部在 Rust 侧完成，前端只接收最多 50 条精简结果
- 前端：零框架 TypeScript DOM，不再使用 React、cmdk、shadcn/radix、lucide、fuse.js
- 历史持久化：Rust 写入系统配置目录下的 `SkillQuick/state.json`
- 窗口生命周期：启动时不创建 WebView；首次快捷键触发时懒创建搜索窗口，之后隐藏复用
- macOS：使用 `ActivationPolicy::Accessory`，无 Dock 图标，后台常驻

## 运行与构建

```bash
cd /Users/coderxu/Downloads/skill-quick
npm install
npm run tauri:dev
```

生产构建：

```bash
npm run build
cd src-tauri
cargo test
cd ..
npm run tauri:build
```

产物位置：

```text
/Users/coderxu/Downloads/skill-quick/src-tauri/target/release/bundle/macos/SkillQuick.app
```

## 代码结构

```text
skill-quick/
├── src/
│   ├── main.ts          # 零框架搜索 UI、设置页、键盘导航、事件监听
│   └── styles.css       # Tailwind CSS 4 样式
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs           # Tauri builder、插件注册、启动初始化
│   │   ├── commands.rs      # 搜索、历史、配置、剪贴板、监听、打开目录
│   │   ├── skill_parser.rs  # skill.md 查找与 YAML frontmatter 解析
│   │   ├── window.rs        # 搜索窗口懒创建、显示、隐藏
│   │   └── main.rs
│   ├── capabilities/default.json
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── README.md
```

## 搜索排序

Rust 严格按以下优先级排序：

1. 当前搜索词的历史选择次数
2. 全局选择次数降序
3. 轻量模糊匹配分数
4. 名称完全匹配 > 名称包含 > 描述包含
5. 名称字母顺序

历史会自动剪枝：最多保留最近 25 个 query，每个 query 最多保留 20 个 skill 计数，避免长期使用后状态文件膨胀。

## 性能与内存

本轮优化已移除重型前端运行时，并把扫描、搜索、历史、剪贴板写入全部下沉到 Rust。

本机实测：

```text
优化前隐藏窗口 RSS：约 78,928 KB
去 React/Fuse 后隐藏窗口 RSS：约 71,216 KB
懒创建 WebView 后启动后台 RSS：约 47,120 KB
首次打开搜索窗口后 RSS：约 73,440 KB
```

当前磁盘占用：

```text
SkillQuick.app：约 9.9 MB
release 二进制：约 9.9 MB
dist：约 64 KB
node_modules：约 85 MB
```

显示搜索窗口后仍超过 50MB 的主要原因是 macOS WKWebView/WebKit 固定成本。`vmmap` 显示常驻大头来自系统框架：

```text
JavaScriptCore __TEXT：约 18.5 MB resident
WebCore __TEXT：约 30.9 MB resident
WebKit __TEXT：约 11.4 MB resident
```

也就是说，React/cmdk/fuse.js 已经不是主要内存来源。若必须让“弹窗显示态”也稳定低于 50MB，下一步需要放弃 WebView UI，改成 macOS 原生 AppKit/Swift/Rust native overlay；这会牺牲当前 Tauri Web 前端实现和跨平台一致性。

## Profiling 命令

无需 Xcode 的基础测量：

```bash
APP="/Users/coderxu/Downloads/skill-quick/src-tauri/target/release/bundle/macos/SkillQuick.app/Contents/MacOS/skill-quick"
nohup "$APP" >/tmp/skillquick-lazy.log 2>&1 &
pid=$!
sleep 6
ps -o pid,rss,vsz,%mem,command -p "$pid"
vmmap "$pid" | grep -E "WebKit|JavaScriptCore|WebCore|Malloc" | head -60
kill "$pid"
```

触发弹窗后测量：

```bash
osascript -e 'tell application "System Events" to keystroke "s" using {command down, shift down}'
sleep 6
ps -o pid,rss,vsz,%mem,command -p "$pid"
```

本轮没有安装 Xcode Command Line Tools，也没有安装额外全局调试工具。额外产生或更新的本地产物包括 `dist/`、`src-tauri/target/`、`node_modules/`、`package-lock.json`、`Cargo.lock` 和 `/tmp/skillquick-*.log`。

## macOS 权限

如果快捷键无法唤起窗口：

1. 打开“系统设置”
2. 进入“隐私与安全性”
3. 检查“辅助功能”和“输入监控”
4. 给 SkillQuick 授权
5. 退出并重新打开 SkillQuick

## 使用流程

1. 启动 SkillQuick
2. 在任意应用中按 `Cmd+Shift+S`
3. 输入 skill 名称或描述关键词
4. 用上下键选择，按 Enter
5. SkillQuick 将 `skillMdPath` 写入剪贴板
6. 在目标输入框中按 `Cmd+V` 粘贴路径

## 常见问题

### 为什么默认目录不是 `~/skill-manage`？

需求默认是 `~/skill-manage`，但本机可能不存在。代码会先尝试该目录，失败后自动兜底到 `~/.skills-manager/skills`。

### 为什么有些 skill 没出现在结果中？

只扫描一级子目录。每个 skill 子目录必须包含 `skill.md` 或 `SKILL.md`，并且 frontmatter 中必须有字符串字段 `name`。解析失败会跳过并写入 stderr，不会导致应用崩溃。

### 选中后复制的是什么？

只复制 `skillMdPath` 的绝对路径，例如：

```text
/Users/coderxu/.skills-manager/skills/context7/SKILL.md
```

不会复制 skill 内容，也不会复制 markdown 引用格式。
