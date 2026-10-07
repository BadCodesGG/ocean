"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoatKind, Running, Status } from "@/engine/app";
import type { Helm } from "@/engine/boat";
import type { CameraMode } from "@/engine/camera";
import { QUALITIES, type Quality } from "@/engine/quality";
import { WEATHER_PRESETS, type WeatherPreset } from "@/lib/conditions";
import { compass } from "@/lib/format";
import { migrateLegacyKeys, SETTING_KEYS } from "@/lib/storage";
import { formatLag, formatMinutes, LIVE_LOOK, loadLook, presets, saveLook, type LookSettings } from "@/lib/look";
import type { BuoyResponse } from "@/lib/snapshot";
import type { Availability } from "@/lib/cdip";
import { STATIONS, stationPath, type Station } from "@/lib/stations";
import { localMidnight, localMinutes, zoneName } from "@/lib/zone";

/** Snapshots received so far, oldest first; the label reads the one whose record is playing. */
type State = { kind: "loading" } | { kind: "ready"; snapshots: BuoyResponse[] } | { kind: "error"; message: string };

/** How often to ask for a newer record. CDIP publishes one every 30 minutes; the route caches for 5. */
const POLL_MS = 5 * 60_000;

/** `?at=18:05&clouds=0.4&weather=squall` pins the look for a screenshot without touching the saved settings. */
function lookFromUrl(): LookSettings | null {
  const q = new URLSearchParams(window.location.search);
  if (!q.has("at") && !q.has("clouds") && !q.has("weather")) return null;
  const weather = q.get("weather");
  const at = /^(\d{1,2}):(\d{2})$/.exec(q.get("at") ?? "");
  const clouds = q.has("clouds") ? Number(q.get("clouds")) : NaN;
  return {
    lightAt: at ? (Number(at[1]) * 60 + Number(at[2])) % 1440 : null,
    cloudCover: Number.isFinite(clouds) ? Math.min(1, Math.max(0, clouds)) : null,
    weather: WEATHER_PRESETS.includes(weather as WeatherPreset) ? (weather as WeatherPreset) : null,
  };
}

const CAMERA_KEY = SETTING_KEYS.camera;

const WEATHER_NAMES: Record<WeatherPreset, string> = { clear: "Clear", showers: "Showers", squall: "Squall", storm: "Storm" };

const BOAT_KEY = SETTING_KEYS.boat;
const QUALITY_KEY = SETTING_KEYS.quality;
const VOLUME_KEY = SETTING_KEYS.volume;

const QUALITY_NAMES: Record<Quality, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", max: "Max" };

/** The last volume chosen, 0.05 to 1; sound itself always starts off, since browsers only allow it after a tap. */
function loadVolume(): number {
  try {
    const v = Number(window.localStorage.getItem(VOLUME_KEY));
    return v >= 0.05 && v <= 1 ? v : 0.6;
  } catch {
    return 0.6;
  }
}

const CAMERAS: { mode: CameraMode; name: string; hint: string; boat?: true }[] = [
  { mode: "float", name: "Float", hint: "Drag to look around" },
  { mode: "orbit", name: "Orbit", hint: "Drag to circle, scroll or pinch to zoom" },
  { mode: "fly", name: "Fly", hint: "WASD or arrows to fly, Q and E down and up, Shift faster, drag to look" },
  { mode: "helm", name: "Helm", hint: "W and S throttle, A and D steer, X neutral; drag to look around", boat: true },
  { mode: "chase", name: "Chase", hint: "W and S throttle, A and D steer, X neutral; drag to look, scroll to zoom", boat: true },
  { mode: "tour", name: "Tour", hint: "Sit back; drag to nudge it round" },
];

const BOATS: { kind: BoatKind; name: string }[] = [
  { kind: "none", name: "No boat" },
  { kind: "console", name: "Centre console" },
  { kind: "skiff", name: "Skiff" },
];

/** A remembered choice, or the fallback when there is none, it is not one of `allowed`, or storage is blocked. */
function loadChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveChoice(key: string, value: string, fallback: string) {
  try {
    if (value === fallback) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not remembered, then.
  }
}

