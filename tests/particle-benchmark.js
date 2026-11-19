"use strict";

// Open particle-benchmark.html through an HTTP server rooted at the repository.
// Options: ?scenario=reuse|types|systems|mixed|bulk|rooms|emitter|legacy|rng&cycles=500&webgl=1
const options = new URLSearchParams(location.search);
const scenario = options.get("scenario") || "reuse";
const cycles = Number(options.get("cycles") || 500);
const webgl = options.get("webgl") === "1";
const seed = 12345;
const output = document.querySelector("#output");

const phases = ["CreateParticle", "EmitParticles", "HandleLife", "HandleMotion"];
const timings = Object.fromEntries(phases.map(name => [name, 0]));
for (const name of phases) {
    const original = window[name];
    window[name] = function (...args) {
        const start = performance.now();
        const result = original(...args);
        timings[name] += performance.now() - start;
        return result;
    };
}

function setup() {
    g_isZeus = true;
    g_ParticleTypes = [];
    g_ParticleTextures = [];
    g_ParticleSystemManager = new yyParticleSystemManager();
    g_pLayerManager = new LayerManager();
    g_pSpriteManager = new yySpriteManager();
    g_pBuiltIn = new yyBuiltIn();
    g_RunRoom = new yyRoom();
}

async function setupWebGL() {
    canvas = document.querySelector("#canvas");
    DISPLAY_WIDTH = canvas.width;
    DISPLAY_HEIGHT = canvas.height;
    g_pGMFile = { Options: {} };
    g_RootDir = "";
    set_load_location = default_set_load_location;
    g_Matrix = [new Matrix(), new Matrix(), new Matrix()];
    if (!InitWebGL(canvas)) throw new Error("WebGL is unavailable");
    graphics = g_webGL;
    Graphics_Init(canvas);
    for (let i = 2; i <= 6; i++) {
        const index = LoadParticleImage("../scripts/particles/IDR_GIF" + i + ".png");
        await g_ParticleTextures[index].texture.decode();
    }
}

function createType(index) {
    const type = part_type_create();
    part_type_shape(type, index % 2 ? PT_SHAPE_STAR : PT_SHAPE_PIXEL);
    part_type_speed(type, 1, 5, 0, 0.25);
    part_type_direction(type, 0, 360, 0, 0.25);
    part_type_orientation(type, 0, 360, 0, 0, false);
    part_type_life(type, 25, 40);
    part_type_size(type, 0.25, 0.5, 0, 0);
    return type;
}

function counts() {
    const { particlesRuntime, particlesRoom } = g_ParticleSystemManager;
    const systems = [...particlesRuntime, ...particlesRoom].filter(Boolean);
    const emitters = systems.flatMap(system => system.emitters);
    const slots = emitters.reduce((sum, emitter) => sum + emitter.particles.length, 0);
    return {
        types: g_ParticleTypes.filter(Boolean).length,
        typeSlots: g_ParticleTypes.length,
        systems: systems.length,
        runtimeSystemSlots: particlesRuntime.length,
        roomSystemSlots: particlesRoom.length,
        emitterSlots: emitters.length,
        emitters: emitters.filter(emitter => emitter.created || emitter.zombie).length,
        particleSlots: slots,
        liveParticles: emitters.reduce((sum, emitter) => sum + emitter.particles.filter(Boolean).length, 0),
        stateBits: typeof state[0] === "bigint" ? Math.max(...state.map(word => word.toString(2).length)) : 32,
        heapBytes: performance.memory?.usedJSHeapSize ?? null,
    };
}

