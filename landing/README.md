# Muse Panel landing page

The download page at https://musepanel.xiezhaoye.site, served as static assets
on Cloudflare Workers. Installers live in the R2 bucket `musepanel-releases`,
served at https://musepanel-dl.xiezhaoye.site.

| File | Purpose |
|---|---|
| `index.html` | Page template (Chinese/English toggle); `{{VERSION}}`, `{{DMG_URL}}`, `{{DMG_SIZE}}` are filled by `build.mjs` |
| `logo.svg` | Logo and favicon |
| `release.json` | The current release: version, dmg/zip file names, sizes and zip SHA-256 |
| `build.mjs` | Writes `dist/` (page, logo, screenshot from `docs/screenshot.jpg`) |
| `release.mjs` | Publishes a built version to R2, this page and GitHub Releases |
| `wrangler.jsonc` | Cloudflare deployment config |

Release a new version (bump `version` in package.json, `npm run dist`, tag and push `vX.Y.Z`):

```bash
node landing/release.mjs
node landing/release.mjs --notes "这次改了什么"   # 可选，写进 latest.json
node landing/release.mjs --dry-run              # 只打印将执行的命令与两个 json，不执行、不写文件
```

`npm run dist` now builds both `MusePanel_<version>_arm64.dmg` and
`MusePanel_<version>_arm64.zip`; both are uploaded to R2 and attached to the
GitHub release.

Besides the installers, `release.mjs` uploads `latest.json` to the R2 root
(https://musepanel-dl.xiezhaoye.site/latest.json) — the update manifest the
in-app updater polls. It records `version`, `date`, optional `notes`, and
`zipUrl` / `zipSize` / `zipSha256` (plus `dmgUrl`) so the app can download the
zip and verify its SHA-256 before replacing itself. It is uploaded with
`--cache-control no-cache` so a fresh release is visible immediately.

Change only the page: edit `index.html`, then `node landing/build.mjs` and
`npx wrangler deploy` from `landing/`.
