// GameMaker HTML5 Runtime bootstrap.
// The original 158 synchronous script requests are combined into one file.
// Source order is preserved in scripts/runtime.bundle.js.
document.write('<script type="text/javascript" src="scripts/runtime.bundle.js"></script>');
// Keep the ACTUAL-RUNTIME RAF scheduler patch after the runtime bundle.
document.write('<script type="text/javascript" src="scripts/runtime.frame-scheduler-patch.js"></script>');
