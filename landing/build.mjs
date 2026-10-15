// Builds the Muse Panel landing page into landing/dist from index.html and
// release.json: fills in the version, download link and size.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const DOWNLOAD_ORIGIN = "https://musepanel-dl.xiezhaoye.site";

const release = JSON.parse(readFileSync(join(here, "release.json"), "utf8"));
const html = readFileSync(join(here, "index.html"), "utf8")
  .replaceAll("{{VERSION}}", release.version)
  .replaceAll("{{DMG_URL}}", `${DOWNLOAD_ORIGIN}/${release.dmgFile}`)
  .replaceAll("{{DMG_SIZE}}", String(release.dmgSizeMB));
if (html.includes("{{")) throw new Error("index.html has an unfilled placeholder");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), html);
copyFileSync(join(here, "logo.svg"), join(dist, "logo.svg"));
copyFileSync(join(here, "..", "docs", "screenshot.jpg"), join(dist, "screenshot.jpg"));
console.log(`built landing/dist for Muse Panel ${release.version}`);
