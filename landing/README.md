# Muse Panel landing page

The download page at https://musepanel.xiezhaoye.site, served as static assets
on Cloudflare Workers. Installers live in the R2 bucket `musepanel-releases`,
served at https://musepanel-dl.xiezhaoye.site.

| File | Purpose |
|---|---|
| `index.html` | Page template (Chinese/English toggle); `{{VERSION}}`, `{{DMG_URL}}`, `{{DMG_SIZE}}` are filled by `build.mjs` |
| `logo.svg` | Logo and favicon |
| `release.json` | The current release: version, file name, size |
| `build.mjs` | Writes `dist/` (page, logo, screenshot from `docs/screenshot.jpg`) |
| `release.mjs` | Publishes a built version to R2, this page and GitHub Releases |
| `wrangler.jsonc` | Cloudflare deployment config |

Release a new version (bump `version` in package.json, `npm run dist`, tag and push `vX.Y.Z`):

```bash
node landing/release.mjs
```

Change only the page: edit `index.html`, then `node landing/build.mjs` and
`npx wrangler deploy` from `landing/`.
