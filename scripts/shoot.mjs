/**
 * Screenshot the running app in GPU Chromium, for judging the look.
 *
 *   node scripts/shoot.mjs [url] [out.png] [--wait=ms] [--eval=js] [--size=WxH]
 *
 * --eval runs in the page once the scene draws, with `s` bound to window.__ocean (e.g. s.setCamera('orbit')).
 *
 * Waits until the scene has drawn frames, prints every console warning and error, and exits 1 on a
 * page error.
 */
import { chromium } from "playwright";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const url = args[0] ?? "http://localhost:3107/";
const out = args[1] ?? "shot.png";
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const wait = Number(flag("wait") ?? 3000);
const script = flag("eval");
const [w, h] = (flag("size") ?? "1600x900").split("x").map(Number);

const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
let failed = false;
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`console.${m.type()}:`, m.text().slice(0, 2000));
});
page.on("pageerror", (e) => {
  failed = true;
  console.log("pageerror:", e.message);
});
await page.goto(url, { waitUntil: "load" });
try {
  await page.waitForFunction(() => (window.__ocean?.frames ?? 0) > 20, null, { timeout: 90_000 });
} catch {
  failed = true;
  console.log("the scene never drew 20 frames; page says:", (await page.locator("main").innerText()).slice(0, 300));
}
if (script) await page.evaluate((code) => new Function("s", code)(window.__ocean), script);
await page.waitForTimeout(wait);
const fps = await page.evaluate(async () => {
  const s = window.__ocean;
  if (!s) return 0;
  const a = s.frames;
  await new Promise((r) => setTimeout(r, 2000));
  return (s.frames - a) / 2;
});
console.log("fps", fps);
console.log("status", JSON.stringify(await page.evaluate(() => {
  const s = window.__ocean;
  if (!s) return null;
  const l = s.debug.lighting;
  return { ...s.status(), exposure: s.debug.renderer.toneMappingExposure, night: l.night, bakes: l.bakes, sunVisibility: l.sunVisibility, frames: s.frames };
})));
await page.screenshot({ path: out });
await browser.close();
process.exit(failed ? 1 : 0);
