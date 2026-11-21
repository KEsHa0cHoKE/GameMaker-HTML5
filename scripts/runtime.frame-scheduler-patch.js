// Single-RAF scheduling and frame pacing diagnostics.
// Loaded synchronously after runtime.bundle.js by runner.js.
(function() {
    if (window.yyFrameSchedulerPatchApplied) return;
    window.yyFrameSchedulerPatchApplied = true;

    var YY_SMOOTH_FRAME_SCHEDULER = true;
    var YY_MATCHED_60HZ_TOLERANCE = 0.0125;
    var YY_EARLY_TOLERANCE_MS = 1.0;

    var g_YYLastSchedulerCallbackMs = null;
    var g_YYAccumulatorMs = 0;
    var g_YYLastTargetFps = 0;
    var g_YYMatchingRefreshCount = 0;

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

    function yyResetCadence() {
        g_YYLastSchedulerCallbackMs = null;
        g_YYAccumulatorMs = 0;
        g_YYLastTargetFps = 0;
        g_YYMatchingRefreshCount = 0;
    }

    function yySetEnabled(_enabled) {
        YY_SMOOTH_FRAME_SCHEDULER = !!_enabled;
        g_YYStats.smoothEnabled = YY_SMOOTH_FRAME_SCHEDULER;
        yyResetCadence();
        return YY_SMOOTH_FRAME_SCHEDULER;
    }

    function yyRecordBrowserRaf(_timestamp) {
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
    }

    function yyEnsureLongTaskObserver() {
        g_YYProbeStarted = true;
        try {
            if (typeof PerformanceObserver !== "undefined" &&
                PerformanceObserver.supportedEntryTypes &&
                PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0) {
                new PerformanceObserver(function(_list) {
                    var _entries = _list.getEntries();
                    for (var _i = 0; _i < _entries.length; ++_i) {
                        var _duration = _entries[_i].duration || 0;
                        g_YYStats.longTaskCount++;
                        g_YYStats.longTaskSumMs += _duration;
                        g_YYStats.longTaskWorstMs = Math.max(g_YYStats.longTaskWorstMs, _duration);
                    }
                }).observe({ entryTypes: ["longtask"] });
                g_YYStats.longTaskSupported = true;
            }
        } catch (_err) {
            g_YYStats.longTaskSupported = false;
        }
    }

    function yyRecordTick(_nowMs) {
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

    function yyShouldRunSmoothTick(_nowMs, _targetSpeed, _frameMs) {
        var _lastCallbackMs = g_YYLastSchedulerCallbackMs;
        g_YYLastSchedulerCallbackMs = _nowMs;
        var _rafDeltaMs = _nowMs - _lastCallbackMs;
        if (_lastCallbackMs === null || g_YYLastTargetFps !== _targetSpeed ||
            _rafDeltaMs >= 1000 || _rafDeltaMs < 0) {
            g_YYLastTargetFps = _targetSpeed;
            g_YYAccumulatorMs = 0;
            g_YYMatchingRefreshCount = 0;
            return true;
        }

        // A stable near-60 Hz display should present every callback at the 60 FPS
        // setting. Two consecutive near-matches avoid treating an isolated
        // dropped callback on a 120 Hz display as a refresh-rate change.
        if (_targetSpeed === 60 && Math.abs(_rafDeltaMs / _frameMs - 1) <= YY_MATCHED_60HZ_TOLERANCE) {
            if (++g_YYMatchingRefreshCount >= 2) {
                g_YYMatchingRefreshCount = 2;
                g_YYAccumulatorMs = 0;
                g_YYStats.matchedRefreshCallbacks++;
                return true;
            }
        } else {
            g_YYMatchingRefreshCount = 0;
        }

        g_YYAccumulatorMs += _rafDeltaMs;
        if (g_YYAccumulatorMs + YY_EARLY_TOLERANCE_MS < _frameMs) return false;

        // One tick per callback. Keep the fractional phase and discard whole
        // missed ticks to avoid a burst of extra steps after a stalled frame.
        g_YYAccumulatorMs -= _frameMs;
        if (g_YYAccumulatorMs >= _frameMs) g_YYAccumulatorMs %= _frameMs;
        return true;
    }

    window.yyFrameSchedulerGetStats = yyGetStats;
    window.yyFrameSchedulerGetStatsJSON = function() { return JSON.stringify(yyGetStats()); };
    window.yyFrameSchedulerResetStats = yyResetStats;
    window.yyFrameSchedulerSetEnabled = yySetEnabled;
    document.addEventListener("visibilitychange", function() {
        yyResetCadence();
        g_YYLastBrowserRafMs = 0;
        g_YYLastTickMs = 0;
    });

    // animate() calls this hook after startup. Return false to leave scheduling
    // to GameMaker_Tick on the legacy path.
    window.yyFrameSchedulerStep = function(_timestamp, _startupFrameScheduled) {
        if (!g_YYProbeStarted) yyEnsureLongTaskObserver();

        var _targetSpeed = g_GameTimer.GetFPS();
        var _unfixed = g_GameTimer.m_fps === 0;
        var _smoothActive = YY_SMOOTH_FRAME_SCHEDULER && !!window.yyRequestAnimationFrame &&
            (_unfixed || (isFinite(_targetSpeed) && _targetSpeed > 0));
        var _hasRafTimestamp = typeof _timestamp === "number";
        var _nowMs = _hasRafTimestamp ? _timestamp :
            (window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now());
        var _frameMs = _unfixed ? 0 : 1000 / _targetSpeed;

        g_YYStats.smoothActive = _smoothActive;
        g_YYStats.targetFps = _targetSpeed;
        g_YYStats.targetIntervalMs = _frameMs;
        if (_hasRafTimestamp) yyRecordBrowserRaf(_timestamp);

        if (_smoothActive) {
            if (!_startupFrameScheduled) window.yyRequestAnimationFrame(animate);
            g_YYStats.schedulerRafCallbacks++;

            if (_unfixed) {
                yyResetCadence();
            } else if (!yyShouldRunSmoothTick(_nowMs, _targetSpeed, _frameMs)) {
                g_YYStats.skippedRafCallbacks++;
                return true;
            }
        } else {
            yyResetCadence();
        }

        yyRecordTick(_nowMs);
        if (_smoothActive) GameMaker_Tick(true);
        return _smoothActive;
    };
})();
