# Bundled HTML5 runtime

`scripts/runner.js` loads the runtime bundle, followed by the custom RAF
scheduler. The manifest preserves the order of all 158 upstream scripts.

To regenerate the compact bundle after changing a source file:

```sh
npm ci --ignore-scripts
node scripts/build-runtime-bundle.js
node --check scripts/runtime.bundle.js
```

The build uses the locked Terser version with compression and name mangling
disabled. It retains runtime globals, compiler directives and license
notices. Use `node scripts/build-runtime-bundle.js --readable` to temporarily
generate a bundle with source boundaries and comments for debugging.

In an HTML5 export that loads `scripts/runner.js`, add these hints to the
document head to let the browser discover both scripts while it downloads
the game code. Use the same URLs as the runner.

```html
<link rel="preload" as="script" href="scripts/runtime.bundle.js">
<link rel="preload" as="script" href="scripts/runtime.frame-scheduler-patch.js">
```

The regular script tags still control execution order. Plain JavaScript
works on static hosts. If your server supports HTTP compression, serve the
same URLs with Brotli or gzip negotiated through `Accept-Encoding`.

Install the complete `scripts/` directory together. The frame scheduler uses
the hook in the bundled `animate()` entry point. The bootstrap loads the
bundle first and the matching scheduler second.
