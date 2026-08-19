// Experimental single-RAF frame scheduler + browser pacing diagnostics.
// Loaded synchronously after runtime.bundle.js by runner.js.
//
// Goal: remove the legacy setTimeout -> requestAnimationFrame chain for the
// problematic ~60 Hz HTML5 path. There is exactly one animate RAF chain. The
// first in-game GameMaker_Tick deliberately does not queue another RAF because
// startup animate() has already queued the callback that hands ownership to
// this scheduler.
(function() {
    if (window.yyFrameSchedulerPatchApplied) return;
    window.yyFrameSchedulerPatchApplied = true;

    var YY_SMOOTH_FRAME_SCHEDULER = true;
    var YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS = 70;
    var YY_MATCHED_REFRESH_TOLERANCE = 0.04;
    var YY_EARLY_TOLERANCE_MS = 1.0;

    var g_YYOriginalGameMakerTick = window.GameMaker_Tick;
    var g_YYFirstSmoothTick = true;
    var g_YYAnimateRafPending = false;
    var g_YYCurrentSchedulerRafTimestampMs = 0;
    var g_YYLastSchedulerCallbackMs = 0;
    var g_YYAccumulatorMs = 0;
    var g_YYLastTargetFps = 0;
    var g_YYLastTickMs = 0;

    var g_YYProbeStarted = false;
    var g_YYLastBrowserRafMs = 0;
    var g_YYHistogramBinMs = 0.5;
    var g_YYHistogramBins = 402;

    var g_YYStats = {
        smoothEnabled: YY_SMOOTH_FRAME_SCHEDULER,
        smoothActive: false,
        targetFps: 0,
        targetIntervalMs: 0,
        browserRafCallbacks: 0,
        browserRafSamples: 0,
        browserRafSumMs: 0,
        browserRafWorstMs: 0,
        browserRafHistogram: new Array(g_YYHistogramBins).fill(0),
        tickCount: 0,
        tickSamples: 0,
        tickSumMs: 0,
        tickWorstMs: 0,
        tickHistogram: new Array(g_YYHistogramBins).fill(0),
        skippedRafCallbacks: 0,
        schedulerRafCallbacks: 0,
        matchedRefreshCallbacks: 0,
        longTaskSupported: false,
        longTaskCount: 0,
        longTaskSumMs: 0,
        longTaskWorstMs: 0
    };

    function yyRecordHistogram(_histogram, _valueMs) {
        var _bin = Math.max(0, Math.min(
            g_YYHistogramBins - 1,
            Math.floor(_valueMs / g_YYHistogramBinMs)
        ));
        _histogram[_bin]++;
    }

    function yyPercentile(_histogram, _count, _fraction) {
        if (_count <= 0) return 0;
        var _target = Math.ceil(_count * _fraction);
        var _accumulated = 0;
        for (var _i = 0; _i < _histogram.length; ++_i) {
            _accumulated += _histogram[_i];
            if (_accumulated >= _target) return _i * g_YYHistogramBinMs;
        }
        return (_histogram.length - 1) * g_YYHistogramBinMs;
    }

    function yyResetStats() {
        g_YYStats.smoothEnabled = YY_SMOOTH_FRAME_SCHEDULER;
        g_YYStats.smoothActive = false;
        g_YYStats.targetFps = 0;
        g_YYStats.targetIntervalMs = 0;
        g_YYStats.browserRafCallbacks = 0;
        g_YYStats.browserRafSamples = 0;
        g_YYStats.browserRafSumMs = 0;
        g_YYStats.browserRafWorstMs = 0;
        g_YYStats.browserRafHistogram.fill(0);
        g_YYStats.tickCount = 0;
        g_YYStats.tickSamples = 0;
        g_YYStats.tickSumMs = 0;
        g_YYStats.tickWorstMs = 0;
        g_YYStats.tickHistogram.fill(0);
        g_YYStats.skippedRafCallbacks = 0;
        g_YYStats.schedulerRafCallbacks = 0;
        g_YYStats.matchedRefreshCallbacks = 0;
        g_YYStats.longTaskCount = 0;
        g_YYStats.longTaskSumMs = 0;
        g_YYStats.longTaskWorstMs = 0;
        g_YYLastBrowserRafMs = 0;
        g_YYLastTickMs = 0;
        g_YYLastSchedulerCallbackMs = 0;
        g_YYAccumulatorMs = 0;
        g_YYLastTargetFps = 0;
    }

    function yyGetStats() {
        var _browserP50 = yyPercentile(g_YYStats.browserRafHistogram, g_YYStats.browserRafSamples, 0.50);
        var _browserP95 = yyPercentile(g_YYStats.browserRafHistogram, g_YYStats.browserRafSamples, 0.95);
        var _browserP99 = yyPercentile(g_YYStats.browserRafHistogram, g_YYStats.browserRafSamples, 0.99);
        var _tickP95 = yyPercentile(g_YYStats.tickHistogram, g_YYStats.tickSamples, 0.95);
        var _tickP99 = yyPercentile(g_YYStats.tickHistogram, g_YYStats.tickSamples, 0.99);

        return {
            smoothEnabled: YY_SMOOTH_FRAME_SCHEDULER,
            smoothActive: g_YYStats.smoothActive,
            maxSmoothTargetFps: YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS,
            targetFps: g_YYStats.targetFps,
            targetIntervalMs: g_YYStats.targetIntervalMs,
            browserRaf: {
                callbacks: g_YYStats.browserRafCallbacks,
                samples: g_YYStats.browserRafSamples,
                avgMs: g_YYStats.browserRafSamples > 0 ? g_YYStats.browserRafSumMs / g_YYStats.browserRafSamples : 0,
                p50Ms: _browserP50,
                p95Ms: _browserP95,
                p99Ms: _browserP99,
                worstMs: g_YYStats.browserRafWorstMs,
                estimatedHz: _browserP50 > 0 ? 1000 / _browserP50 : 0
            },
            gameTick: {
                count: g_YYStats.tickCount,
                samples: g_YYStats.tickSamples,
                avgMs: g_YYStats.tickSamples > 0 ? g_YYStats.tickSumMs / g_YYStats.tickSamples : 0,
                p95Ms: _tickP95,
                p99Ms: _tickP99,
                worstMs: g_YYStats.tickWorstMs,
                skippedRafCallbacks: g_YYStats.skippedRafCallbacks,
                schedulerRafCallbacks: g_YYStats.schedulerRafCallbacks,
                matchedRefreshCallbacks: g_YYStats.matchedRefreshCallbacks
            },
            longTasks: {
                supported: g_YYStats.longTaskSupported,
                count: g_YYStats.longTaskCount,
                totalMs: g_YYStats.longTaskSumMs,
                worstMs: g_YYStats.longTaskWorstMs
            }
        };
    }

    function yySetEnabled(_enabled) {
        YY_SMOOTH_FRAME_SCHEDULER = !!_enabled;
        g_YYStats.smoothEnabled = YY_SMOOTH_FRAME_SCHEDULER;
        g_YYFirstSmoothTick = true;
        g_YYAnimateRafPending = false;
        g_YYLastSchedulerCallbackMs = 0;
        g_YYAccumulatorMs = 0;
        g_YYLastTargetFps = 0;
        return YY_SMOOTH_FRAME_SCHEDULER;
    }

    function yyBrowserRafProbe(_timestamp) {
        g_YYStats.browserRafCallbacks++;
        if (g_YYLastBrowserRafMs > 0) {
            var _deltaMs = _timestamp - g_YYLastBrowserRafMs;
            if (_deltaMs > 0 && _deltaMs < 1000) {
                g_YYStats.browserRafSamples++;
                g_YYStats.browserRafSumMs += _deltaMs;
                g_YYStats.browserRafWorstMs = Math.max(g_YYStats.browserRafWorstMs, _deltaMs);
                yyRecordHistogram(g_YYStats.browserRafHistogram, _deltaMs);
            }
        }
        g_YYLastBrowserRafMs = _timestamp;
        if (window.yyRequestAnimationFrame) window.yyRequestAnimationFrame(yyBrowserRafProbe);
    }

    function yyEnsureProbeStarted() {
        if (g_YYProbeStarted || !window.yyRequestAnimationFrame) return;
        g_YYProbeStarted = true;
        window.yyRequestAnimationFrame(yyBrowserRafProbe);

        try {
            if (
                typeof PerformanceObserver !== "undefined" &&
                PerformanceObserver.supportedEntryTypes &&
                PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0
            ) {
                g_YYStats.longTaskSupported = true;
                new PerformanceObserver(function(_list) {
                    var _entries = _list.getEntries();
                    for (var _i = 0; _i < _entries.length; ++_i) {
                        var _duration = _entries[_i].duration || 0;
                        g_YYStats.longTaskCount++;
                        g_YYStats.longTaskSumMs += _duration;
                        g_YYStats.longTaskWorstMs = Math.max(g_YYStats.longTaskWorstMs, _duration);
                    }
                }).observe({ entryTypes: ["longtask"] });
            }
        } catch (_err) {
            g_YYStats.longTaskSupported = false;
        }
    }

    function yyScheduleNextAnimate() {
        if (g_YYAnimateRafPending || !window.yyRequestAnimationFrame) return;
        g_YYAnimateRafPending = true;
        window.yyRequestAnimationFrame(function(_timestamp) {
            g_YYAnimateRafPending = false;
            g_YYCurrentSchedulerRafTimestampMs = _timestamp;
            try {
                animate(_timestamp);
            } finally {
                g_YYCurrentSchedulerRafTimestampMs = 0;
            }
        });
    }

    function yyRecordTick(_nowMs, _targetSpeed) {
        var _frameMs = 1000 / Math.max(1, _targetSpeed);
        g_YYStats.targetFps = _targetSpeed;
        g_YYStats.targetIntervalMs = _frameMs;

        if (g_YYStats.tickCount > 0 && g_YYLastTickMs > 0) {
            var _tickDeltaMs = _nowMs - g_YYLastTickMs;
            if (_tickDeltaMs > 0 && _tickDeltaMs < 1000) {
                g_YYStats.tickSamples++;
                g_YYStats.tickSumMs += _tickDeltaMs;
                g_YYStats.tickWorstMs = Math.max(g_YYStats.tickWorstMs, _tickDeltaMs);
                yyRecordHistogram(g_YYStats.tickHistogram, _tickDeltaMs);
            }
        }
        g_YYLastTickMs = _nowMs;
        g_YYStats.tickCount++;
    }

    function yyShouldRunSmoothTick(_nowMs, _targetSpeed) {
        var _frameMs = 1000 / Math.max(1, _targetSpeed);
        g_YYStats.targetFps = _targetSpeed;
        g_YYStats.targetIntervalMs = _frameMs;
        g_YYStats.schedulerRafCallbacks++;

        if (g_YYLastTargetFps !== _targetSpeed) {
            g_YYLastTargetFps = _targetSpeed;
            g_YYAccumulatorMs = _frameMs;
            g_YYLastSchedulerCallbackMs = _nowMs;
            return true;
        }

        if (g_YYLastSchedulerCallbackMs <= 0) {
            g_YYLastSchedulerCallbackMs = _nowMs;
            g_YYAccumulatorMs = _frameMs;
            return true;
        }

        var _rafDeltaMs = _nowMs - g_YYLastSchedulerCallbackMs;
        g_YYLastSchedulerCallbackMs = _nowMs;
        if (_rafDeltaMs <= 0 || _rafDeltaMs >= 1000) {
            g_YYAccumulatorMs = _frameMs;
            return true;
        }

        // When browser refresh is already essentially the target cadence
        // (59.94/60/60.6 Hz for a 60 Hz game), render every RAF. This avoids the
        // classic accumulator beat where 16.5 ms is repeatedly just below a
        // 16.667 ms target and produces a visible 33 ms skip every few seconds.
        var _ratio = _rafDeltaMs / _frameMs;
        if (Math.abs(_ratio - 1.0) <= YY_MATCHED_REFRESH_TOLERANCE) {
            g_YYAccumulatorMs = 0;
            g_YYStats.matchedRefreshCallbacks++;
            return true;
        }

        g_YYAccumulatorMs += _rafDeltaMs;
        if (g_YYAccumulatorMs + YY_EARLY_TOLERANCE_MS < _frameMs) {
            g_YYStats.skippedRafCallbacks++;
            return false;
        }

        // One simulation step per presented frame. We deliberately do not catch
        // up multiple full Draws inside one RAF; a late browser frame stays late
        // instead of creating a spiral of work that causes further jank.
        g_YYAccumulatorMs = Math.max(0, g_YYAccumulatorMs - _frameMs);
        if (g_YYAccumulatorMs > _frameMs * 2) g_YYAccumulatorMs = _frameMs;
        return true;
    }

    function yyRunOriginalTickWithoutLegacyScheduling(_targetSpeed) {
        // Force the original scheduler into its immediate RAF branch, then
        // temporarily replace yyRequestAnimationFrame with a no-op. This keeps
        // the entire original GameMaker tick implementation intact while
        // suppressing only its request for the next frame. No global setTimeout
        // interception is needed, so game/extension timers remain unaffected.
        var _originalRaf = window.yyRequestAnimationFrame;
        var _frameMs = 1000 / Math.max(1, _targetSpeed);
        g_FrameStartTime = Date.now() - _frameMs;
        window.yyRequestAnimationFrame = function() { return 0; };
        try {
            return g_YYOriginalGameMakerTick();
        } finally {
            window.yyRequestAnimationFrame = _originalRaf;
        }
    }

    window.yyFrameSchedulerGetStats = yyGetStats;
    window.yyFrameSchedulerGetStatsJSON = function() { return JSON.stringify(yyGetStats()); };
    window.yyFrameSchedulerResetStats = yyResetStats;
    window.yyFrameSchedulerSetEnabled = yySetEnabled;

    window.GameMaker_Tick = function GameMaker_Tick() {
        yyEnsureProbeStarted();

        var _targetSpeed = g_GameTimer.GetFPS();
        var _smoothActive = (
            YY_SMOOTH_FRAME_SCHEDULER &&
            !!window.yyRequestAnimationFrame &&
            _targetSpeed <= YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS
        );
        g_YYStats.smoothActive = _smoothActive;

        if (!_smoothActive) {
            return g_YYOriginalGameMakerTick();
        }

        // Use the browser-provided RAF timestamp whenever this callback belongs
        // to the scheduler-owned chain. performance.now() includes time already
        // spent executing other RAF callbacks and can therefore create fake
        // cadence jitter even when the browser's vsync timestamps are perfect.
        var _nowMs = g_YYCurrentSchedulerRafTimestampMs > 0
            ? g_YYCurrentSchedulerRafTimestampMs
            : ((
                window.performance &&
                typeof window.performance.now === "function"
            ) ? window.performance.now() : Date.now());

        // The transition from startup state 2 -> 3 happens inside animate(). At
        // the top of that same animate call the runtime has already queued one
        // RAF because it was not in state 3 yet. Do not queue a second chain on
        // this first smooth tick; ownership transfers on the already-pending RAF.
        if (g_YYFirstSmoothTick) {
            g_YYFirstSmoothTick = false;
        } else {
            yyScheduleNextAnimate();
        }

        if (!yyShouldRunSmoothTick(_nowMs, _targetSpeed)) return;

        yyRecordTick(_nowMs, _targetSpeed);
        return yyRunOriginalTickWithoutLegacyScheduling(_targetSpeed);
    };
})();