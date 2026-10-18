// One-command Muse Panel release, run after `npm run dist` has produced the
// dmg + zip and the vX.Y.Z tag has been pushed. From the repo root:
//
//   node landing/release.mjs
//   node landing/release.mjs --notes "what changed"
//   node landing/release.mjs --dry-run
//
//   1. Cloudflare: uploads the .dmg and the .zip to the R2 bucket behind
//      musepanel-dl.xiezhaoye.site, writes dist/latest.json and uploads it as
//      the R2 object `latest.json` (the manifest the in-app updater reads),
//      rewrites landing/release.json, rebuilds the landing page and deploys it.
//   2. GitHub: creates release vX.Y.Z with the .dmg and the .zip attached.
//
// --skip-github publishes to Cloudflare only. --dry-run executes no external
// command (no wrangler / gh / node build) and writes no file, but still reads
// the real zip to compute its size and SHA-256.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const BUCKET = "musepanel-releases";
const REPO = "xiezhaoye/muse-panel";
const DOWNLOAD_ORIGIN = "https://musepanel-dl.xiezhaoye.site";
const skipGithub = process.argv.includes("--skip-github");
const dryRun = process.argv.includes("--dry-run");

const notesIndex = process.argv.indexOf("--notes");
const releaseNotes = notesIndex === -1 ? undefined : process.argv[notesIndex + 1];
if (notesIndex !== -1 && !releaseNotes) {
  console.error("--notes 需要跟一段文字，例如 --notes \"修复了登录问题\"");
  process.exit(1);
}

const run = (cmd, args, opts = {}) => {
  const cwd = opts.cwd ?? root;
  const where = cwd === root ? "" : `   (cwd: ${relative(root, cwd)})`;
  console.log(`$ ${cmd} ${args.join(" ")}${where}`);
  if (dryRun) return;
  return execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
};

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dmgName = `MusePanel_${version}_arm64.dmg`;
const dmgPath = join(root, "dist", dmgName);
const zipName = `MusePanel_${version}_arm64.zip`;
const zipPath = join(root, "dist", zipName);
const latestPath = join(root, "dist", "latest.json");
const today = new Date().toISOString().slice(0, 10);

// The zip is what the in-app updater downloads, so its size and hash must be
// real even in --dry-run: never skip this when the file is missing.
if (!existsSync(zipPath)) {
  console.error(`找不到 ${zipPath}\n请先运行 \`npm run dist\` 生成 zip 包。`);
  process.exit(1);
}
const zipBuffer = readFileSync(zipPath);
const zipSizeBytes = zipBuffer.length;
const zipSha256 = createHash("sha256").update(zipBuffer).digest("hex");

const previousRelease = existsSync(join(root, "landing/release.json"))
  ? JSON.parse(readFileSync(join(root, "landing/release.json"), "utf8"))
  : {};
const dmgSizeMB = (() => {
  if (existsSync(dmgPath)) return Math.round(statSync(dmgPath).size / 1024 / 1024);
  if (dryRun && previousRelease.version === version) {
    console.warn(`警告：找不到 ${dmgName}，沿用 landing/release.json 里的 dmgSizeMB=${previousRelease.dmgSizeMB}`);
    return previousRelease.dmgSizeMB;
  }
  console.error(`找不到 ${dmgPath}\n请先运行 \`npm run dist\` 生成 dmg 安装包。`);
  process.exit(1);
})();

const release = {
  version,
  date: today,
  dmgFile: dmgName,
  dmgSizeMB,
  zipFile: zipName,
  zipSizeBytes,
  zipSha256,
};
const latest = {
  version,
  date: today,
  ...(releaseNotes ? { notes: releaseNotes } : {}),
  zipUrl: `${DOWNLOAD_ORIGIN}/${zipName}`,
  zipSize: zipSizeBytes,
  zipSha256,
  dmgUrl: `${DOWNLOAD_ORIGIN}/${dmgName}`,
};

if (dryRun) {
  console.log("== --dry-run：不执行任何外部命令，不写任何文件 ==");
  console.log("== zip 的大小与 SHA-256 来自真实文件 ==");
  console.log(`\nzip: ${zipPath}\n  size   : ${zipSizeBytes} bytes\n  sha256 : ${zipSha256}\n`);
}

// 1. Cloudflare
run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${dmgName}`, "--remote",
  "--file", dmgPath, "--content-type", "application/x-apple-diskimage",
  "--content-disposition", `attachment; filename="${dmgName}"`]);
run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${zipName}`, "--remote",
  "--file", zipPath, "--content-type", "application/zip",
  "--content-disposition", `attachment; filename="${zipName}"`]);

const latestJson = `${JSON.stringify(latest, null, 2)}\n`;
if (dryRun) {
  console.log(`\ndist/latest.json（dry-run 不写入）:\n${latestJson}`);
} else {
  writeFileSync(latestPath, latestJson);
}
run("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/latest.json`, "--remote",
  "--file", latestPath, "--content-type", "application/json",
  "--cache-control", "no-cache"]);

const releaseJson = `${JSON.stringify(release, null, 2)}\n`;
if (dryRun) {
  console.log(`\nlanding/release.json（dry-run 不改写）:\n${releaseJson}`);
} else {
  writeFileSync(join(root, "landing/release.json"), releaseJson);
}
run("node", ["landing/build.mjs"]);
run("npx", ["wrangler", "deploy"], { cwd: join(root, "landing") });

// 2. GitHub
if (!skipGithub) {
  const githubNotes = [
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
  run("gh", ["release", "create", `v${version}`, "--repo", REPO, "--draft", "--title", `Muse Panel ${version}`, "--notes", githubNotes]);
  run("gh", ["release", "upload", `v${version}`, dmgPath, "--repo", REPO]);
  run("gh", ["release", "upload", `v${version}`, zipPath, "--repo", REPO]);
  run("gh", ["release", "edit", `v${version}`, "--repo", REPO, "--draft=false", "--latest"]);
}

if (dryRun) {
  console.log("\n--dry-run 结束：以上命令一条都没有执行，也没有写入任何文件。");
}
