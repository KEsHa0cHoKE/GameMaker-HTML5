# Bundled HTML5 runtime

`scripts/runner.js` used to inject 158 runtime scripts. It now loads one file:
`scripts/runtime.bundle.js`.

This removes the large per-request latency cost before `GameMaker_Init()` can
create the GameMaker loading screen. Script order is kept exactly as it was in
the original runner.

To regenerate the bundle after changing runtime scripts, run:

```bash
node scripts/build-runtime-bundle.js
```

The original load order is retained in `scripts/runtime.bundle.manifest.json`.
