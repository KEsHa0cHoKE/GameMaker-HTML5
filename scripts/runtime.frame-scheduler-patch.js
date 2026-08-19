// Browser frame diagnostics for the bundled GameMaker HTML5 runtime.
// Loaded synchronously after runtime.bundle.js by runner.js.
//
// IMPORTANT: this file does NOT change GameMaker's scheduling policy.
// The original GameMaker_Tick keeps its stock setTimeout -> RAF behaviour.
// We only wrap it to observe tick cadence and run an independent RAF/Long Task
// probe for performance diagnostics.
(function() {
    if (window.yyFrameSchedulerPatchApplied) return;
    window.yyFrameSchedulerPatchApplied = true;

    var g_YYFrameProbeLastBrowserRafMs = 0;
    var g_YYFrameProbeLastTickMs = 0;
    var g_YYFrameProbeHistogramBinMs = 0.5;
    var g_YYFrameProbeHistogramBins = 402;
    var g_YYFrameProbeStarted = false;

    var g_YYFrameProbeStats = {
        smoothEnabled: false,
        smoothActive: false,
        targetFps: 0,
        targetIntervalMs: 0,

        browserRafCallbacks: 0,
        browserRafSamples: 0,
        browserRafSumMs: 0,
        browserRafWorstMs: 0,
        browserRafHistogram: new Array(g_YYFrameProbeHistogramBins).fill(0),

        tickCount: 0,
        tickSamples: 0,
        tickSumMs: 0,
        tickWorstMs: 0,
        tickHistogram: new Array(g_YYFrameProbeHistogramBins).fill(0),

        longTaskSupported: false,
        longTaskCount: 0,
        longTaskSumMs: 0,
        longTaskWorstMs: 0
    };

    function yyFrameProbe_RecordHistogram(_histogram, _valueMs) {
        var _bin = Math.max(0, Math.min(
            g_YYFrameProbeHistogramBins - 1,
            Math.floor(_valueMs / g_YYFrameProbeHistogramBinMs)
        ));
        _histogram[_bin]++;
    }

    function yyFrameProbe_Percentile(_histogram, _count, _fraction) {
        if (_count <= 0) return 0;

        var _target = Math.ceil(_count * _fraction);
        var _accumulated = 0;
        for (var _i = 0; _i < _histogram.length; ++_i) {
            _accumulated += _histogram[_i];
            if (_accumulated >= _target) {
                return _i * g_YYFrameProbeHistogramBinMs;
            }
        }
        return (_histogram.length - 1) * g_YYFrameProbeHistogramBinMs;
    }

    function yyFrameProbe_ResetStats() {
        var _stats = g_YYFrameProbeStats;

        _stats.smoothEnabled = false;
        _stats.smoothActive = false;
        _stats.targetFps = 0;
        _stats.targetIntervalMs = 0;

        _stats.browserRafCallbacks = 0;
        _stats.browserRafSamples = 0;
        _stats.browserRafSumMs = 0;
        _stats.browserRafWorstMs = 0;
        _stats.browserRafHistogram.fill(0);

        _stats.tickCount = 0;
        _stats.tickSamples = 0;
        _stats.tickSumMs = 0;
        _stats.tickWorstMs = 0;
        _stats.tickHistogram.fill(0);

        _stats.longTaskCount = 0;
        _stats.longTaskSumMs = 0;
        _stats.longTaskWorstMs = 0;

        // Avoid counting the interval spanning the reset boundary.
        g_YYFrameProbeLastBrowserRafMs = 0;
        g_YYFrameProbeLastTickMs = 0;
    }

    function yyFrameProbe_GetStats() {
        var _stats = g_YYFrameProbeStats;
        var _browserP50 = yyFrameProbe_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.50
        );
        var _browserP95 = yyFrameProbe_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.95
        );
        var _browserP99 = yyFrameProbe_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.99
        );
        var _tickP95 = yyFrameProbe_Percentile(
            _stats.tickHistogram,
            _stats.tickSamples,
            0.95
        );
        var _tickP99 = yyFrameProbe_Percentile(
            _stats.tickHistogram,
            _stats.tickSamples,
            0.99
        );

        return {
            mode: "diagnostics_only",
            smoothEnabled: false,
            smoothActive: false,
            maxSmoothTargetFps: 0,
            targetFps: _stats.targetFps,
            targetIntervalMs: _stats.targetIntervalMs,
            browserRaf: {
                callbacks: _stats.browserRafCallbacks,
                samples: _stats.browserRafSamples,
                avgMs: _stats.browserRafSamples > 0
                    ? _stats.browserRafSumMs / _stats.browserRafSamples
                    : 0,
                p50Ms: _browserP50,
                p95Ms: _browserP95,
                p99Ms: _browserP99,
                worstMs: _stats.browserRafWorstMs,
                estimatedHz: _browserP50 > 0 ? 1000 / _browserP50 : 0
            },
            gameTick: {
                count: _stats.tickCount,
                samples: _stats.tickSamples,
                avgMs: _stats.tickSamples > 0
                    ? _stats.tickSumMs / _stats.tickSamples
                    : 0,
                p95Ms: _tickP95,
                p99Ms: _tickP99,
                worstMs: _stats.tickWorstMs,
                skippedRafCallbacks: 0
            },
            longTasks: {
                supported: _stats.longTaskSupported,
                count: _stats.longTaskCount,
                totalMs: _stats.longTaskSumMs,
                worstMs: _stats.longTaskWorstMs
            }
        };
    }

    function yyFrameProbe_RecordTick(_nowMs) {
        var _stats = g_YYFrameProbeStats;
        var _targetSpeed = 0;

        if (typeof g_GameTimer !== "undefined" && g_GameTimer) {
            _targetSpeed = g_GameTimer.GetFPS();
        }

        if (_targetSpeed > 0) {
            _stats.targetFps = _targetSpeed;
            _stats.targetIntervalMs = 1000 / _targetSpeed;
        }

        if (g_YYFrameProbeLastTickMs > 0) {
            var _tickDeltaMs = _nowMs - g_YYFrameProbeLastTickMs;
            if (_tickDeltaMs > 0 && _tickDeltaMs < 1000) {
                _stats.tickSamples++;
                _stats.tickSumMs += _tickDeltaMs;
                _stats.tickWorstMs = Math.max(_stats.tickWorstMs, _tickDeltaMs);
                yyFrameProbe_RecordHistogram(_stats.tickHistogram, _tickDeltaMs);
            }
        }

        g_YYFrameProbeLastTickMs = _nowMs;
        _stats.tickCount++;
    }

    function yyFrameProbe_BrowserRaf(_timestamp) {
        var _stats = g_YYFrameProbeStats;
        _stats.browserRafCallbacks++;

        if (g_YYFrameProbeLastBrowserRafMs > 0) {
            var _deltaMs = _timestamp - g_YYFrameProbeLastBrowserRafMs;
            if (_deltaMs > 0 && _deltaMs < 1000) {
                _stats.browserRafSamples++;
                _stats.browserRafSumMs += _deltaMs;
                _stats.browserRafWorstMs = Math.max(
                    _stats.browserRafWorstMs,
                    _deltaMs
                );
                yyFrameProbe_RecordHistogram(
                    _stats.browserRafHistogram,
                    _deltaMs
                );
            }
        }

        g_YYFrameProbeLastBrowserRafMs = _timestamp;
        if (window.yyRequestAnimationFrame) {
            window.yyRequestAnimationFrame(yyFrameProbe_BrowserRaf);
        }
    }

    function yyFrameProbe_Start() {
        if (g_YYFrameProbeStarted) return;
        g_YYFrameProbeStarted = true;

        if (window.yyRequestAnimationFrame) {
            window.yyRequestAnimationFrame(yyFrameProbe_BrowserRaf);
        }

        try {
            if (
                typeof PerformanceObserver !== "undefined" &&
                PerformanceObserver.supportedEntryTypes &&
                PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0
            ) {
                g_YYFrameProbeStats.longTaskSupported = true;
                new PerformanceObserver(function(_list) {
                    var _entries = _list.getEntries();
                    for (var _i = 0; _i < _entries.length; ++_i) {
                        var _duration = _entries[_i].duration || 0;
                        g_YYFrameProbeStats.longTaskCount++;
                        g_YYFrameProbeStats.longTaskSumMs += _duration;
                        g_YYFrameProbeStats.longTaskWorstMs = Math.max(
                            g_YYFrameProbeStats.longTaskWorstMs,
                            _duration
                        );
                    }
                }).observe({ entryTypes: ["longtask"] });
            }
        } catch (_err) {
            g_YYFrameProbeStats.longTaskSupported = false;
        }
    }

    // Keep the public API used by the game's performance HUD. Enabling smooth
    // scheduling is intentionally disabled in this control build.
    window.yyFrameSchedulerGetStats = yyFrameProbe_GetStats;
    window.yyFrameSchedulerGetStatsJSON = function() {
        return JSON.stringify(yyFrameProbe_GetStats());
    };
    window.yyFrameSchedulerResetStats = yyFrameProbe_ResetStats;
    window.yyFrameSchedulerSetEnabled = function() {
        return false;
    };

    // Observe GameMaker ticks without touching the original scheduling logic.
    var _originalGameMakerTick = window.GameMaker_Tick;
    if (typeof _originalGameMakerTick === "function") {
        window.GameMaker_Tick = function GameMaker_Tick() {
            var _nowMs = (
                window.performance &&
                typeof window.performance.now === "function"
            ) ? window.performance.now() : Date.now();

            yyFrameProbe_RecordTick(_nowMs);
            return _originalGameMakerTick.apply(this, arguments);
        };
    }

    yyFrameProbe_Start();
})();
