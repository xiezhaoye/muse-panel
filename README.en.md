# Muse Panel

[简体中文](README.md) · **English**

**Use several Muse accounts side by side in one window.**

Muse Panel is a macOS desktop app. It puts multiple [muse.ai](https://muse.ai) accounts next to each other in a single window, one column per account, each with its own separate login, and lets you organize the accounts into groups.

**[Download for macOS](https://musepanel.xiezhaoye.site)** · **[GitHub Releases](https://github.com/xiezhaoye/muse-panel/releases/latest)** · **[Report an issue](https://github.com/xiezhaoye/muse-panel/issues)**

![Muse Panel screenshot](docs/screenshot.jpg)

> Muse Panel is an independent third-party tool. It is not affiliated with, endorsed by, or sponsored by Meta or Muse.

---

## Features

### Manage multiple accounts in one panel

- **Accounts side by side**: one column per account, all visible and usable at once. Columns share the width evenly and scroll horizontally when they don't fit.
- **Separate logins**: each account has its own cookies and storage. Sign in once by hand and you stay signed in across app and Mac restarts.
- **Tell accounts apart at a glance**: the account name is centered in the column header. Click ✎ to rename it; renamed accounts are shown in a larger font.
- **Quota at a glance**: the header shows a progress bar for the weekly quota (percent used and reset date) and the remaining non-expiring quota. It refreshes on a timer, or on demand.
- **Column menu**: the ⚙ menu in each header reloads the page, puts the account to sleep to free memory, or removes it from the panel.
- **Drag to reorder**: drag the handle on the left of a column header to change the order.

### Group and edit groups easily

- **Group sidebar** on the left: click a group to switch to it; each group holds a set of accounts.
- **Create, rename, delete**: click **+ New group** to create one. **Right-click** a group to rename or delete it. Deleting asks for confirmation, and the group's accounts are moved to the first group, not deleted.
- **Drag to reorder**: drag groups up and down to reorder them. Drop an account's column header onto a group to move the account there.
- **Color bars**: each group has a fixed color bar on its left so groups are easy to tell apart.
- **Resizable and collapsible**: drag the sidebar's right edge to resize it. The icon at the bottom left collapses the sidebar into a thin strip; click anywhere on the strip to expand it.

### Light on resources

- Looping decorative animations in the page are paused automatically, so CPU use stays low even with several accounts on screen.
- Accounts outside the current group are hidden and throttled. Accounts you rarely use can be put to sleep so they use no memory at all.

---

## Download and install

Download the latest `.dmg` from the [download page](https://musepanel.xiezhaoye.site) or [GitHub Releases](https://github.com/xiezhaoye/muse-panel/releases/latest). Only Apple silicon Macs (M1 and later) are supported for now.

The app is not notarized by Apple, so macOS blocks the **first** launch. After dragging Muse Panel into Applications, **right-click → Open** in Finder and confirm, or go to **System Settings → Privacy & Security** and click **Open Anyway** next to Muse Panel. You can also run:

```bash
xattr -dr com.apple.quarantine "/Applications/Muse Panel.app"
```

## Getting started

1. Click the round gray **+** button below **New group** to add an account, then sign in to Muse in the new column.
2. Click ✎ in the column header to give the account a recognizable name.
3. Create groups as needed and drag accounts into them.

## Data and privacy

- All settings, including groups and account names and order, are stored locally in `~/Library/Application Support/Muse Panel/config.json`.
- Sign-in sessions are stored in `Partitions/` in the same folder. They stay on your Mac and never go through any third-party server.
- The app collects no usage data.

## Build from source

```bash
npm install
npm run dev        # development mode
npm run dist       # build and package the dmg (into dist/)
```

Built with Electron, React and TypeScript (electron-vite).

## License

[MIT](LICENSE)
