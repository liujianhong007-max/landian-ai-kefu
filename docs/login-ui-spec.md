# 蓝光电商AI客服 — 登录窗口 UI 设计规范

> **版本**：v1.0  
> **更新时间**：2026-06-28  
> **设计风格**：Apple Design / macOS 毛玻璃  
> **技术栈**：Electron + HTML5 + CSS3（无框架）

---

## 一、窗口配置

| 属性 | 值 | 说明 |
|------|-----|------|
| 窗口尺寸 | 460 × 520 px | 不可缩放 (`resizable: false`) |
| 窗口类型 | 透明无边框 | `frame: false`, `transparent: true` |
| 背景 | 完全透明 | `backgroundColor: '#00000000'` |
| 安全策略 | contextIsolation + preload | `nodeIntegration: false` |
| 拖拽 | 顶部 44px 区域 | `-webkit-app-region: drag` |

---

## 二、布局结构

```
┌─────────────────────────────────────┐
│  .login-drag-bar (44px, 可拖拽)       │
│  ┌───────────────────────────────┐  │
│  │                   ●(缩小) ●(关闭)│  │  ← .window-controls (no-drag)
│  └───────────────────────────────┘  │
├─────────────────────────────────────┤
│                                     │
│         .login-header               │
│     ┌─────────────────┐            │
│     │  蓝光电商AI客服    │  ← h1     │
│     │  登录您的账号      │  ← p      │
│     └─────────────────┘            │
│                                     │
│         .login-form                 │
│     ┌─────────────────┐            │
│     │ 手机号           │  ← span    │
│     │ ┌─────────────┐ │            │
│     │ │ 请输入手机号  │ │  ← input  │
│     │ └─────────────┘ │            │
│     │ 密码             │  ← span    │
│     │ ┌─────────────┐ │            │
│     │ │ 请输入密码    │ │  ← input  │
│     │ └─────────────┘ │            │
│     │ [  错误提示  ]   │  ← error   │
│     │ ┌─────────────┐ │            │
│     │ │    登 录     │ │  ← button │
│     │ └─────────────┘ │            │
│     └─────────────────┘            │
│                                     │
│         .login-footer               │
│     还没有账号？ 立即注册             │
│                                     │
└─────────────────────────────────────┘
```

---

## 三、色彩系统

| 用途 | 变量 | 色值 | 说明 |
|------|------|------|------|
| 页面背景 | `--bg` | `#f3f6ff` | 淡蓝紫底 |
| 卡片背景 | `--panel` | `#ffffff` | 毛玻璃叠加后 ≈ `rgba(255,255,255,0.94)` |
| 边框 | `--border` | `#dbe2f4` | 淡蓝灰 |
| 主文字 | `--text` | `#182033` | 深蓝黑 |
| 辅助文字 | `--muted` | `#67738f` | 灰蓝 |
| 主色调 | `--accent` | `#2f5bff` | 亮蓝 |
| 悬停 | `--accent-hover` | `#1a44e0` | 深蓝 |
| 错误 | `--error` | `#e11d48` | 玫红 |
| 错误背景 | `--error-bg` | `#fff1f2` | 浅粉 |
| 按钮禁用 | — | `#a8bbff` | 淡蓝 |
| 占位符 | — | `#b0bdd4` | 浅蓝灰 |
| 最小化圆点 | — | `#f5c53d` | 黄色 |
| 关闭圆点 | — | `#ff5f57` | 红色 |

---

## 四、字体规范

### 4.1 字体栈

```css
font-family: -apple-system, BlinkMacSystemFont,
             "SF Pro Display", "SF Pro Text",
             "PingFang SC", "Microsoft YaHei",
             "Helvetica Neue", sans-serif;
```

| 优先级 | 字体 | 平台 |
|--------|------|------|
| 1 | `-apple-system` | macOS → SF Pro |
| 2 | `BlinkMacSystemFont` | macOS Chromium |
| 3 | `SF Pro Display` | macOS 显示用 |
| 4 | `SF Pro Text` | macOS 正文用 |
| 5 | `PingFang SC` | macOS / iOS 中文 |
| 6 | `Microsoft YaHei` | Windows 中文 |
| 7 | `Helvetica Neue` | 通用西文 |
| 8 | `sans-serif` | 系统回退 |

### 4.2 字号层级

| 层级 | CSS 变量 | 字号 | 字重 | 用途 | 字间距 |
|------|----------|------|------|------|--------|
| **H1** 一级标题 | `--font-size-h1` | **22px** | **700** | 软件名 "蓝光电商AI客服" | `-0.02em` |
| **H2** 二级标题 | `--font-size-h2` | **14px** | **400** | 副标题 / 模式提示 | `-0.01em` |
| **Body** 正文 | `--font-size-body` | **14px** | 400/700 | 输入框、按钮文字 | `-0.01em` |
| **Small** 小字 | `--font-size-small` | **12px** | 400/500/600 | 标签、错误提示、底部链接 | 继承 |

### 4.3 字体渲染

```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
letter-spacing: -0.01em; /* 全局负间距 — Apple 风格关键 */
```

---

## 五、组件规格

### 5.1 登录卡片 `.login-card`

