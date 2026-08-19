// GameMaker HTML5 Runtime bootstrap.
// The original 158 synchronous script requests are combined into one file.
// Source order is preserved in scripts/runtime.bundle.js.
document.write('<script type="text/javascript" src="scripts/runtime.bundle.js"></script>');

// Experimental scheduler override is intentionally kept outside the generated
// bundle for A/B testing. Remove this line to restore the bundled runtime logic.
document.write('<script type="text/javascript" src="scripts/runtime.frame-scheduler-patch.js"></script>');

// Experimental particle type slot reuse + diagnostics. Kept outside the bundle
// so the experiment can be removed without regenerating runtime.bundle.js.
document.write('<script type="text/javascript" src="scripts/runtime.particle-type-reuse-patch.js"></script>');
