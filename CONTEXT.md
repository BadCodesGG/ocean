# Context

Domain glossary for Ocean (repo `swell`). Terms are used as defined here in code, tests and docs.

## Terms

- **Buoy / station**: a CDIP wave buoy from the fixed list in `src/lib/stations.ts`. Each has a slug used as its address, such as `/waimea-bay`.
- **CDIP**: Coastal Data Information Program, Scripps Institution of Oceanography. The source of all buoy data, read over OPeNDAP from its THREDDS server.
- **Record**: the newest complete 30-minute raw motion series (heave and horizontal displacement) from a buoy.
- **Spectrum**: the half-hourly directional wave spectrum a buoy publishes. Drives the synthesised chop.
- **Swell band**: waves below about 0.28 Hz, summed phase-resolved from the buoy's own measured displacement, so exact at the buoy.
- **Chop**: shorter waves synthesised from the directional spectrum with random phases.
- **Cascade**: one of the four random-phase FFT layers (Tessendorf's method) that fill in the chop. The longest also carries the swell band for the distance.
- **Swell window**: the area around the camera where the swell band is summed directly.
- **Delayed live**: the scene plays about 80 minutes behind real time, because that is the age of the newest complete record. If the next record is late, the last half hour replays.
- **Scene**: the three.js world: sea, sky, coast, boat, weather.
- **Coast**: land and sea floor built from elevation tiles, curved with the Earth; the sea is clipped where land stands above it.
- **Look**: the pinned light and weather state (`?at=`, `clouds`, `weather`), time of day local to the buoy.
- **Weather override**: Clear, showers, squall or storm chosen by the user; waves stay the buoy's own. "Live" returns to real conditions.
- **Camera modes**: Float, Orbit, Fly, Helm, Chase, Tour. Helm and Chase need a boat.
- **Quality preset**: Auto, Low, Medium, High, Max. Auto adjusts resolution to hold the frame rate.
- **World axes**: x east, y up, z south. CDIP's Y axis points west and is converted on parse.