| 属性 | 值 |
|------|-----|
| 最大宽度 | 400px（含 16px padding） |
| 实际卡片宽 | 368px |
| 圆角 | 18px |
| 背景 | `rgba(255, 255, 255, 0.94)` |
| 毛玻璃 | `blur(40px) saturate(180%)` |
| 内边距 | `36px 32px 28px` |
| 阴影 | `0 12px 40px rgba(26, 41, 82, 0.1)` |
| 边框 | `1px solid #dbe2f4` |

### 5.2 拖拽栏 `.login-drag-bar`

| 属性 | 值 |
|------|-----|
| 高度 | 44px |
| 定位 | absolute, top/left/right: 0 |
| 拖拽 | `-webkit-app-region: drag` |
| 选择 | `user-select: none` |

### 5.3 窗口控制圆点 `.window-dot`

| 属性 | 值 |
|------|-----|
| 尺寸 | 12px × 12px |
| 形状 | 圆形 `border-radius: 50%` |
| 间距 | 8px gap |
| 位置 | 右上角 (top:14px, right:16px) |
| 不可拖拽 | `-webkit-app-region: no-drag` |
| 最小化色 | `#f5c53d` (黄) |
| 关闭色 | `#ff5f57` (红) |
| hover | `brightness(0.85)` + `scale(1.2)` |

### 5.4 输入框 `.login-input`

| 属性 | 值 |
|------|-----|
| 高度 | auto (padding 撑开) |
| 内边距 | `10px 14px` |
| 圆角 | 10px |
| 边框 | `1px solid #dbe2f4` |
| 背景 | `#fff` |
| 字号 | 14px |
| focus 边框 | `#2f5bff` |
| focus 光晕 | `0 0 0 3px rgba(47,91,255,0.08)` |
| placeholder | `#b0bdd4` |

### 5.5 主按钮 `.login-button`

| 属性 | 值 |
|------|-----|
| 宽度 | 100% |
| 内边距 | `12px 0` |
| 圆角 | 10px |
| 背景 | `#2f5bff` |
| 文字色 | `#fff` |
| 字号 | 14px / 700 |
| hover | `#1a44e0` |
| disabled | `#a8bbff`, cursor: not-allowed |

### 5.6 错误提示 `.login-error`

| 属性 | 值 |
|------|-----|
| 圆角 | 8px |
| 边框 | `1px solid #fecdd3` |
| 背景 | `#fff1f2` |
| 文字色 | `#e11d48` |
| 字号 | 12px |
| 内边距 | `10px 14px` |
| 默认 | `hidden` |

### 5.7 底部链接 `.login-link`

| 属性 | 值 |
|------|-----|
| 字号 | 12px / 600 |
| 颜色 | `#2f5bff` |
| 装饰 | `underline`, offset: 2px |
| hover | `#1a44e0` |
| 背景 | 透明无边框 |

---

## 六、交互状态

### 6.1 模式切换

| 状态 | 副标题 | 按钮文字 | 底部文字 | 链接文字 | 密码提示 |
|------|--------|----------|----------|----------|----------|
| 登录模式 | 登录您的账号 | 登 录 | 还没有账号？ | 立即注册 | 请输入密码 |
| 注册模式 | 注册新账号 | 注 册 | 已有账号？ | 立即登录 | 请设置密码（6-128位） |

### 6.2 按钮状态

| 状态 | 样式 |
|------|------|
| 默认 | `#2f5bff` 背景 |
| 悬停 | `#1a44e0` 背景 |
| 加载中 | disabled + "登录中..." / "注册中..." |
| 禁用 | `#a8bbff` 背景 |

### 6.3 输入验证

| 规则 | 提示 |
|------|------|
| 手机号格式 `/^1[3-9]\d{9}$/` | "请输入正确的11位手机号" |
| 密码为空 | "请输入密码" |
| 注册密码 < 6位 | "密码至少6位" |

### 6.4 窗口控制

| 按钮 | 事件 | IPC |
|------|------|-----|
| 黄色圆点 | 最小化当前窗口 | `window:minimize` |
| 红色圆点 | 关闭当前窗口 | `window:close` |

---

## 七、文件清单

| 文件 | 职责 |
|------|------|
| `renderer/login.html` | 登录窗口 DOM 结构 |
| `renderer/login.css` | 登录窗口样式（含设计令牌） |
| `renderer/login.js` | 登录/注册逻辑 + 表单验证 |
| `main/index.js` → `createLoginWindow()` | 窗口创建与配置 |
| `preload/index.js` | API 桥接（minimizeWindow, closeWindow, login, register 等） |

---

## 八、设计原则

1. **毛玻璃透明** — 窗口背景完全透明，卡片使用 `backdrop-filter` 实现毛玻璃效果
2. **负字间距** — 全局 `letter-spacing: -0.01em`，标题 `-0.02em`，Apple 标志性紧凑感
3. **圆角层次** — 卡片 18px → 输入框/按钮 10px → 错误提示 8px
4. **柔和阴影** — 单层阴影，避免过度立体
5. **微交互** — 所有可交互元素有 hover/active/disabled 三态
6. **macOS 圆点** — 窗口控制使用黄/红色圆点而非文字按钮
7. **可拖拽设计** — 顶部 44px 区域支持拖拽，圆点区域 `no-drag` 保持可点击
