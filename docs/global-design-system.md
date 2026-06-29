# 蓝光电商AI客服 — 全局设计系统

> **版本**：v1.0  
> **更新时间**：2026-06-28  
> **设计风格**：Apple Design / macOS 毛玻璃  
> **技术栈**：Electron + HTML5 + CSS3（无框架）

---

## 一、设计令牌（Design Tokens）

### 1.1 主色系

所有页面统一使用以下色彩变量：

| 令牌 | 色值 | 用途 |
|------|------|------|
| `--bg` | `#f5f5f7` | 页面背景（苹果灰） |
| `--panel` | `#ffffff` | 面板/卡片背景 |
| `--border` | `rgba(0, 0, 0, 0.08)` | 边框 |
| `--border-strong` | `rgba(0, 0, 0, 0.12)` | 强调边框 |
| `--text` | `#1d1d1f` | 主文字 |
| `--text-secondary` | `#6e6e73` | 次要文字 |
| `--muted` | `#86868b` | 辅助/禁用文字 |
| `--accent` | `#0071e3` | 主色调（苹果蓝） |
| `--accent-hover` | `#0077ed` | 悬停 |
| `--accent-press` | `#0060c0` | 按下 |
| `--accent-soft` | `rgba(0, 113, 227, 0.08)` | 浅色背景 |
| `--red` / `--danger` | `#ff3b30` | 错误/危险 |
| `--orange` / `--warning` | `#ff9500` | 警告 |
| `--green` / `--success` | `#34c759` | 成功 |
| `--purple` | `#af52de` | 紫色 |

> **注意**：login.css 保持独立的蓝色调 `#2f5bff`（登录页特有品牌色），其余页面统一为苹果蓝 `#0071e3`。floating.css 的紫色调 `#315bdc` 保留（浮窗需要视觉区分）。

### 1.2 圆角体系

| 级别 | 变量 | 值 | 用途 |
|------|------|-----|------|
| sm | `--radius-sm` | **10px** | 输入框、按钮、小卡片 |
| md | `--radius-md` | **14px** | 中等面板、对话框 |
| lg | `--radius-lg` | **20px** | 大面板 |
| xl | `--radius-xl` | **24px** | 主卡片、弹窗 |

### 1.3 阴影体系

| 级别 | 变量 | 值 |
|------|------|-----|
| sm | `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.04), 0 1px 4px rgba(0,0,0,0.04)` |
| md | `--shadow-md` | `0 4px 12px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04)` |
| lg | `--shadow-lg` | `0 8px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)` |
| xl | `--shadow-xl` | `0 20px 60px rgba(0,0,0,0.12), 0 8px 20px rgba(0,0,0,0.06)` |

### 1.4 过渡动画

| 变量 | 值 | 用途 |
|------|-----|------|
| `--transition-fast` | `0.15s cubic-bezier(0.25, 0.1, 0.25, 1)` | hover/active 微交互 |
| `--transition-smooth` | `0.25s cubic-bezier(0.25, 0.1, 0.25, 1)` | 展开/收起/切换 |
| `--transition-bounce` | `0.35s cubic-bezier(0.34, 1.56, 0.64, 1)` | 弹入效果 |

---

## 二、字体系统

### 2.1 字体栈

```css
font-family: -apple-system, BlinkMacSystemFont,
             "SF Pro Display", "SF Pro Text",
             "PingFang SC", "Microsoft YaHei",
             "Helvetica Neue", sans-serif;
```

### 2.2 字号层级

| 层级 | 字号 | 字重 | 字间距 | 用途 |
|------|------|------|--------|------|
| **H1** | 22-24px | 700 | `-0.02em` | 页面/窗口标题 |
| **H2** | 18px | 700 | `-0.02em` | 区块标题 |
| **H3** | 14-15px | 600-700 | `-0.01em` | 小节标题 |
| **Body** | 13-14px | 400-500 | `-0.01em` | 正文 |
| **Small** | 12px | 400-500 | 继承 | 辅助文字 |
| **Caption** | 10-11px | 500-600 | `0.04em` | 标签/Kicker（大写） |

### 2.3 等宽字体

```css
font-family: "SF Mono", "Consolas", "SFMono-Regular", Menlo, monospace;
```

### 2.4 全局渲染设置

```css
letter-spacing: -0.01em;       /* Apple 标志性负间距 */
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
```

---

## 三、页面设计规范

### 3.1 登录窗口 (`login.html`)

| 属性 | 值 |
|------|-----|
| 窗口 | 460×520, transparent, frame:false |
| 毛玻璃 | `blur(40px) saturate(180%)` |
| 卡片 | max 400px, radius 18px, `rgba(255,255,255,0.94)` |
| 拖拽 | 顶部 44px `-webkit-app-region: drag` |
| 红绿灯 | 12px, 黄 `#f5c53d` / 红 `#ff5f57` |
| 主色 | `#2f5bff`（独立品牌蓝） |

