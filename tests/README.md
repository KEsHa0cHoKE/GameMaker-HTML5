# HTML5 particle benchmark and RNG regression test

Run the regression test from the runtime checkout:

```sh
node --test tests/extended-rng.test.cjs
```

Run the browser benchmark using the checked-in `runtime.bundle.js`:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/tests/particle-benchmark.html?scenario=reuse&cycles=500`.
In DevTools, record Performance while reloading the page. The
`particle-benchmark-start` and `particle-benchmark-end` marks bracket the timed
cycles. The result is also available as `window.benchmarkResult`, including
individual samples. DevTools Memory can capture retained heap before and after
a run.

| Scenario | Work per cycle |
| --- | --- |
| `reuse` | One type and system, 50 particles per call |
| `types` | Create and destroy a type for each burst of 50 |
| `systems` | Create and destroy a system for each burst of 50 |
| `mixed` | Rotate between four particle types |
| `bulk` | Create 500 particles with one API call. Use `cycles=100` for a baseline with unbounded RNG state. |
| `rooms` | Move between two rooms every 25 cycles, exercising the runtime's persistent and volatile particle-system layer hooks |
| `emitter` | Use the GML emitter-region and burst API |
| `legacy` | Same work as `reuse`, using one-argument `random_set_seed` |
| `rng` | Make the equivalent 250 RNG calls without creating particle objects |

Add `&webgl=1` to render with the runtime's WebGL renderer. The benchmark uses
one burst, update and clear per animation callback. `workMs` is synchronous
JavaScript work, while `intervalMs` is the time between callbacks. Individual
function durations are inclusive, so `EmitParticles` includes `CreateParticle`.
After the timed cycles, the benchmark clears all systems and types, creates
a new burst, measures a 500-particle burst and repeats the original size after
reinitializing the seed.

The same scenarios can run in Node when a browser is unavailable:

```sh
node --expose-gc tests/run-particle-benchmark.cjs reuse 500
node --expose-gc tests/run-particle-benchmark.cjs reuse 500 /path/to/baseline-checkout
```

The Node runner uses the runtime source files, `setImmediate` callback
intervals and V8 GC events. Node timings exclude presentation and GPU work.
Set `PARTICLE_CPU_PROFILE` to a writable path ending in `.cpuprofile` to collect
a V8 CPU profile.

## Frame benchmarks

```sh
node --test tests/*.test.cjs
node tests/run-component-benchmark.cjs . /path/to/input-runtime
```

Use an unpacked copy of the original runtime archive as the input runtime.
The component benchmark alternates before/after and separately times the
extended RNG, particle allocation with the legacy RNG, and expiry of 5,000
out of 6,000 particles.

The Chromium benchmark runs both runtimes through the same test page, using
the actual runtime tick, particle API and WebGL renderer:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/run-runtime-benchmark.cjs . /path/to/input-runtime frame-results.json
```

Pass an empty baseline path to measure the updated runtime only. The runner
uses a temporary loopback HTTP server. Set `PLAYWRIGHT_MODULE` or
`CHROMIUM_PATH` to use an existing installation.

| Setting | Default or behavior |
| --- | --- |
| `BENCH_PROFILES` | `desktop,cpu4,mobile` |
| `BENCH_SCENARIOS` | `menu,songs,tiles,burst,expiry,combined,rooms,resources` |
| `BENCH_FRAMES` | Timed frames per scenario, default 120, use at least 3 |
| `BENCH_WARMUP` | Warm-up frames per scenario, default 90 |
| `BENCH_REPEATS` | Repeats per runtime and profile, default 3 |
| `BENCH_CPU_PROFILE=1` | Save V8 CPU profiles beside the JSON file |
| `BENCH_SWIFTSHADER=1` | Request software WebGL |
| `BENCH_SINGLE_PROCESS=1` | Use for a Chromium headless shell that requires single-process mode |
| `BENCH_FREEZE_MS=1200` | Freeze and resume the first scenario via DevTools. Run separately from normal FPS comparisons. |

For interactive inspection, serve the runtime directory with
`python3 -m http.server 8000` and open `/tests/runtime-benchmark.html`.
Allow autoplay or use the automated runner for the audio scenario.
Both variants use a fixed 480×640 framebuffer. The mobile profile changes
viewport, DPR, touch and CPU throttle.

To isolate the original Musical Tiles fragment shaders:

```sh
node tests/run-musical-tiles-shaders.cjs /path/to/Piano-Tiles
```

The shader benchmark uses a synchronizing pixel readback. Compare its
results within one hardware and driver configuration.

Pass the sibling `Musical-Tiles-shader-patch` directory as the second shader
benchmark argument to compare timings and all pixel channels in both palettes.