/** A button that holds a helm input while pressed (touch or mouse), and lets go when released. */
function HoldButton({ label, part, value, onHold, children }: { label: string; part: keyof Helm; value: number; onHold: (part: keyof Helm, value: number) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onHold(part, value);
      }}
      onPointerUp={() => onHold(part, 0)}
      onPointerCancel={() => onHold(part, 0)}
      className="grid h-12 w-12 touch-none select-none place-items-center rounded-full border border-white/15 bg-black/40 text-lg text-white/90 backdrop-blur-md active:bg-white/25"
    >
      {children}
    </button>
  );
}

export function OceanView({ station }: { station: Station }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const running = useRef<Running | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [status, setStatus] = useState<Status | null>(null);
  const [look, setLook] = useState<LookSettings>(LIVE_LOOK);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [camera, setCamera] = useState<CameraMode>("float");
  const [boat, setBoat] = useState<BoatKind>("none");
  const touchHelm = useRef<Helm>({ throttle: 0, rudder: 0 });
  const [quality, setQuality] = useState<Quality>("auto");
  const [sound, setSound] = useState(false);
  const [volume, setVolume] = useState(0.6);
  /** Which stations are reporting; null until known (or unknowable), when all are offered. */
  const [availability, setAvailability] = useState<Record<string, Availability> | null>(null);
  const pinned = useRef(false);
  const zone = station.timeZone;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stations")
      .then((res) => (res.ok ? (res.json() as Promise<Record<string, Availability>>) : null))
      .then((a) => !cancelled && setAvailability(a))
      .catch(() => {
        // Unknown, then: every station stays on offer.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const fetchSnapshot = async () => {
      const res = await fetch(`/api/buoy/${station.id}`);
      if (!res.ok) throw new Error("This buoy isn't reporting right now, so there are no waves to show. Pick another from the list.");
      return (await res.json()) as BuoyResponse;
    };
    (async () => {
      try {
        const snapshot = await fetchSnapshot();
        // three.js loads only in the browser, after the data it needs is here.
        const { startScene } = await import("@/engine/app");
        if (cancelled || !canvas.current) return;
        migrateLegacyKeys();
        const fromUrl = lookFromUrl();
        pinned.current = fromUrl !== null;
        const initial = fromUrl ?? loadLook();
        const kind = loadChoice(BOAT_KEY, BOATS.map((b) => b.kind), "none");
        const cameras = CAMERAS.filter((c) => kind !== "none" || !c.boat).map((c) => c.mode);
        const view = loadChoice(CAMERA_KEY, cameras, "float");
        const q = loadChoice(QUALITY_KEY, QUALITIES, "auto");
        const scene = startScene(canvas.current, snapshot, { timeZone: station.timeZone, facing: station.facing ?? snapshot.spectrum.dp, sea: station.sea }, initial, view, q);
        setQuality(q);
        setVolume(loadVolume());
        setSound(false);
        running.current = scene;
        scene.setBoat(kind);
        setBoat(kind);
        (window as unknown as { __ocean?: Running }).__ocean = scene;
        setLook(initial);
        setCamera(view);
        setState({ kind: "ready", snapshots: [snapshot] });
        poll = setInterval(() => {
          fetchSnapshot()
            .then((next) => {
              running.current?.addSnapshot(next);
              setState((prev) => {
                if (prev.kind !== "ready") return prev;
                const last = prev.snapshots[prev.snapshots.length - 1];
                if (next.record.start <= last.record.start) return { ...prev, snapshots: [...prev.snapshots.slice(0, -1), { ...last, weather: next.weather ?? last.weather }] };
                return { ...prev, snapshots: [...prev.snapshots, next].slice(-3) };
              });
            })
            .catch(() => {
              // A missed poll is retried at the next one; the scene keeps playing what it has.
            });
        }, POLL_MS);
      } catch (error) {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
          // Straight to the other buoys.
          setPicking(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      running.current?.dispose();
      running.current = null;
    };
  }, [station]);

  const chooseCamera = (mode: CameraMode) => {
    setCamera(mode);
    running.current?.setCamera(mode);
    saveChoice(CAMERA_KEY, mode, "float");
  };

  const chooseBoat = (kind: BoatKind) => {
    const from = boat;
    setBoat(kind);
    running.current?.setBoat(kind);
    saveChoice(BOAT_KEY, kind, "none");
    // Launching a boat puts you behind it; taking it away leaves nothing to chase.
    if (from === "none" && kind !== "none") chooseCamera("chase");
    if (kind === "none" && CAMERAS.find((c) => c.mode === camera)?.boat) chooseCamera("float");
  };

  const chooseQuality = (q: Quality) => {
    setQuality(q);
    running.current?.setQuality(q);
    saveChoice(QUALITY_KEY, q, "auto");
  };

  const toggleSound = () => {
    const on = !sound;
    setSound(on);
    running.current?.setSound(on ? volume : 0);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    running.current?.setSound(v);
    saveChoice(VOLUME_KEY, String(v), "0.6");
  };

  const hold = (part: keyof Helm, value: number) => {
    touchHelm.current = { ...touchHelm.current, [part]: value };
    running.current?.setTouchHelm(touchHelm.current);
  };

  // The label's clock.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const tick = () => setStatus(running.current?.status() ?? null);
    tick();
    // Often enough for the boat's speed readout to feel live.
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state.kind]);

  const change = (next: LookSettings) => {
    setLook(next);
    running.current?.setLook(next);
    if (!pinned.current) saveLook(next);
  };

  const snapshots = state.kind === "ready" ? state.snapshots : undefined;
  // The numbers describe the record on screen; the weather is the newest there is.
  const s = snapshots ? (snapshots.find((x) => x.record.start === status?.recordStart) ?? snapshots[0]) : undefined;
  const weather = snapshots?.[snapshots.length - 1].weather ?? null;
  // Presets depend only on the local day; recompute when it changes, not every tick.
  const day = status ? localMidnight(status.sceneTime, zone) : null;
  const p = useMemo(() => (s && day !== null ? presets(day + 43200, s.latitude, s.longitude, zone) : undefined), [s, day, zone]);
  const clouds = look.cloudCover ?? status?.cloudCover ?? 0;
  const liveMinutes = status ? localMinutes(status.sceneTime, zone) : 0;
  const tz = status ? zoneName(status.sceneTime, zone) : "";
  const hint = CAMERAS.find((c) => c.mode === camera)?.hint;
  const isLive = look.lightAt === null && look.cloudCover === null && look.weather === null;
  const cond = status?.conditions;

  return (
    <main className="relative h-full w-full">
      <canvas ref={canvas} className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing" />

      <nav aria-label="Buoy" className="absolute left-4 top-4 z-20 text-[13px] text-white/90">
        <button
          type="button"
          onClick={() => {
            setPicking((o) => !o);
            setOpen(false);
          }}
          aria-expanded={picking}
          aria-controls="station-list"
          className="block max-w-[calc(100vw-12.5rem)] truncate rounded-full border border-white/15 bg-black/35 px-3.5 py-1.5 backdrop-blur-md touch:min-h-11 transition hover:bg-black/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 sm:max-w-none"
        >
          {station.name} <span className="hidden text-white/55 sm:inline">· {station.region}</span>
        </button>
        {picking && (
          <ul
            id="station-list"
            className="mt-2 max-h-[min(28rem,calc(100dvh-6rem))] w-[min(17rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-neutral-950/95 p-1.5 pb-0 shadow-2xl after:pointer-events-none after:sticky after:bottom-0 after:block after:h-6 after:bg-linear-to-t after:from-neutral-950 after:to-transparent"
          >
            {STATIONS.map((st) => {
              const here = st.id === station.id;
              const offline = !here && availability?.[st.id] === "offline";
              return (
                <li key={st.id}>
                  {offline ? (
                    <span data-offline="" className="flex cursor-not-allowed items-baseline justify-between gap-3 rounded-xl px-3 py-1.5 touch:min-h-11 touch:items-center text-white/40">
                      <span>{st.name}</span>
                      <span className="text-[11px] text-white/65">Not reporting</span>
                    </span>
                  ) : (
                    <Link
                      href={stationPath(st)}
                      aria-current={here ? "page" : undefined}
                      onClick={() => setPicking(false)}
                      className={`flex items-baseline justify-between gap-3 rounded-xl px-3 py-1.5 touch:min-h-11 touch:items-center transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${here ? "bg-white text-black" : "hover:bg-white/10"}`}
                    >
                      <span>{st.name}</span>
                      <span className={`text-[11px] ${here ? "text-black/60" : "text-white/45"}`}>{st.region}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* Bottom of the screen. On a phone everything stacks in one column, so nothing overprints;
          on a phone held sideways the controls take the left column and the helm and label the right;
          from lg up the label sits bottom right and the controls bottom left. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-6 flex flex-col items-end gap-3 short:grid short:grid-cols-[minmax(0,1fr)_auto] short:items-end lg:contents">
        {boat !== "none" && state.kind === "ready" && (
          <div className="pointer-events-auto hidden flex-col items-end gap-2 short:col-start-2 short:row-start-1 short:justify-self-end lg:absolute lg:bottom-56 lg:right-4 touch:flex" aria-label="Helm controls">
            <div className="flex gap-2">
              <HoldButton label="Throttle up" part="throttle" value={1} onHold={hold}>▲</HoldButton>
              <HoldButton label="Throttle down" part="throttle" value={-1} onHold={hold}>▼</HoldButton>
            </div>
            <div className="flex gap-2">
              <HoldButton label="Steer to port" part="rudder" value={-1} onHold={hold}>◀</HoldButton>
              <HoldButton label="Steer to starboard" part="rudder" value={1} onHold={hold}>▶</HoldButton>
            </div>
          </div>
        )}

        {s && status && (
          <div className="max-w-full select-none rounded-xl bg-black/50 px-3 py-2 short:col-start-2 short:row-start-2 short:max-w-[20rem] short:justify-self-end text-right text-[13px] leading-5 text-white/90 backdrop-blur-md lg:absolute lg:bottom-24 lg:right-4 lg:max-w-[calc(100%-2rem)]">
            <div className="font-mono tracking-wide">
              {s.spectrum.hs.toFixed(2)} m · {s.spectrum.tp.toFixed(1)} s · {compass(s.spectrum.dp)}
            </div>
            <div className="text-white/75">
              {station.name} buoy {station.id.slice(0, 3)}
              {s.sst && <> · sea {s.sst.celsius.toFixed(1)} °C</>} · waves as measured at {formatMinutes(liveMinutes)} {tz}, {formatLag(status.lag)} behind live
            </div>
            {look.lightAt !== null && <div className="text-amber-200/80">Lit as {formatMinutes(look.lightAt)} {tz} (your setting)</div>}
            {look.weather !== null && <div className="text-amber-200/80">{WEATHER_NAMES[look.weather]} weather (your setting); the waves are still the buoy&apos;s</div>}
            {status.waiting && <div className="text-white/70">Waiting for the buoy&apos;s next record; replaying the last half hour</div>}
          </div>
        )}

        {state.kind === "ready" && (
          <div className="pointer-events-auto flex max-w-full flex-col items-start gap-1.5 self-start short:col-start-1 short:row-span-2 short:row-start-1 short:self-end text-[13px] text-white/90 lg:absolute lg:bottom-6 lg:left-4 lg:max-w-[calc(100%-2rem)]">
            {status?.boat && (
              <div className="rounded-full bg-black/50 px-3 py-1 font-mono text-[12px] tracking-wide text-white/90 backdrop-blur-md">
                {Math.abs(status.boat.knots).toFixed(0).padStart(2, "\u2007")} kn · {Math.round(status.boat.heading).toString().padStart(3, "0")}° · throttle{" "}
                {status.boat.throttle < -0.01 ? "astern" : `${Math.round(status.boat.throttle * 100)}%`}
              </div>
            )}
            <div role="group" aria-label="Boat" className="flex flex-wrap rounded-full border border-white/15 bg-black/50 p-0.5 backdrop-blur-md">
              {BOATS.map((b) => (
                <button
                  key={b.kind}
                  type="button"
                  aria-pressed={boat === b.kind}
                  onClick={() => chooseBoat(b.kind)}
                  className={`rounded-full px-3 py-1 touch:min-h-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${boat === b.kind ? "bg-white text-black" : "hover:bg-white/15"}`}
                >
                  {b.name}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Camera" className="flex flex-wrap rounded-full border border-white/15 bg-black/50 p-0.5 backdrop-blur-md">
              {CAMERAS.filter((c) => boat !== "none" || !c.boat).map((c) => (
                <button
                  key={c.mode}
                  type="button"
                  aria-pressed={camera === c.mode}
                  onClick={() => chooseCamera(c.mode)}
                  className={`rounded-full px-3 py-1 touch:min-h-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${camera === c.mode ? "bg-white text-black" : "hover:bg-white/15"}`}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-2xl bg-black/50 px-3 py-1 text-[12px] text-white/80 backdrop-blur-md">
              <span>{hint}</span>
              <button
                type="button"
                onClick={() => running.current?.resetView()}
                className="whitespace-nowrap rounded py-1 touch:min-h-11 touch:px-2 underline decoration-white/40 underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
              >
                Reset view
              </button>
            </div>
          </div>
        )}
      </div>

      {s && status && p && (
        <div className="absolute right-4 top-4 flex flex-col items-end gap-2 text-[13px] text-white/90">
          <div className="flex max-w-[11.5rem] flex-wrap items-center justify-end gap-2 sm:max-w-none sm:flex-nowrap">
            {sound && (
              <input
                type="range"
                min={5}
                max={100}
                step={1}
                value={Math.round(volume * 100)}
                onChange={(e) => changeVolume(Number(e.target.value) / 100)}
                aria-label="Volume"
                className="order-last w-28 touch:h-11 accent-white sm:order-first"
              />
            )}
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label="Sound"
              title={sound ? "Sound on" : "Sound off"}
              className={`grid h-[34px] w-[34px] touch:h-11 touch:w-11 place-items-center rounded-full border border-white/15 backdrop-blur-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${sound ? "bg-white text-black" : "bg-black/35 hover:bg-black/50"}`}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
                {sound ? <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /> : <path d="M17 9l5 6M22 9l-5 6" />}
              </svg>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen((o) => !o);
                setPicking(false);
              }}
              aria-expanded={open}
              aria-controls="look-panel"
              className="rounded-full border border-white/15 bg-black/35 px-3.5 py-1.5 touch:min-h-11 backdrop-blur-md transition hover:bg-black/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
            >
              <span className="hidden sm:inline">{isLive ? "Live" : "Custom"} · </span>Light &amp; sky
            </button>
          </div>
          {open && (
            <section
              id="look-panel"
              aria-label="Light and sky"
              className="max-h-[calc(100dvh-8rem)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-black/45 p-4 shadow-2xl backdrop-blur-xl"
            >
              <fieldset>
                <legend className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/55">Light</legend>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["Live", null],
                      ["Dawn", p.dawn],
                      ["Noon", p.noon],
                      ["Dusk", p.dusk],
                      ["Night", p.night],
                    ] as const
                  ).map(([name, minutes]) => {
                    const active = look.lightAt === minutes;
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={active}
                        onClick={() => change({ ...look, lightAt: minutes })}
                        className={`rounded-full px-3 py-1 touch:min-h-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${active ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"}`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
                <label className="mt-3 block">
                  <span className="flex justify-between text-white/70">
                    <span>Time of light</span>
                    <span className="font-mono">{formatMinutes(look.lightAt ?? liveMinutes)} {tz}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1439}
                    step={1}
                    value={look.lightAt ?? liveMinutes}
                    onChange={(e) => change({ ...look, lightAt: Number(e.target.value) })}
                    className="mt-1 w-full touch:h-11 accent-white"
                  />
                </label>
              </fieldset>

              <fieldset className="mt-4">
                <legend className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/55">Weather</legend>
                <div className="flex flex-wrap gap-1.5">
                  {([null, ...WEATHER_PRESETS] as const).map((w) => {
                    const active = look.weather === w;
                    return (
                      <button
                        key={w ?? "live"}
                        type="button"
                        aria-pressed={active}
                        onClick={() => change({ ...look, weather: w })}
                        className={`rounded-full px-3 py-1 touch:min-h-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${active ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"}`}
                      >
                        {w === null ? "Live" : WEATHER_NAMES[w]}
                      </button>
                    );
                  })}
                </div>
                {cond && (
                  <p className="mt-2 font-mono text-[11px] text-white/60">
                    {cond.rain < 0.05 ? "No rain" : `Rain ${cond.rain.toFixed(1)} mm/h`} · visibility {cond.visibility >= 10_000 ? `${Math.round(cond.visibility / 1000)} km` : `${(cond.visibility / 1000).toFixed(1)} km`} · wind {Math.round(cond.wind)} m/s
                    {cond.thunder ? " · thunder" : ""}
                  </p>
                )}
              </fieldset>

              <fieldset className="mt-4">
                <legend className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/55">Clouds</legend>
                <label className="block">
                  <span className="flex justify-between text-white/70">
                    <span>{look.cloudCover !== null ? "Your setting" : look.weather !== null ? "From the weather you chose" : "Live, from the weather model"}</span>
                    <span className="font-mono">{Math.round(clouds * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(clouds * 100)}
                    onChange={(e) => change({ ...look, cloudCover: Number(e.target.value) / 100 })}
                    className="mt-1 w-full touch:h-11 accent-white"
                  />
                </label>
              </fieldset>

              <button
                type="button"
                onClick={() => change(LIVE_LOOK)}
                disabled={isLive}
                className="mt-4 w-full rounded-xl bg-white/10 py-2 touch:min-h-11 transition enabled:hover:bg-white/20 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
              >
                Reset to live
              </button>

              <fieldset className="mt-4 border-t border-white/10 pt-3">
                <legend className="sr-only">Picture quality</legend>
                <div aria-hidden="true" className="mb-2 text-[11px] uppercase tracking-[0.14em] text-white/55">Picture quality</div>
                <div className="flex flex-wrap gap-1.5">
                  {QUALITIES.map((q) => (
                    <button
                      key={q}
                      type="button"
                      aria-pressed={quality === q}
                      onClick={() => chooseQuality(q)}
                      className={`rounded-full px-3 py-1 touch:min-h-11 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${quality === q ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"}`}
                    >
                      {QUALITY_NAMES[q]}
                    </button>
                  ))}
                </div>
                <p className="mt-2 font-mono text-[11px] text-white/60">
                  {quality === "auto" ? `${QUALITY_NAMES[status.quality.preset]} for this device · ` : ""}
                  drawing at {status.quality.pixelRatio.toFixed(2)}x resolution
                </p>
              </fieldset>

              <p className="mt-3 text-[11px] leading-4 text-white/50">
                Waves: <a href="https://cdip.ucsd.edu/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white/80">CDIP</a> buoy {station.id}, rebuilt from its motion.{s?.sst ? " Sea temperature: the buoy's own sensor." : ""} Sun and moon: computed for the moment the waves were measured.
                {weather ? (
                  <>
                    {" "}Clouds, rain, visibility and wind: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white/80">Open-Meteo</a> model (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white/80">CC BY 4.0</a>), wind from the {compass(weather.windDirection)}.
                  </>
                ) : " Weather: unavailable, using fair-weather defaults."}
                {" "}Land and sea floor: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white/80">Terrain Tiles</a> (USGS, Copernicus EU-DEM, NOAA and others).
              </p>
            </section>
          )}
        </div>
      )}

      {state.kind === "loading" && <p className="absolute inset-0 grid place-items-center text-sm text-white/50">Reading the buoy…</p>}
      {state.kind === "error" && <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/70">{state.message}</p>}
    </main>
  );
}
