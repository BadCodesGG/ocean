/**
 * End-to-end smoke test on the production build.
 *
 *   npm run build && npm run test:smoke [-- --port=3132]
 *
 * Boots `next start` (dev mode hides prerender and bundling problems, so it refuses to run without a
 * build), then checks the routes against the real CDIP and Open-Meteo services: the buoy data, the
 * station status, the named station pages and the old id addresses that redirect to them. Then it
 * drives the page in GPU Chromium: the scene draws, the coast loads, the console stays clean, the
 * label is honest, the picker greys out the buoys that are down, the light, weather and picture
 * settings change the scene, survive a reload and reset to live, a boat launches and runs, and the
 * sound switches on. Prints a line per assertion and exits 1 if any failed.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? 3132);
const BASE = `http://localhost:${PORT}`;

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  console.error("No production build: run `npm run build` first.");
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function stopServer() {
  // A killed parent does not take its children with it on Windows: kill the whole tree by pid.
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}

const browser = await chromium.launch({ headless: true, args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
try {
  await waitForServer();

  // The buoy route.
  const res = await fetch(`${BASE}/api/buoy/106p1`);
  const body = await res.json();
  check("buoy route answers 200", res.status === 200, String(res.status));
  check("caches at the CDN", /s-maxage=\d+/.test(res.headers.get("cache-control") ?? ""), res.headers.get("cache-control") ?? "none");
  check("carries 30 minutes of motion", body.record?.z?.length === 2304 && body.record?.east?.length === 2304, String(body.record?.z?.length));
  check("carries a 64-band spectrum", body.spectrum?.energy?.length === 64 && body.spectrum?.frequency?.length === 64);
  check("carries the sea temperature, or says it has none", body.sst === null || (typeof body.sst?.celsius === "number" && body.sst.celsius > -5 && body.sst.celsius < 40), JSON.stringify(body.sst));
  check("record is recent", Date.now() / 1000 - body.record.start < 6 * 3600, `${Math.round((Date.now() / 1000 - body.record.start) / 60)} min old`);
  check("weather is present or explicitly null", body.weather === null || typeof body.weather?.cloudCover === "number");
  // Only listed stations reach CDIP: a malformed id, and a well-formed one that is not listed, both 404.
  for (const bad of ["abc", "..%2F..%2Fetc", "106p1.nc", "999p9"]) {
    const r = await fetch(`${BASE}/api/buoy/${bad}`);
    check(`refuses station id ${bad}`, r.status === 404, String(r.status));
  }

  // Which stations are reporting.
  const t0 = Date.now();
  const st = await fetch(`${BASE}/api/stations`);
  const first = Date.now() - t0;
  const availability = st.ok ? await st.json() : {};
  const states = Object.values(availability);
  check("station status answers 200", st.status === 200, String(st.status));
  check("station status caches at the CDN", /s-maxage=300/.test(st.headers.get("cache-control") ?? ""), st.headers.get("cache-control") ?? "none");
  check(
    "every station is live or offline, and the home buoy is live",
    states.length >= 10 && states.every((s) => s === "live" || s === "offline") && availability["106p1"] === "live",
    JSON.stringify(availability),
  );
  const t1 = Date.now();
  await fetch(`${BASE}/api/stations`);
  const second = Date.now() - t1;
  check("the second ask does not go back to CDIP", second < Math.max(50, first / 4), `${first} ms then ${second} ms`);

  // Every live buoy gives a whole spectrum (one row per frequency band) and half an hour of motion,
  // whatever the instrument. Barbers Point's DWR4 (100 bands, 2.56 Hz) once came back with empty
  // rows and no sea at all, then with only 15 minutes. One at a time: this is CDIP's server.
  const reporting = Object.keys(availability).filter((id) => availability[id] === "live");
  const whole = [];
  for (const id of reporting) {
    const r = await fetch(`${BASE}/api/buoy/${id}`);
    const body = r.ok ? await r.json() : null;
    const s = body?.spectrum;
    const bands = s?.frequency?.length ?? 0;
    const minutes = body ? body.record.z.length / body.record.rate / 60 : 0;
    const ok = bands > 0 && ["energy", "a1", "b1", "a2", "b2"].every((k) => s[k]?.length === bands) && Math.abs(minutes - 30) < 0.5;
    whole.push([id, ok, `${bands}b/${minutes.toFixed(0)}m`]);
  }
  check(
    "every live buoy has a whole spectrum and half an hour of motion",
    reporting.length > 0 && whole.every(([, ok]) => ok),
    whole.map(([id, ok, shape]) => `${id}:${ok ? shape : `BAD ${shape}`}`).join(" "),
  );

  // Station pages by name, and the old addresses.
  const named = await fetch(`${BASE}/torrey-pines-outer`);
  check("a station's page is at its name", named.status === 200 && (await named.text()).includes("Torrey Pines Outer"), String(named.status));
  for (const [from, to] of [
    ["/100p1", "/torrey-pines-outer"],
    ["/106p1", "/"],
    ["/waimea-bay", "/"],
  ]) {
    const r = await fetch(`${BASE}${from}`, { redirect: "manual" });
    const location = new URL(r.headers.get("location") ?? "", BASE).pathname;
    check(`${from} redirects permanently to ${to}`, r.status === 308 && location === to, `${r.status} ${location}`);
  }
  const nowhere = await fetch(`${BASE}/nowhere-at-all`);
  check("an unknown station name is a 404", nowhere.status === 404, String(nowhere.status));

  // The page.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const noise = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") noise.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => noise.push(`pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.waitForFunction(() => (window.__ocean?.frames ?? 0) > 30, null, { timeout: 90_000 });
  const label = await page.locator("main").innerText();
  check("label names the buoy", label.includes("Waimea Bay buoy 106"), label.slice(0, 120));
  check("label says how far behind live it is", /behind live/.test(label));
  const live = await page.evaluate(() => window.__ocean.status());
  check("live light follows the scene clock", live.lightTime === live.sceneTime);
  check("scene runs behind real time by the record's age", live.lag > 20 * 60 && live.lag < 8 * 3600, `${Math.round(live.lag / 60)} min`);
  await page.waitForFunction(() => window.__ocean.status().coast !== "loading", null, { timeout: 60_000 }).catch(() => {});
  check("the North Shore coast is drawn", (await page.evaluate(() => window.__ocean.status().coast)) === "ready");

  // The picker: buoys that are down are shown but cannot be chosen.
  await page.getByRole("button", { name: /Waimea Bay/ }).click();
  const list = page.locator("#station-list");
  const offline = Object.entries(availability).filter(([id, s]) => s === "offline" && id !== "106p1").length;
  const greyed = await list.locator("[data-offline]").count();
  const links = await list.getByRole("link").count();
  check("the picker greys out every buoy that is down", greyed === offline, `${greyed} greyed, ${offline} offline`);
  check("and links every other one by name", links + greyed === states.length && (await list.getByRole("link", { name: /Torrey Pines Outer/ }).getAttribute("href")) === "/torrey-pines-outer", `${links} links`);
  await page.getByRole("button", { name: /Waimea Bay/ }).click();

  // Settings.
  await page.getByRole("button", { name: /Light & sky/ }).click();
  await page.getByRole("button", { name: "Dusk" }).click();
  await page.waitForTimeout(800);
  const dusk = await page.evaluate(() => window.__ocean.status());
  check("Dusk relights the scene", dusk.lightTime !== dusk.sceneTime && dusk.sunElevation > 0 && dusk.sunElevation < 6, `sun ${dusk.sunElevation.toFixed(1)}°`);
  check("label admits the light is a setting", (await page.locator("main").innerText()).includes("your setting"));
  await page.getByRole("button", { name: "Night" }).click();
  await page.waitForTimeout(3000);
  const night = await page.evaluate(() => ({ ...window.__ocean.status(), exposure: window.__ocean.debug.renderer.toneMappingExposure }));
  check("Night puts the sun down and opens the exposure", night.sunElevation < -10 && night.exposure > 100, `sun ${night.sunElevation.toFixed(0)}°, exposure ${night.exposure.toFixed(0)}`);
  await page.getByRole("button", { name: "Storm", exact: true }).click();
  await page.waitForTimeout(500);
  const storm = await page.evaluate(() => window.__ocean.status().conditions);
  check("Storm brings rain, wind and thunder", storm.rain > 5 && storm.wind > 10 && storm.thunder && storm.visibility < 10_000, JSON.stringify(storm));
  check("label admits the weather is a setting", (await page.locator("main").innerText()).includes("Storm weather (your setting)"));
  await page.getByRole("button", { name: "Low", exact: true }).click();
  await page.waitForTimeout(500);
  const low = await page.evaluate(() => window.__ocean.status().quality);
  check("Low quality draws at a lower resolution", low.setting === "low" && low.preset === "low" && low.pixelRatio <= 0.75, JSON.stringify(low));
  await page.reload();
  await page.waitForFunction(() => (window.__ocean?.frames ?? 0) > 10, null, { timeout: 90_000 });
  const kept = await page.evaluate(() => window.__ocean.status());
  check("the light, weather and quality survive a reload", kept.lightTime !== kept.sceneTime && kept.conditions.thunder && kept.quality.setting === "low");
  await page.getByRole("button", { name: /Light & sky/ }).click();
  await page.getByRole("button", { name: "Reset to live" }).click();
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await page.waitForTimeout(300);
  const reset = await page.evaluate(() => ({ ...window.__ocean.status(), stored: localStorage.getItem("ocean-look"), quality: window.__ocean.status().quality }));
  check("Reset returns to live and forgets the setting", reset.lightTime === reset.sceneTime && reset.stored === null && !reset.conditions.thunder);
  check("Auto picks a preset for this device", reset.quality.setting === "auto" && ["low", "medium", "high", "max"].includes(reset.quality.preset), JSON.stringify(reset.quality));
  await page.getByRole("button", { name: /Light & sky/ }).click();

  // A boat.
  await page.getByRole("button", { name: "Centre console" }).click();
  await page.waitForTimeout(500);
  const launched = await page.evaluate(() => window.__ocean.status());
  check("launching a boat puts the camera behind it", launched.boat?.kind === "console" && launched.camera === "chase", `${launched.boat?.kind} ${launched.camera}`);
  await page.locator("canvas").focus().catch(() => {});
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(6000);
  const running = await page.evaluate(() => ({ ...window.__ocean.status().boat, spray: window.__ocean.debug.spray.count }));
  await page.keyboard.up("KeyW");
  check("W opens the throttle and the boat gets going", running.throttle > 0.5 && running.knots > 8, `${running.knots?.toFixed(1)} kn, throttle ${running.throttle?.toFixed(2)}`);
  check("the bow throws spray under way", running.spray > 0, `${running.spray} drops`);
  await page.getByRole("button", { name: "No boat" }).click();
  await page.waitForTimeout(300);
  const ashore = await page.evaluate(() => window.__ocean.status());
  check("taking the boat away returns to the float", ashore.boat === null && ashore.camera === "float", `${ashore.camera}`);

  // Sound: off until asked for.
  const speaker = page.getByRole("button", { name: "Sound", exact: true });
  check("sound starts off", (await speaker.getAttribute("aria-pressed")) === "false");
  await speaker.click();
  await page.waitForTimeout(500);
  check("the speaker turns sound on and offers a volume", (await speaker.getAttribute("aria-pressed")) === "true" && (await page.getByLabel("Volume").count()) === 1);
  await speaker.click();

  // A phone held upright.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const fov = await page.evaluate(() => window.__ocean.debug.camera.fov);
  check("portrait widens the view", fov > 60, `${fov.toFixed(0)}°`);

  // A named station page and its coast.
  await page.goto(`${BASE}/torrey-pines-outer`);
  await page.waitForFunction(() => (window.__ocean?.frames ?? 0) > 30, null, { timeout: 90_000 });
  check("a named page shows its own buoy", (await page.locator("main").innerText()).includes("Torrey Pines Outer"));
  await page.waitForFunction(() => window.__ocean.status().coast !== "loading", null, { timeout: 60_000 }).catch(() => {});
  check("and its own coast", (await page.evaluate(() => window.__ocean.status().coast)) === "ready");

  check("console stays clean", noise.length === 0, noise.join(" | "));
} catch (error) {
  check("smoke run", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  stopServer();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