### 3.2 启动台主窗口 (`index.html` + `launcher.css`)

| 属性 | 值 |
|------|-----|
| 窗口 | 720×800, frame:false |
| 卡片 | 680px, radius 24px, `rgba(255,255,255,0.72)` |
| 毛玻璃 | `blur(40px) saturate(180%)` |
| 红绿灯 | 12px, 黄 `#f5c53d` / 红 `#ff5f57` |
| 主色 | `#0071e3`（苹果蓝） |
| 按钮 | 胶囊 `border-radius: 999px` |

### 3.3 客服助手浮窗 (`floating.html` + `floating.css`)

| 属性 | 值 |
|------|-----|
| 窗口 | 320×640, frame:false, alwaysOnTop |
| 背景 | `#f6f5fb`（淡紫灰） |
| 红绿灯 | 12px, 黄 `#f5c53d` / 红 `#ff5f57` |
| 主色 | `#315bdc`（蓝紫） |
| 圆角 | 10px 基准 |

### 3.4 商品库 (`product-library.html`)

| 属性 | 值 |
|------|-----|
| 窗口 | 1280×860, 可缩放 |
| 布局 | 侧边栏(260px) + 主内容 |
| 毛玻璃 | 侧边栏 + 模态框 |
| 主色 | `#0071e3`（苹果蓝） |

### 3.5 API设置 (`ai-settings.html`)

| 属性 | 值 |
|------|-----|
| 窗口 | 980×820, 可缩放 |
| 毛玻璃 | 页头 + 底部固定栏 |
| 主色 | `#0071e3`（苹果蓝） |

---

## 四、组件规范

### 4.1 窗口控制圆点（红绿灯）

所有无边框窗口统一使用：

```css
width: 12px; height: 12px; border-radius: 50%;
/* 最小化 */ background: #f5c53d;
/* 关闭   */ background: #ff5f57;
/* hover  */ filter: brightness(0.85); transform: scale(1.2);
```

### 4.2 输入框

```css
border: 1px solid var(--border);
border-radius: var(--radius-sm);  /* 10px */
padding: 9-10px 12-14px;
font-size: 13-14px;
/* focus */
border-color: var(--accent);
box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.08);
```

### 4.3 主按钮

```css
background: var(--accent);        /* #0071e3 */
color: #fff; font-weight: 600;
border-radius: 10px / 999px;
box-shadow: 0 2px 8px rgba(0, 113, 227, 0.2);
/* hover */
background: var(--accent-hover);
box-shadow: 0 4px 14px rgba(0, 113, 227, 0.3);
transform: translateY(-1px);
```

### 4.4 毛玻璃面板

```css
background: rgba(255, 255, 255, 0.72-0.96);
backdrop-filter: blur(40px) saturate(180%);
-webkit-backdrop-filter: blur(40px) saturate(180%);
border: 1px solid var(--border);
```

### 4.5 模态框

```css
/* 遮罩 */
background: rgba(0, 0, 0, 0.35);
backdrop-filter: blur(8px);

/* 弹窗 */
border-radius: var(--radius-xl);  /* 24px */
background: rgba(255, 255, 255, 0.92);
backdrop-filter: blur(40px) saturate(180%);
box-shadow: var(--shadow-xl);
```

---

## 五、文件职责

| 文件 | 服务页面 | 变量前缀 | 主色 |
|------|---------|----------|------|
| `login.css` | login.html | `--` | `#2f5bff` |
| `launcher.css` | index.html | `--` | `#0071e3` |
| `floating.css` | floating.html | `--` | `#315bdc` |
| `style.css` | ai-settings.html, floating.html 共享样式 | `--` | `#0071e3` |
| `product-library.css` | product-library.html | `--admin-` | `#0071e3` |

---

## 六、设计原则

1. **毛玻璃优先** — 面板/卡片/弹窗统一 `backdrop-filter`
2. **负字间距** — 全局 `-0.01em`，标题 `-0.02em`
3. **红绿灯统一** — 12px 圆点，黄 `#f5c53d` / 红 `#ff5f57`
4. **圆角四级** — 10/14/20/24px
5. **阴影柔和** — 多层叠加，避免硬阴影
6. **微交互** — hover/active/disabled 三态，`translateY(-1px)` 悬停浮起
7. **SF 字族** — macOS 优先 SF Pro，Windows 回退 YaHei
8. **可拖拽** — 无边框窗口顶部区域 `-webkit-app-region: drag`
