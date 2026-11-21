"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = process.env.TEST_RUNTIME_ROOT || path.join(__dirname, "..");
const scripts = ["functions/Function_Game.js", "_GameMaker.js", "runtime.frame-scheduler-patch.js"]
    .map(name => fs.readFileSync(path.join(root, "scripts", name), "utf8"));

function scheduler(hz, initialSpeed = 60, useSmooth = true) {
    let time = 100;
    let ticks = [];
    let raf = [];
    let timers = [];
    let totalTimers = 0;
    let lastGameDelta;
    const listeners = {};
    class BrowserDate extends Date {
        constructor() { super(BrowserDate.now()); }
        static now() { return 1_700_000_000_000 + Math.floor(time); }
    }
    const noop = () => {};
    const context = vm.createContext({
        Date: BrowserDate,
        performance: { now: () => time },
        document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
        addEventListener: noop,
        requestAnimationFrame: fn => { raf.push(fn); },
        setTimeout: (fn, delay) => { timers.push({ fn, time: time + delay }); totalTimers++; },
        g_pBuiltIn: {},
        g_pGMFile: { Options: {} },
        g_webGL: null,
        g_RunRoom: {},
        get_timer: () => Math.floor(time * 1000),
        g_GlobalTimeSource: { Tick: delta => { lastGameDelta = delta; } },
        g_SDTimeSourceParent: { Tick: noop },
        Run_Paused: false,
        New_Room: -1,
        ROOM_ENDOFGAME: -2,
        ROOM_ABORTGAME: -3,
        ROOM_RESTARTGAME: -4,
        ROOM_LOADGAME: -5,
        g_LoadingCompleteCallback: noop,
        Graphics_StartFrame: noop,
        Graphics_EndFrame: noop,
        debug: noop,
        show_debug_message: noop,
        ds_list_size: noop,
        ds_list_find_value: noop,
        json_encode: noop,
        json_decode: noop,
        extension_get_option_value: noop,
        yyGetReal: Number,
        yyGetInt32: x => x | 0
    });
    context.window = context;
    for (const script of scripts) vm.runInContext(script, context);
    context.g_StartUpState = 2;
    context.StartGame = noop;
    context.SetCanvasSize = noop;
    context.ProcessMisc = noop;
    context.GameMaker_DoAStep = () => ticks.push(time);
    context.game_set_speed(initialSpeed, 0);
    if (!useSmooth) context.yyFrameSchedulerSetEnabled(false);
    context.requestAnimationFrame(context.animate);

    function advance(callbacks) {
        const start = time;
        for (let i = 1; i <= callbacks; i++) {
            const due = start + i * (1000 / hz);
            const ready = timers.filter(timer => timer.time <= due);
            timers = timers.filter(timer => timer.time > due);
            for (const timer of ready) {
                time = timer.time;
                timer.fn();
            }
            time = due;
            const current = raf;
            raf = [];
            for (const frame of current) frame(time);
            assert.ok(raf.length + timers.length <= 1, "more than one frame scheduled");
        }
        return { ticks: ticks.slice(), totalTimers, lastGameDelta };
    }
    return {
        context, advance,
        resetTicks: () => { ticks = []; },
        hideAndResume: ms => { listeners.visibilitychange(); time += ms; listeners.visibilitychange(); }
    };
}

test("fixed speed stays independent of display refresh with one RAF chain", () => {
    for (const hz of [59.94, 60, 60.6, 90, 120, 144]) {
        for (const speed of [24, 30, 45, 58, 60, 90, 120, 144].filter(fps => fps <= Math.round(hz))) {
            const run = scheduler(hz, speed);
            const { ticks, totalTimers } = run.advance(Math.round(hz * 10));
            const expected = speed === 60 && Math.abs(hz - 60) < 1 ? hz * 10 : speed * 10;
            assert.ok(Math.abs(ticks.length - expected) <= 1, `${hz} Hz, ${speed} FPS: ${ticks.length}`);
            assert.equal(totalTimers, 0);
            assert.equal(new Set(ticks).size, ticks.length);
        }
    }
});

test("startup, speed changes, diagnostic reset and tab resume preserve one RAF chain", () => {
    const run = scheduler(120, 60);
    run.advance(240);
    run.context.yyFrameSchedulerResetStats();
    run.context.game_set_speed(1_000_000 / 30, 1);
    run.resetTicks();
    assert.equal(run.advance(240).ticks.length, 60);
    run.hideAndResume(5000);
    run.resetTicks();
    const resumed = run.advance(120);
    assert.equal(resumed.ticks.length, 30);
    assert.ok(resumed.ticks[1] - resumed.ticks[0] > 30);
    run.context.game_set_speed(0, 0);
    run.resetTicks();
    assert.equal(run.advance(120).ticks.length, 120);
});

test("legacy startup and toggling modes never duplicate or drop the callback chain", () => {
    const run = scheduler(60, 60, false);
    assert.ok(run.advance(180).ticks.length > 0);
    run.context.yyFrameSchedulerSetEnabled(true);
    run.resetTicks();
    assert.equal(run.advance(180).ticks.length, 180);
    run.context.yyFrameSchedulerSetEnabled(false);
    run.resetTicks();
    assert.ok(run.advance(180).ticks.length > 0);
});
