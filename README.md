# Ocean

**The sea at a real wave buoy, rebuilt live in your browser.**
Ocean reads the latest motion record from one of 15 CDIP wave buoys off Hawaiʻi and the US coasts and rebuilds that water in 3D, with the real sun, moon, weather and coastline at that place.

**Live: [ocean.badcodes.dev](https://ocean.badcodes.dev)**

<!-- demo-video -->

The long swell is phase-resolved from the buoy's own measured displacement, so the sets arrive as they were recorded. The shorter chop is synthesised from the same buoy's directional spectrum. Sun and moon are computed for the place and minute the waves were measured, clouds, wind and rain come from a weather forecast at the buoy, and the land on the horizon is real elevation data, with the sea clipped at the shore. The scene runs about 80 minutes behind live, because that is how old the newest complete buoy record is.

## What you can do

| | |
|---|---|
| **Pick a buoy** | The button at top left lists the 15 stations (Waimea Bay, Barbers Point, Mokapu Point, Hanalei, Pauwela, Hilo, Point Reyes, Harvest, San Nicolas Island, Santa Monica Bay, Torrey Pines Outer, Umpqua Offshore, Grays Harbor, Oregon Inlet, Fernandina Beach). Buoys that are not reporting are greyed out. Each has its own address, such as `/waimea-bay`. |
| **Read the sea** | The label shows significant wave height, peak period, peak direction, sea temperature and how far behind live the scene is. |
| **Look around** | Six cameras: Float (riding the swell near the buoy), Orbit, Fly (`WASD` or arrows, `Q` and `E` down and up, `Shift` faster), Helm, Chase and Tour (an unattended drone pass). Drag to look, scroll or pinch to zoom, Reset view to come back. |
| **Take a boat** | Choose a centre console or a skiff. `W` and `S` throttle, `A` and `D` steer, `X` neutral, or the on-screen buttons on touch. It heaves, pitches and rolls on the same surface, throws bow spray and leaves a wake. Helm and Chase cameras need a boat. |
| **Change the light** | The Light and sky panel jumps to dawn, noon, dusk or night at the buoy, or sets any time of day. |
| **Change the weather** | Clear, showers, squall or storm, and a cloud cover slider. The waves stay the buoy's own. Live returns to the real conditions. |
| **Listen** | Sound is off until you turn it on. The sea, breaking crests, wind, rain, thunder and the outboard are all synthesised with Web Audio, with a volume slider. |
| **Set the picture quality** | Auto holds the frame rate by drawing fewer or more pixels; Low, Medium, High and Max pin it. |
| **Pin a look in the address** | `?at=18:13&clouds=0.45&weather=storm` sets the time of day (local to the buoy), cloud cover and weather. |

Your choices (camera, boat, quality, volume, light) are remembered in `localStorage`.

## How it works

```
src/app/            Next.js App Router: the page, a page per buoy, and two API routes.
  api/buoy/         Fetches and parses one buoy's record from CDIP, with caching.
  api/stations/     Which of the listed buoys are reporting right now.
src/lib/            Buoy and weather data: CDIP OPeNDAP parsing, Open-Meteo, elevation tiles,
                    the station list, time zones, saved settings.
src/engine/         The scene: plain three.js, no React Three Fiber.
  waves.ts          Phase-resolved swell reconstruction from the buoy's displacement record.
  spectrum.ts       The directional spectrum and the initial spectrum of each FFT cascade.
  fft.ts, ocean.ts  The GPU sea: four FFT cascades plus the swell window.
  shaders.ts        GLSL for the water and the FFT passes.
  sky.ts, lighting  Atmosphere bake, sun and moon light, exposure.
  ephemeris.ts      Sun and moon position for a time and place.
  coast.ts          Land and sea floor from elevation tiles.
  boat*.ts, wake.ts, spray.ts   The boats, their wake and spray.
  audio.ts          Web Audio synthesis.
  timeline.ts       The delayed-live clock.
src/components/     The React overlay: buoy picker, controls, label, panels.
scripts/            Smoke test and a screenshot tool.
```

**Data.** Each buoy publishes a half-hourly directional spectrum and a raw record of its heave and horizontal motion. The server route reads both over OPeNDAP from CDIP's THREDDS server, parses them and caches the result (five minutes at the CDN, one minute in memory, failures for one minute). The scene plays the newest complete 30-minute record, delayed so it stays continuous, and replays the last half hour if the next record is late.

**Rendering.** three.js r186 on WebGL 2 with custom GLSL. The swell band (below about 0.28 Hz) is summed from the buoy's own measured motion over a window that follows the camera, so it is exact at the buoy. Four random-phase FFT cascades (Tessendorf's method) fill in shorter waves from the measured spectrum, and the longest one also carries the swell band for the distance beyond the window. `fft.ts` is a TypeScript mirror of the GLSL FFT pass (the spectrum tests run it): change one and change the other. Land is drawn from elevation tiles, dropped by the Earth's curvature so low land far off sinks below the horizon. The sea is not drawn where land stands above it, turns pale over shallows, and breaks on them. The sky is baked into a texture for each sun position, with sun and moon from the Astronomical Almanac and a truncated Meeus lunar theory.

