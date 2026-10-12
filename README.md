# PerSite Volume · 网页音量记忆

一个 Chrome 扩展：像 Volume Master 一样调节网页音量（0%–600%），并**按网站自动记住设置**。下次打开同一个网站时自动应用，无需重新设置。

[English](#english)

## 功能

- **0%–600% 音量**：低于 100% 调低，高于 100% 放大。
- **按网站记忆**：把 youtube.com 调到 150%，以后打开 youtube.com 的任何页面都自动是 150%，已打开的其他 youtube.com 标签页也会立即同步。`www.youtube.com` 和 `youtube.com` 视为同一个网站。
- **仅对当前标签页临时调节**：在弹窗中关闭“记住此网站的音量”即可，离开该网站后失效。
- **工具栏角标**显示当前标签页的音量（不是 100% 时显示）。
- **正在播放声音的标签页**列表，点击即可切换过去。
- **增强模式**：像 Volume Master 一样捕获整个标签页的声音，任何声音都能放大（见下文）。
- **快捷键**：`Alt+Shift+↑` / `Alt+Shift+↓` 调高 / 调低（可在 `chrome://extensions/shortcuts` 修改）。
- **设置页**：默认音量、滑块最大值、调节步长、是否自动记住；管理已保存的网站（添加、修改、删除、搜索）；导出 / 导入备份。
- 界面支持简体中文、繁體中文和 English，跟随浏览器语言。
- 所有数据只保存在浏览器本地，没有服务器，不收集任何数据。

## 安装

1. 下载或克隆这个仓库。
2. 打开 `chrome://extensions`，开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择仓库里的 **`extension`** 文件夹。
4. （可选）点击工具栏上的拼图图标，把 PerSite Volume 固定到工具栏。

需要 Chrome 116 或更新版本；Edge、Brave 等基于 Chromium 的浏览器同样可用。

## 使用

点击工具栏图标打开弹窗，拖动滑块、点击预设（50%–400%）、用 −/+ 按钮，或者直接输入数值。在滑块上滚动鼠标滚轮可以 5% 一步微调。

“记住此网站的音量”默认开启：调节结果会保存给当前网站。关闭后，当前标签页保持现在的音量，但该网站的保存设置会被删除；再次开启则把当前音量重新保存给网站。如果更希望默认只调当前标签页，可以在设置页关闭“自动记住调节结果”。

## 工作原理（和 Volume Master 有什么不同）

Volume Master 用 `chrome.tabCapture` 捕获整个标签页的音频再放大。Chrome 只允许在用户点击扩展按钮之后开始捕获，所以这种方式**无法在打开网页时自动应用保存的音量**；而且捕获期间视频全屏只能铺满浏览器窗口，标签页上还会显示捕获图标。

本扩展默认直接在网页内部调节音量，所以网页一加载就能自动应用保存的设置：

- **低于 100%**：按比例降低每个 `<audio>` / `<video>` 元素的实际音量，但网页读取到的仍是它自己设置的音量，所以网站自带的音量滑块照常可用（两者相乘）。
- **高于 100%**：把正在播放的媒体接入 Web Audio API 的增益节点（GainNode）放大。
- **网页自己用 Web Audio 发出的声音**（游戏、音乐工具等）：在它连到扬声器之前插入一个增益节点。
- 同样覆盖：不在页面里的 `new Audio()`、Shadow DOM 里的媒体、MSE 播放（YouTube、Bilibili 等）、其他网站的内嵌框架（跟随标签页所在网站的设置）。
- 安装或更新扩展之前就已打开的标签页会被自动接管，不需要刷新。

## 限制

- **来自其他网站且没有 CORS 授权的媒体**只能调低、不能放大：浏览器不允许网页读取这类音频的数据。扩展会检测到这种情况，不会因此把声音变成静音，弹窗也会提示；需要放大时可以使用增强模式。
- **Chrome 自动播放策略**：放大需要 Web Audio，而 Web Audio 在用户与网页交互之前可能不允许启动。正常情况下点击播放就满足了条件；如果还不满足，弹窗会提示你在网页上点击一下。
- **WebRTC 通话**（视频会议等）的声音只能调低，放大需要增强模式。
- 浏览器内置页面（`chrome://…`）和 Chrome 应用商店不允许扩展运行。
- 本地文件（`file://`）需要在扩展详情中开启“允许访问文件网址”。
- 无痕窗口里的调节不会被保存（已保存的设置仍会应用）。

## 增强模式

在弹窗中开启后，扩展会像 Volume Master 一样捕获这个标签页的全部声音，再以设定的音量播放，因此任何声音都能放大。需要注意：

- Chrome 只允许从弹窗开启，标签页关闭时自动结束；
- 开启期间视频全屏只会铺满浏览器窗口（Chrome 对被捕获标签页的限制）；
- 音量依旧按网站保存，标签页切换到其他网站时会自动换成那个网站的音量。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| 读取和更改所有网站上的数据（`<all_urls>`） | 在网页中运行音量控制脚本 |
| `storage` | 保存每个网站的音量和设置 |
| `scripting` | 安装后接管已打开的标签页；在弹窗中显示网页的播放状态 |
| `tabCapture`、`offscreen` | 增强模式 |
| `favicon` | 在列表中显示网站图标 |

## 开发

```sh
npm install
npx playwright install chromium   # 第一次运行前
npm test
```

测试会在无头 Chromium 中加载扩展，并用 `tabCapture` 实际测量每个标签页输出的音量。例如设为 200% 时，测得的 RMS 必须正好是原来的 2 倍（误差 10% 以内）。覆盖的场景包括：调低与放大、按网站记忆（刷新、新标签页、www）、仅限当前标签页、设置页修改、跨域媒体（含重定向）、CORS 媒体、MSE、网页自己的 Web Audio、`new Audio()`、封闭的 Shadow DOM、跨域 iframe、网页接管已放大的媒体、增强模式、扩展重新加载、全新安装时已打开的标签页、真实的自动播放策略，以及弹窗和设置页的界面。

`npm run icons` 会从 `assets/icon.svg` 重新生成图标。

```
extension/                 在 Chrome 中加载这个文件夹
  manifest.json
  src/background.js        服务工作线程：按网站保存设置、角标、快捷键、增强模式
  src/content/engine.js    网页内的音频引擎（MAIN world）
  src/content/bridge.js    引擎与扩展之间的桥梁（isolated world）
  src/popup/               弹窗
  src/options/             设置页
  src/offscreen/           增强模式中播放捕获的音频
  src/shared/              公共代码
  _locales/                en、zh_CN、zh_TW
tests/                     端到端测试
assets/icon.svg            图标源文件
```

## English

**PerSite Volume** is a Chrome extension that turns any web page down or boosts it up to 600%, like Volume Master, and **remembers the volume for every site**: set youtube.com to 150% once and every YouTube tab, now and later, plays at 150%.

- Install: open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the `extension` folder (Chrome 116+, or any Chromium-based browser).
- Below 100% the extension scales each media element's volume while the site's own volume control keeps working; above 100% it routes playing media through a Web Audio gain node. The page's own Web Audio output, `new Audio()` objects, shadow DOM, MSE players and cross-origin frames are covered too. Unlike tab capture, this works automatically on page load.
- Media that a site loads from another origin without CORS can only be turned down, never boosted (and is never silenced by trying). Enhanced mode captures the whole tab like Volume Master does, so anything can be boosted; it is started from the popup, lasts until the tab closes, and keeps fullscreen video inside the window.
- Incognito tabs never save anything. All data stays in the browser.
- `npm install && npx playwright install chromium && npm test` runs the end-to-end tests, which measure each tab's real audio output.
