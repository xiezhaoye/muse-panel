# Muse 面板 · iPhone 版

在一个 App 里登录多个 Muse 账号，点右上角头像一键切换。原生 SwiftUI + WKWebView，每个账号一份独立的网页存储，登录状态互不干扰。

- 右上角的「邀请」按钮换成当前账号头像，点开账号列表：切换、添加、改名、删除、拖动排序。
- 长按账号：「加载」让它常驻后台，切过去秒开；「挂起」释放它。
- 自动只保留当前账号和最近用过的 1 个页面，其余的切过去时先显示上次的截图，再加载。
- 隐藏底部标签栏，没登录过的账号不出现在列表里。

## 安装

需要 macOS + Xcode、[XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`），以及一个 Apple 开发者账号（免费的也可以）。

1. 把你的 Team ID 写进 `ios/.team`（或设置环境变量 `MUSE_TEAM_ID`）。
2. 手机用数据线连 Mac，信任这台电脑，在「设置 → 隐私与安全性」里打开「开发者模式」。
3. 执行：

```bash
ios/install.sh
```

免费账号的签名 7 天过期，过期后重新执行一次即可，登录状态不受影响。

## 结构

| 文件 | 作用 |
|---|---|
| `MusePanel/AppModel.swift` | 协调层：切换、截图遮罩、预热、兜底按钮 |
| `MusePanel/WebViewPool.swift` | WKWebView 的创建、淘汰、常驻 |
| `MusePanel/AccountStore.swift` | 账号数据（`Application Support/accounts.json`） |
| `MusePanel/AccountSwitcher.swift` | 底部账号列表 |
| `MusePanel/Resources/muse-ios.js` | 注入脚本：头像替换、隐藏标签栏、登录检测 |
| `MusePanel/Resources/rules.json` | 选择器和规则，页面改版时改这里 |