**Audio.** There are no recordings. Noise is shaped with Web Audio from what the scene is drawing: wave height, wind, rain, lightning and the boat's throttle.

**Quality.** Presets set pixel ratio, mesh density, rain and spray counts and bloom. Auto picks one for the device and adjusts resolution to hold the frame rate.

### Things to know before changing the code

- World axes are x east, y up, z south. CDIP's Y axis points west; `parseRecord` in `src/lib/cdip.ts` converts it to east.
- ShaderMaterials that use three's tone-mapping chunks must not set `glslVersion`, because those chunks need `gl_FragColor`.
- The warped sky bake is pre-multiplied by `skyScale`, since night skies otherwise sink into half-float subnormals. Every reader divides by it. The equirect bake used for PMREM stays absolute.
- `renderer.debug.checkShaderErrors` is off in production: on Windows, ANGLE logs harmless X4122 notes.
- Do not construct `THREE.Clock`; it is deprecated in r186.
- Any route that sets metadata goes through `pageMetadata()` in `src/lib/site.ts`. A route that declares its own `openGraph` or `twitter` replaces the layout's wholesale, so its card loses the picture; a route that sets only `title` unfurls with the home page's title and URL. `SITE_URL` is the literal production domain, never `VERCEL_URL` or localhost, because a relative or deployment URL makes Slack and Facebook drop the image. `public/og.jpg` is the share image.
- Saved settings use `ocean-*` localStorage keys; `migrateLegacyKeys()` moves the older `swell-*` ones once.
- Type-check with `npm run typecheck`, not bare `tsc`: it generates the route types first.

## Running it

Node 22 or 24.

```bash
git clone https://github.com/BadCodesGG/ocean.git
cd ocean
npm install
npm run dev            # http://localhost:3000
```

Checks:

```bash
npm run lint           # ESLint
npm run typecheck      # next typegen, then tsc --noEmit
npm run test           # Vitest: data parsing, wave reconstruction, spectrum, ephemeris, camera, quality, settings
npm run build          # production build
npm run test:smoke     # end-to-end on the production build
```

`npm run test:smoke` needs a build first (`npm run build`), Playwright's Chromium (`npx playwright install chromium`) and network access, because it boots `next start` and calls the live CDIP and Open-Meteo services. It then drives the page in Chromium: the scene draws, the coast loads, the console stays clean, the picker, light, weather and quality settings work, a boat launches and the sound switches on. It uses a GPU-backed browser; pass `-- --port=3132` to change the port.

`node scripts/shoot.mjs [url] [out.png]` takes a GPU screenshot of a running instance and prints console warnings (see the script header for `--wait`, `--eval` and `--size`).

The site URL is fixed in `src/lib/site.ts`. If you deploy your own copy, change it there, along with the `frame-ancestors` policy in `next.config.ts`, which only lets `badcodes.dev` embed the site.

## Data and licence

The code is MIT, see [LICENSE](LICENSE). The buoy fixtures under `src/lib/__fixtures__/` are CDIP data and are not covered by it.

| Source | What it provides | Terms |
|---|---|---|
| [CDIP](https://cdip.ucsd.edu/), Scripps Institution of Oceanography, via its [THREDDS server](https://thredds.cdip.ucsd.edu/) | Wave spectra, buoy motion records and sea surface temperature | Free for public use with acknowledgement; web displays should link to the CDIP homepage, which the in-app credit does. The data are read as published; what you see is a visualisation derived from them (the short-period chop and any weather override are synthesised), not CDIP data itself. See [data use and acknowledgements](https://cdip.ucsd.edu/m/documents/data_access.html#data-use-and-acknowledgements). DOI [10.18437/C7WC72](https://doi.org/10.18437/C7WC72). |
| [Open-Meteo](https://open-meteo.com/) forecast API | Cloud cover, wind, rain, visibility and weather code at the buoy | Data under [CC BY 4.0](https://open-meteo.com/en/licence), attribution required. The free API is for non-commercial use, under 10,000 calls a day. |
| [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Terrarium format), from Mapzen's [Joerd](https://github.com/tilezen/joerd) | Land elevation and sea floor depth | A composite of public and open datasets. Attribution is required per source, see the [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Used here: 3DEP, SRTM and GMTED2010 courtesy of the U.S. Geological Survey; EU-DEM produced using Copernicus data funded by the European Union; ETOPO1 from the U.S. National Oceanic and Atmospheric Administration; and other national datasets listed there. |
| [Geist](https://vercel.com/font) fonts | Interface type, loaded through `next/font` | SIL Open Font License 1.1 |

Buoy data courtesy of [CDIP](https://cdip.ucsd.edu/): "data from CDIP, Scripps Institution of Oceanography."

Files that are not covered by the MIT licence, and the terms for the BadCodes name and logo, are listed in [NOTICE](NOTICE).

Built by [BadCodes](https://badcodes.dev).