function percentile(values, fraction) {
    const ordered = values.slice().sort((a, b) => a - b);
    return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function summarize(rows, columns) {
    return Object.fromEntries(columns.map(name => {
        const values = rows.map(row => row[name]).filter(value => value !== null);
        return [name, values.length ? {
            p50: percentile(values, 0.5), p95: percentile(values, 0.95),
            p99: percentile(values, 0.99), max: Math.max(...values)
        } : null];
    }));
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

async function run() {
    setup();
    if (webgl) await setupWebGL();
    const usesParticles = scenario !== "rng";
    const batch = scenario === "bulk" ? 500 : 50;
    const rooms = scenario === "rooms" ? [g_RunRoom, new yyRoom()] : [];
    let roomIndex = 0;
    let system;
    let emitter;
    let volatileSystem;
    const createVolatile = () => ParticleSystem_Create(-1, false);
    let types;
    if (usesParticles) {
        system = part_system_create();
        types = Array.from({ length: scenario === "mixed" ? 4 : 1 }, (_, i) => createType(i));
    }
    if (rooms.length) volatileSystem = createVolatile();
    if (scenario === "legacy") random_set_seed(seed);
    else random_set_seed(seed, true);

    let lastTimestamp;
    let peakLiveParticles = 0;
    async function frame(iteration, particleCount) {
        const timestamp = await nextFrame();
        for (const name of phases) timings[name] = 0;
        const frameStart = performance.now();
        if (usesParticles && scenario === "systems" && !system) system = part_system_create();
        if (usesParticles && scenario === "types" && !types) types = [createType(iteration)];
        const spawnStart = performance.now();
        if (scenario === "emitter") {
            if (!emitter) {
                emitter = part_emitter_create(system);
                part_emitter_region(system, emitter, 270, 370, 190, 290,
                    PART_ESHAPE_RECTANGLE, PART_EDISTR_LINEAR);
            }
            part_emitter_burst(system, emitter, types[0], particleCount);
        } else if (usesParticles) {
            part_particles_create(system, 320, 240, types[iteration % types.length], particleCount);
        } else {
            for (let i = 0; i < particleCount * 5; i++) YYRandom(1);
        }
        const afterSpawn = performance.now();
        if (usesParticles) ParticleSystem_UpdateAll();
        const afterUpdate = performance.now();
        if (webgl && usesParticles) {
            Graphics_StartFrame();
            Graphics_ClearScreen(0);
            ParticleSystem_Draw(GetParticleSystemInstanceIndex(system));
            Graphics_EndFrame();
        }
        const afterDraw = performance.now();
        if (usesParticles) {
            const live = part_particles_count(system);
            if (live !== particleCount) throw new Error("Unexpected live particle count: " + live);
            peakLiveParticles = Math.max(peakLiveParticles, live);
            part_particles_clear(system);
        }
        if (scenario === "types" && usesParticles) {
            part_type_destroy(types[0]);
            types = null;
        }
        if (scenario === "systems" && usesParticles) {
            part_system_destroy(system);
            system = null;
        }
        if (rooms.length && iteration % 25 === 0) {
            ParticleSystem_RemoveAllFromLayers();
            if (ParticleSystem_Exists(volatileSystem)) throw new Error("Volatile system survived room exit");
            roomIndex = 1 - roomIndex;
            g_RunRoom = rooms[roomIndex];
            ParticleSystem_AddAllToLayers();
            if (!part_system_exists(system)) throw new Error("Persistent system was destroyed");
            volatileSystem = createVolatile();
        }
        const row = {
            iteration, timestamp,
            intervalMs: lastTimestamp === undefined ? null : timestamp - lastTimestamp,
            workMs: performance.now() - frameStart,
            spawnMs: afterSpawn - spawnStart,
            updateMs: afterUpdate - afterSpawn,
            drawMs: afterDraw - afterUpdate,
            ...timings
        };
        lastTimestamp = timestamp;
        return row;
    }

    const rows = [];
    const checkpoints = [];
    await window.measureRetainedHeap?.("start");
    performance.mark("particle-benchmark-start");
    for (let i = 1; i <= cycles; i++) {
        rows.push(await frame(i, batch));
        if (i === 1 || i === 50 || i === 100 || i === 250 || i === cycles) {
            checkpoints.push({ ...rows[rows.length - 1], ...counts() });
        }
    }
    performance.mark("particle-benchmark-end");
    const beforeClear = counts();
    await window.measureRetainedHeap?.("beforeClear");
    ParticleSystem_DestroyAll();
    ParticleType_DestroyAll();
    const afterClear = counts();
    await window.measureRetainedHeap?.("afterClear");
    if (afterClear.types || afterClear.systems || afterClear.particleSlots) throw new Error("Incomplete cleanup");

    if (usesParticles) {
        system = part_system_create();
        emitter = undefined;
        types = [createType(0)];
    }
    const afterRecreation = await frame(cycles + 1, batch);
    const rewardBurst = await frame(cycles + 2, 500);
    if (scenario === "legacy") random_set_seed(seed);
    else random_set_seed(seed, true);
    const afterReseed = await frame(cycles + 3, batch);
    const columns = ["workMs", "intervalMs", "spawnMs", "updateMs", "drawMs", ...phases];
    window.benchmarkResult = {
        scenario, cycles, webgl, batch, seed,
        summary: summarize(rows, columns),
        first50: summarize(rows.slice(0, 50), columns),
        last50: summarize(rows.slice(-50), columns),
        peakLiveParticles, checkpoints, beforeClear, afterClear, afterRecreation, rewardBurst, afterReseed, rows
    };
    output.textContent = JSON.stringify({ ...window.benchmarkResult, rows: undefined }, null, 2);
    return window.benchmarkResult;
}

const runResult = run();
if (typeof benchmarkNode === "undefined") {
    runResult.catch(error => {
        window.benchmarkError = error.stack;
        output.textContent = error.stack;
    });
}
runResult;
