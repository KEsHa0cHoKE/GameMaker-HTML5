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
