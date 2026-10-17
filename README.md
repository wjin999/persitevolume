# PerSite Volume - 能记住每个网站音量的音量控制插件

把网页音量调低，或放大到 600%。音量按网站保存，下次打开同一个网站时自动使用。

[English](#english)

## 功能

- 音量范围 0%–600%，视频、音乐和网页音效都能调节。
- 按网站记住音量，该网站的所有页面自动应用；`www.example.com` 与 `example.com` 视为同一网站。
- 也可以只调当前标签页，离开该网站后恢复。
- 工具栏图标显示当前音量；弹窗列出正在播放声音的标签页。
- 增强模式：捕获整个标签页的声音，用于无法用普通方式放大的声音。
- 快捷键 `Alt+Shift+↑` / `Alt+Shift+↓`，可在 `chrome://extensions/shortcuts` 修改。
- 设置页：默认音量、滑块最大值、管理已保存的网站、导出和导入备份。
- 支持简体中文、繁體中文和 English。

## 安装

1. 打开 `chrome://extensions`，开启右上角的“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择本仓库的 `extension` 文件夹。

需要 Chrome 116 或更新版本，其他基于 Chromium 的浏览器（如 Edge）也可以使用。

## 使用

点击工具栏图标，用滑块、预设按钮或直接输入数值调整音量。“记住此网站的音量”默认开启；关闭后只对当前标签页生效。

## 注意

- 网页从其他网站加载、且未开放跨域权限的音频只能调低，需要放大时请开启增强模式。
- 增强模式开启期间，视频全屏只会铺满浏览器窗口。
- 浏览器内置页面（`chrome://`）和 Chrome 应用商店页面无法调节。
- 无痕窗口中的调节不会被保存。

## 隐私

所有设置只保存在浏览器本地，不会上传。

## 开发

```sh
npm install
npx playwright install chromium
npm test
```

## English

**PerSite Volume** is a volume control that remembers the volume of each website. Turn any page down or boost it up to 600%; the next time you open the site, the same volume is applied automatically. It can also adjust a single tab only, and an enhanced mode captures the whole tab for audio that cannot be boosted otherwise.

To install, open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and select the `extension` folder (Chrome 116 or later). All settings stay in the browser.
