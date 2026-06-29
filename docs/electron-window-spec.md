# Electron 窗口开发规范

## 核心原则

### frame: false + transparent: true → 无边框透明窗口

这是项目最关键的窗口规范。当需要自绘标题栏 + 圆角窗口时，**必须同时设置**：

```js
new BrowserWindow({
  frame: false,           // 隐藏系统标题栏和边框
  transparent: true,      // 窗口背景透明，允许 CSS border-radius 生效
  backgroundColor: '#00000000',  // 透明底色（配合 transparent: true）
})
```

**为什么两者缺一不可：**
- `frame: false` 单独使用 → 无标题栏，但窗口仍是矩形色块，CSS 圆角被系统边框遮盖
- `transparent: true` 单独使用 → 窗口透明但仍有系统标题栏
- 两者组合 → 窗口完全由 HTML/CSS 控制，`border-radius` 可在窗口边缘正确呈现

**对应 CSS 要求：**
- `body` 必须设置 `background: transparent`
- 所有背景色必须使用纯色（`#ffffff`、`#fafafa` 等），**禁止使用半透明毛玻璃**（`rgba(..., 0.72)` + `backdrop-filter`），因为透明窗口下无底层内容可模糊

---

## 项目窗口清单

| 窗口 | 创建函数 | 文件 | 类型 | 尺寸 |
|------|----------|------|------|------|
| 登录窗口 | `createLoginWindow()` | `renderer/login.html` + `login.css` | **无边框透明** | 460×520 (fixed) |
| 主窗口/启动台 | `createWindow()` | `renderer/index.html` + `launcher.css` | **无边框透明** | 800×640 (fixed) |
| 浮窗/客服助手 | `createFloatingPluginWindow()` | `renderer/floating.html` + `floating.css` | **无边框透明** | 320×640 (resizable, min 300×520, max 380) |
| 商品库 | `createProductLibraryWindow()` | `renderer/product-library.html` + `product-library.css` | 标准窗口 | 1280×860 (min 1080×720) |
| API设置 | `createAiSettingsWindow()` | `renderer/ai-settings.html` + `style.css` | 标准窗口 | 980×820 (min 860×700) |

---

## 无边框透明窗口规范

### 适用场景
- 需要自定义标题栏（拖拽区、窗口控制按钮）
- 需要窗口圆角效果
- 品牌化 UI（如登录页、启动台、悬浮助手）

### BrowserWindow 配置模板

```js
new BrowserWindow({
  width: 800,
  height: 640,
  resizable: false,          // 自绘窗口建议固定尺寸
  maximizable: false,
  frame: false,              // 必须
  transparent: true,         // 必须
  backgroundColor: '#00000000',  // 必须
  autoHideMenuBar: true,
  webPreferences: {
    preload: path.join(__dirname, '..', 'preload', 'index.js'),
    contextIsolation: true,
    nodeIntegration: false
  }
})
```

### CSS 规范

```css
/* 根元素：透明背景 */
html, body {
  margin: 0;
  padding: 0;
  background: transparent;   /* 必须透明，让窗口圆角可见 */
  overflow: hidden;
}

/* 内容容器：纯色背景 + 圆角 */
.app-shell {
  background: #ffffff;        /* 纯色，禁止半透明 */
  border-radius: 12px;        /* 窗口圆角 */
  /* 禁止 backdrop-filter / rgba 半透明 */
}

/* 自定义标题栏 */
.titlebar {
  -webkit-app-region: drag;   /* 可拖拽区域 */
  height: 40px;
  padding: 0 12px;
}

/* 窗口控制按钮 */
.window-controls {
  -webkit-app-region: no-drag;  /* 按钮不可拖拽 */
}
```

### 关键 CSS 禁区

| ❌ 禁止 | ✅ 替代 |
|--------|--------|
| `background: rgba(255,255,255,0.72)` | `background: #ffffff` |
| `backdrop-filter: blur(20px)` | 移除（透明窗口下无效） |
| `background: rgba(0,0,0,0.04)` 作为主背景 | 用纯色 `#f5f5f7` 替代 |
| 面板级半透明叠加 | 用明确的纯色分层 |

---

## 标准窗口规范

### 适用场景
- 工具型窗口（设置、商品库等）
- 需要系统原生标题栏
- 不需要圆角效果

### BrowserWindow 配置模板

```js
new BrowserWindow({
  width: 980,
  height: 820,
  minWidth: 860,
  minHeight: 700,
  title: '窗口标题',
  backgroundColor: '#f6f7f9',   // 不透明背景色
  autoHideMenuBar: true,
  // 不设置 frame: false，不设置 transparent
  webPreferences: {
    preload: path.join(__dirname, '..', 'preload', 'index.js'),
    contextIsolation: true,
    nodeIntegration: false
  }
})
```

### CSS 规范

```css
/* 标准窗口可以使用半透明效果 */
body {
  background: #f6f7f9;
  /* backdrop-filter 在标准窗口下可用 */
}
```

---

## 浮窗特殊规范

浮窗（客服助手）在无边框透明基础上还有额外要求：

```js
new BrowserWindow({
  frame: false,
  transparent: true,
  alwaysOnTop: true,          // 始终置顶
  skipTaskbar: false,         // 显示在任务栏
  resizable: true,            // 可调整大小（有范围限制）
  minWidth: 300,
  minHeight: 520,
  maxWidth: 380,
  backgroundColor: '#00000000',
  // ...
})
```

---

## Preload 脚本

所有窗口共用 `preload/index.js`，通过 `contextBridge.exposeInMainWorld('pddFuke', { ... })` 暴露 API。

- `contextIsolation: true` + `nodeIntegration: false`（安全最佳实践）
- 渲染进程只能通过 `window.pddFuke` 调用主进程功能

---

## 窗口 IPC 通信

### 窗口操作

```js
// 最小化当前窗口
ipcMain.handle('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.minimize();
});

// 关闭当前窗口
ipcMain.handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.close();
});
```

### 消息广播

`sendToRenderer()` 函数同时向所有存在的窗口广播消息：

```js
function sendToRenderer(channel, payload) {
  [mainWindow, floatingWindow, productLibraryWindow, aiSettingsWindow]
    .forEach(win => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    });
}
```

---

## 生命周期管理

```
app.whenReady()
  └─ createLoginWindow()          // 最先创建登录窗口
       └─ 登录成功
            ├─ createWindow()           // 主窗口
            ├─ createFloatingPluginWindow()  // 浮窗
            └─ startServices()          // 启动后台服务

app.on('before-quit')
  └─ 清理所有窗口和服务
```

- 每个窗口创建函数都检查窗口是否已存在且未销毁，存在则 `show()` + `focus()`
- 窗口关闭时对应变量设为 `null`

---

## 检查清单

创建/修改窗口时确认：

- [ ] 无边框窗口同时设置了 `frame: false` + `transparent: true` + `backgroundColor: '#00000000'`
- [ ] CSS 中 `body` 设为 `background: transparent`
- [ ] CSS 中所有背景色使用纯色，无半透明 `rgba` + `backdrop-filter`
- [ ] 自绘标题栏有 `-webkit-app-region: drag` 拖拽区
- [ ] 窗口控制按钮有 `-webkit-app-region: no-drag`
- [ ] 窗口关闭回调中清理对应变量
- [ ] 使用统一的 preload 脚本和 webPreferences 配置
