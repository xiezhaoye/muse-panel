// One-command Muse Panel release, run after `npm run dist` has produced the
// dmg and the vX.Y.Z tag has been pushed. From the repo root:
//
//   node landing/release.mjs
//
//   1. Cloudflare: uploads the .dmg to the R2 bucket behind
//      musepanel-dl.xiezhaoye.site, rewrites landing/release.json, rebuilds the
//      landing page and deploys it.
//   2. GitHub: creates release vX.Y.Z with the .dmg attached.
// Pass --skip-github to publish to Cloudflare only.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const BUCKET = "musepanel-releases";
const REPO = "xiezhaoye/muse-panel";
const skipGithub = process.argv.includes("--skip-github");

const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
};

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dmgName = `MusePanel_${version}_arm64.dmg`;
const dmgPath = join(root, "dist", dmgName);
const today = new Date().toISOString().slice(0, 10);

// 1. Cloudflare
run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${dmgName}`, "--remote",
  "--file", dmgPath, "--content-type", "application/x-apple-diskimage",
  "--content-disposition", `attachment; filename="${dmgName}"`]);
const release = {
  version,
  date: today,
  dmgFile: dmgName,
  dmgSizeMB: Math.round(statSync(dmgPath).size / 1024 / 1024),
};
writeFileSync(join(root, "landing/release.json"), `${JSON.stringify(release, null, 2)}\n`);
run("node", ["landing/build.mjs"]);
run("npx", ["wrangler", "deploy"], { cwd: join(root, "landing") });

// 2. GitHub
if (!skipGithub) {
  const notes = [
    `Muse Panel ${version}`,
    "",
    "## 首次打开 / First launch",
    "",
    "安装包未经 Apple 公证。首次打开时在 Finder 里右键 →「打开」，或到「系统设置 → 隐私与安全性」点「仍要打开」；也可以在终端执行：",
    '`xattr -dr com.apple.quarantine "/Applications/Muse Panel.app"`',
    "",
    "Not notarized: on first launch, right-click → Open in Finder, or use System Settings → Privacy & Security → Open Anyway.",
  ].join("\n");
  // 先建草稿、再单独上传、最后发布：`gh release create` 带附件时上传失败会删掉整个 release
  run("gh", ["release", "create", `v${version}`, "--repo", REPO, "--draft", "--title", `Muse Panel ${version}`, "--notes", notes]);
  run("gh", ["release", "upload", `v${version}`, dmgPath, "--repo", REPO]);
  run("gh", ["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--latest"]);
}
