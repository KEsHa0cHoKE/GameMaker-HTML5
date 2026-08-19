// Experimental frame scheduler for the bundled GameMaker HTML5 runtime.
// Loaded synchronously after runtime.bundle.js by runner.js.
//
// The legacy runtime waits with setTimeout() and only then requests RAF. When
// that timeout wakes just after a vsync, presentation can slip by one whole
// refresh interval. Smooth mode keeps requestAnimationFrame as the clock and
// skips RAF callbacks until the fixed GameMaker tick deadline is due.
(function() {
    if (window.yyFrameSchedulerPatchApplied) return;
    window.yyFrameSchedulerPatchApplied = true;

    // A/B switch. Keep the legacy path available without replacing the bundle.
    var YY_SMOOTH_FRAME_SCHEDULER = true;

    // The first experiment targets the problematic 60 FPS web path. Running a
    // 120 Hz simulation from a 60 Hz RAF source would halve game simulation
    // speed, so higher target rates intentionally keep the legacy scheduler.
    var YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS = 70;

    var g_YYFrameSchedulerNextTickMs = 0;
    var g_YYFrameSchedulerTargetFps = 0;
    var g_YYFrameSchedulerLastTickMs = 0;

    var g_YYFrameSchedulerProbeStarted = false;
    var g_YYFrameSchedulerLastBrowserRafMs = 0;
    var g_YYFrameSchedulerHistogramBinMs = 0.5;
    var g_YYFrameSchedulerHistogramBins = 402;

    var g_YYFrameSchedulerStats = {
        smoothEnabled: YY_SMOOTH_FRAME_SCHEDULER,
        smoothActive: false,
        targetFps: 0,
        targetIntervalMs: 0,

        browserRafCallbacks: 0,
        browserRafSamples: 0,
        browserRafSumMs: 0,
        browserRafWorstMs: 0,
        browserRafHistogram: new Array(g_YYFrameSchedulerHistogramBins).fill(0),

        tickCount: 0,
        tickSamples: 0,
        tickSumMs: 0,
        tickWorstMs: 0,
        tickHistogram: new Array(g_YYFrameSchedulerHistogramBins).fill(0),
        skippedRafCallbacks: 0,

        longTaskSupported: false,
        longTaskCount: 0,
        longTaskSumMs: 0,
        longTaskWorstMs: 0
    };

    function yyFrameScheduler_RecordHistogram(_histogram, _valueMs) {
        var _bin = Math.max(0, Math.min(
            g_YYFrameSchedulerHistogramBins - 1,
            Math.floor(_valueMs / g_YYFrameSchedulerHistogramBinMs)
        ));
        _histogram[_bin]++;
    }

    function yyFrameScheduler_Percentile(_histogram, _count, _fraction) {
        if (_count <= 0) return 0;

        var _target = Math.ceil(_count * _fraction);
        var _accumulated = 0;
        for (var _i = 0; _i < _histogram.length; ++_i) {
            _accumulated += _histogram[_i];
            if (_accumulated >= _target) {
                return _i * g_YYFrameSchedulerHistogramBinMs;
            }
        }
        return (_histogram.length - 1) * g_YYFrameSchedulerHistogramBinMs;
    }

    function yyFrameScheduler_ResetStats() {
        var _stats = g_YYFrameSchedulerStats;
        _stats.smoothEnabled = YY_SMOOTH_FRAME_SCHEDULER;
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
        _stats.skippedRafCallbacks = 0;

        _stats.longTaskCount = 0;
        _stats.longTaskSumMs = 0;
        _stats.longTaskWorstMs = 0;

        g_YYFrameSchedulerLastBrowserRafMs = 0;
        g_YYFrameSchedulerLastTickMs = 0;
    }

    function yyFrameScheduler_GetStats() {
        var _stats = g_YYFrameSchedulerStats;
        var _browserP50 = yyFrameScheduler_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.50
        );
        var _browserP95 = yyFrameScheduler_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.95
        );
        var _browserP99 = yyFrameScheduler_Percentile(
            _stats.browserRafHistogram,
            _stats.browserRafSamples,
            0.99
        );
        var _tickP95 = yyFrameScheduler_Percentile(
            _stats.tickHistogram,
            _stats.tickSamples,
            0.95
        );
        var _tickP99 = yyFrameScheduler_Percentile(
            _stats.tickHistogram,
            _stats.tickSamples,
            0.99
        );

        return {
            smoothEnabled: YY_SMOOTH_FRAME_SCHEDULER,
            smoothActive: _stats.smoothActive,
            maxSmoothTargetFps: YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS,
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
                skippedRafCallbacks: _stats.skippedRafCallbacks
            },
            longTasks: {
                supported: _stats.longTaskSupported,
                count: _stats.longTaskCount,
                totalMs: _stats.longTaskSumMs,
                worstMs: _stats.longTaskWorstMs
            }
        };
    }

    function yyFrameScheduler_SetEnabled(_enabled) {
        YY_SMOOTH_FRAME_SCHEDULER = !!_enabled;
        g_YYFrameSchedulerNextTickMs = 0;
        g_YYFrameSchedulerTargetFps = 0;
        g_YYFrameSchedulerStats.smoothEnabled = YY_SMOOTH_FRAME_SCHEDULER;
        return YY_SMOOTH_FRAME_SCHEDULER;
    }

    function yyFrameScheduler_BrowserRafProbe(_timestamp) {
        var _stats = g_YYFrameSchedulerStats;
        _stats.browserRafCallbacks++;

        if (g_YYFrameSchedulerLastBrowserRafMs > 0) {
            var _deltaMs = _timestamp - g_YYFrameSchedulerLastBrowserRafMs;
            if (_deltaMs > 0 && _deltaMs < 1000) {
                _stats.browserRafSamples++;
                _stats.browserRafSumMs += _deltaMs;
                _stats.browserRafWorstMs = Math.max(
                    _stats.browserRafWorstMs,
                    _deltaMs
                );
                yyFrameScheduler_RecordHistogram(
                    _stats.browserRafHistogram,
                    _deltaMs
                );
            }
        }

        g_YYFrameSchedulerLastBrowserRafMs = _timestamp;
        if (window.yyRequestAnimationFrame) {
            window.yyRequestAnimationFrame(yyFrameScheduler_BrowserRafProbe);
        }
    }

    function yyFrameScheduler_EnsureProbeStarted() {
        if (g_YYFrameSchedulerProbeStarted || !window.yyRequestAnimationFrame) {
            return;
        }

        g_YYFrameSchedulerProbeStarted = true;
        window.yyRequestAnimationFrame(yyFrameScheduler_BrowserRafProbe);

        try {
            if (
                typeof PerformanceObserver !== "undefined" &&
                PerformanceObserver.supportedEntryTypes &&
                PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0
            ) {
                g_YYFrameSchedulerStats.longTaskSupported = true;
                new PerformanceObserver(function(_list) {
                    var _entries = _list.getEntries();
                    for (var _i = 0; _i < _entries.length; ++_i) {
                        var _duration = _entries[_i].duration || 0;
                        g_YYFrameSchedulerStats.longTaskCount++;
                        g_YYFrameSchedulerStats.longTaskSumMs += _duration;
                        g_YYFrameSchedulerStats.longTaskWorstMs = Math.max(
                            g_YYFrameSchedulerStats.longTaskWorstMs,
                            _duration
                        );
                    }
                }).observe({ entryTypes: ["longtask"] });
            }
        } catch (_err) {
            g_YYFrameSchedulerStats.longTaskSupported = false;
        }
    }

    function yyFrameScheduler_RecordTick(_nowMs, _targetSpeed) {
        var _stats = g_YYFrameSchedulerStats;
        var _frameMs = 1000 / Math.max(1, _targetSpeed);

        _stats.targetFps = _targetSpeed;
        _stats.targetIntervalMs = _frameMs;

        if (g_YYFrameSchedulerLastTickMs > 0) {
            var _tickDeltaMs = _nowMs - g_YYFrameSchedulerLastTickMs;
            if (_tickDeltaMs > 0 && _tickDeltaMs < 1000) {
                _stats.tickSamples++;
                _stats.tickSumMs += _tickDeltaMs;
                _stats.tickWorstMs = Math.max(
                    _stats.tickWorstMs,
                    _tickDeltaMs
                );
                yyFrameScheduler_RecordHistogram(
                    _stats.tickHistogram,
                    _tickDeltaMs
                );
            }
        }

        g_YYFrameSchedulerLastTickMs = _nowMs;
        _stats.tickCount++;
    }

    function yyFrameScheduler_ShouldRunSmoothTick(_nowMs, _targetSpeed) {
        var _frameMs = 1000 / Math.max(1, _targetSpeed);

        if (
            g_YYFrameSchedulerNextTickMs <= 0 ||
            g_YYFrameSchedulerTargetFps !== _targetSpeed
        ) {
            g_YYFrameSchedulerTargetFps = _targetSpeed;
            g_YYFrameSchedulerNextTickMs = _nowMs;
        }

        // Small early margin avoids skipping an otherwise on-time vsync because
        // of timestamp rounding/noise.
        var _earlyMarginMs = Math.min(1.0, _frameMs * 0.10);
        if (_nowMs + _earlyMarginMs < g_YYFrameSchedulerNextTickMs) {
            g_YYFrameSchedulerStats.skippedRafCallbacks++;
            return false;
        }

        // Advance from the ideal cadence rather than from callback time. Late
        // browser frames do not permanently shift future deadlines.
        var _advanceGuard = 0;
        do {
            g_YYFrameSchedulerNextTickMs += _frameMs;
            _advanceGuard++;
        } while (
            g_YYFrameSchedulerNextTickMs <= _nowMs + _earlyMarginMs &&
            _advanceGuard < 16
        );

        if (_advanceGuard >= 16) {
            g_YYFrameSchedulerNextTickMs = _nowMs + _frameMs;
        }

        return true;
    }

    window.yyFrameSchedulerGetStats = yyFrameScheduler_GetStats;
    window.yyFrameSchedulerGetStatsJSON = function() {
        return JSON.stringify(yyFrameScheduler_GetStats());
    };
    window.yyFrameSchedulerResetStats = yyFrameScheduler_ResetStats;
    window.yyFrameSchedulerSetEnabled = yyFrameScheduler_SetEnabled;

    // GameMaker's animate() resolves GameMaker_Tick through the browser global.
    // Replacing this property therefore swaps only scheduling while preserving
    // the rest of the generated runtime bundle unchanged.
    window.GameMaker_Tick = function GameMaker_Tick() {
        var TargetSpeed = g_GameTimer.GetFPS();
        yyFrameScheduler_EnsureProbeStarted();

        var _schedulerNowMs = (
            window.performance &&
            typeof window.performance.now === "function"
        ) ? window.performance.now() : Date.now();

        var _smoothActive = (
            YY_SMOOTH_FRAME_SCHEDULER &&
            !!window.yyRequestAnimationFrame &&
            TargetSpeed <= YY_SMOOTH_FRAME_SCHEDULER_MAX_TARGET_FPS
        );
        g_YYFrameSchedulerStats.smoothActive = _smoothActive;

        if (_smoothActive) {
            // Schedule first so a runtime exception does not silently kill the
            // browser clock. Early callbacks return without stepping the game.
            window.yyRequestAnimationFrame(animate);
            if (!yyFrameScheduler_ShouldRunSmoothTick(
                _schedulerNowMs,
                TargetSpeed
            )) {
                return;
            }
        }

        yyFrameScheduler_RecordTick(_schedulerNowMs, TargetSpeed);

        if (g_webGL) {
            g_webGL.Flush();
        }

        g_GameTimer.Update();
        TargetSpeed = g_GameTimer.GetFPS();

        const last_time_ms = g_CurrentTime;
        g_CurrentTime = Date.now();

        const delta_time_us = (g_CurrentTime - last_time_ms) * 1000;
        g_GlobalTimeSource.Tick(delta_time_us);
        g_SDTimeSourceParent.Tick(delta_time_us);

        if (g_CurrentTime >= lastfpstime + 1000) {
            if (g_CurrentTime - g_FrameStartTime < 2000) {
                Fps = newfps;
                g_pBuiltIn.fps = Fps;
            }
            newfps = 0;
            lastfpstime = g_CurrentTime;
        }
        newfps++;

        if (_smoothActive) {
            // Preserve the old focus-gap bookkeeping without using the old
            // setTimeout -> RAF scheduling chain.
            g_FrameStartTime = g_CurrentTime;
        } else {
            // Original GameMaker HTML5 scheduler, retained verbatim for A/B and
            // for target rates above the safe RAF-driven experiment range.
            var nextFrameAt = g_FrameStartTime + 1000 / TargetSpeed;
            var now = Date.now();
            var delay = g_FrameStartTime + 1000 / TargetSpeed - now;
            if (delay < 0) delay = 0;
            g_FrameStartTime = now + delay;
            if (delay > 4) {
                setTimeout(function() {
                    if (window.yyRequestAnimationFrame) {
                        window.yyRequestAnimationFrame(animate);
                    }
                }, delay);
            } else {
                if (window.yyRequestAnimationFrame) {
                    window.yyRequestAnimationFrame(animate);
                } else {
                    window.postMessage("yyRequestAnimationFrame", "*");
                }
            }
        }

        if (!Run_Paused) {
            ProcessMisc();

            var ErrorCount = 10;
            var done = false;
            while (!done) {
                done = true;

                if (g_RunRoom === null) {
                    g_DefaultView.scaledportx2 = g_DefaultView.scaledportw =
                        g_DefaultView.portw = g_DefaultView.worldw = DISPLAY_WIDTH;
                    g_DefaultView.scaledporty2 = g_DefaultView.scaledporth =
                        g_DefaultView.porth = g_DefaultView.worldh = DISPLAY_HEIGHT;
                } else {
                    SetCanvasSize();
                }

                Graphics_StartFrame();
                GameMaker_DoAStep();
                Graphics_EndFrame();

                switch (New_Room) {
                    case -1:
                        break;

                    case ROOM_ENDOFGAME:
                    case ROOM_ABORTGAME:
                        Run_EndGame(false);
                        return;

                    case ROOM_RESTARTGAME:
                        Run_EndGame(true);
                        g_pRoomManager.ResetAll();
                        StartGame();
                        break;

                    case ROOM_LOADGAME:
                        LoadGame();
                        break;

                    default:
                        SwitchRoom(New_Room);
                        done = false;
                        break;
                }

                ErrorCount--;
                if (ErrorCount <= 0) break;
            }

            g_MouseDeltaX = 0;
            g_MouseDeltaY = 0;
        }

        if (g_pGMFile.Options && g_pGMFile.Options.debugMode) {
            UpdateDebugWindow();
        }
    };
})();
