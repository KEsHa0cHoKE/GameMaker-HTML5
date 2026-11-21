/* global GameMaker_Tick */
"use strict";

const benchmarkOptions = new URLSearchParams(location.search);
const frameCount = Number(benchmarkOptions.get("frames") || 120);
const warmupCount = Number(benchmarkOptions.get("warmup") || 90);
const scenarios = (benchmarkOptions.get("scenarios") || "menu,songs,tiles,burst,expiry,combined,rooms,resources").split(",");

function framebufferSignature(gl) {
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 2166136261;
    let nonuniformPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ pixels[i + channel], 16777619);
        if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) nonuniformPixels++;
    }
    return { hash: (hash >>> 0).toString(16), nonuniformPixels };
}

function stats(samples) {
    const ordered = samples.slice().sort((a, b) => a - b);
    const at = p => ordered[Math.ceil(ordered.length * p) - 1];
    const mean = ordered.reduce((sum, n) => sum + n, 0) / ordered.length;
    return { mean, p50: at(.5), p95: at(.95), p99: at(.99), max: ordered.at(-1) };
}

async function startBenchmark() {
    // Compiled games call the public RNG entry point during initialization.
    random_set_seed(12345);
    if (random(1) !== 1715860630 / 0x7fffffff ||
        random(2) !== 2 * (540338984 / 0x7fffffff)) {
        throw new Error("Unexpected random() output during startup");
    }
    canvas = document.querySelector("#canvas");
    DISPLAY_WIDTH = canvas.width;
    DISPLAY_HEIGHT = canvas.height;
    canvasMinX = canvasMinY = 0;
    canvasMaxX = DISPLAY_WIDTH;
    canvasMaxY = DISPLAY_HEIGHT;
    g_GlobalAlpha = 1;
    g_isZeus = true;
    g_pGMFile = { Options: {} };
    g_RootDir = "";
    set_load_location = default_set_load_location;
    g_Matrix = [new Matrix(), new Matrix(), new Matrix()];
    g_pBuiltIn = new yyBuiltIn();
    g_DefaultView = new yyView();
    g_ParticleTypes = [];
    g_ParticleTextures = [];
    g_ParticleSystemManager = new yyParticleSystemManager();
    g_pLayerManager = new LayerManager();
    g_pSpriteManager = new yySpriteManager();
    g_Surfaces = new yyAllocate(5);
    g_RunRoom = new yyRoom();

    const getContext = canvas.getContext;
    let gl;
    canvas.getContext = function (kind, options) {
        const context = getContext.call(this, kind, options);
        if (kind.includes("webgl") && context) gl = context;
        return context;
    };
    if (!InitWebGL(canvas)) throw new Error("WebGL is unavailable");
    graphics = g_webGL;
    Graphics_Init(canvas);
    Graphics_SetViewPort(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT);
    Graphics_SetViewArea(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT, 0);
    for (let i = 1; i <= 6; i++) {
        const index = LoadParticleImage("../scripts/particles/IDR_GIF" + i + ".png");
        await g_ParticleTextures[index].texture.decode();
    }
    const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    let drawCalls = 0;
    let uploads = 0;
    let uploadBytes = 0;
    const drawArrays = gl.drawArrays;
    const drawElements = gl.drawElements;
    const bufferSubData = gl.bufferSubData;
    gl.drawArrays = function (...args) { drawCalls++; return drawArrays.apply(this, args); };
    gl.drawElements = function (...args) { drawCalls++; return drawElements.apply(this, args); };
    gl.bufferSubData = function (...args) {
        uploads++;
        uploadBytes += (args[4] || args[2].length) * args[2].BYTES_PER_ELEMENT;
        return bufferSubData.apply(this, args);
    };

    // Drive the actual animate → scheduler → GameMaker_Tick → graphics path.
    // Only the game-specific Step/Draw work and unused instance services are synthetic.
    ProcessMisc = function () {};
    SetCanvasSize = function () {};
    g_StartUpState = 2;
    g_LoadingCompleteCallback = function () {};
    StartGame = function () {};
    g_GameTimer.SetFrameRate(60);
    New_Room = -1;
    g_FrameStartTime = Date.now();

    let audio;
    let audioBursts = 0;
    if (scenarios.includes("combined") && typeof AudioContext !== "undefined") {
        audio = new AudioContext();
        await audio.resume();
    }
    function playTone() {
        if (!audio || audio.state !== "running") return;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const now = audio.currentTime;
        oscillator.frequency.value = 330;
        gain.gain.setValueAtTime(.025, now);
        gain.gain.exponentialRampToValueAtTime(.001, now + .06);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(now);
        oscillator.stop(now + .06);
        audioBursts++;
    }

    const rooms = [g_RunRoom, new yyRoom()];
    let roomIndex = 0;
    let type, system, volatileSystem, emitter, scene;
    let frame = 0;
    let markStart = 0;
    let audioStart = 0;
    let lastTick;
    let work = [];
    let intervals = [];
    let calls = [];
    let bytes = [];
    let buffers = [];
    const results = [];
    let sceneIndex = -1;
    let sizeSeed = 0;
    Math.random = () => ((sizeSeed = (Math.imul(sizeSeed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

    function selectScene() {
        ParticleSystem_DestroyAll();
        ParticleType_DestroyAll();
        if (++sceneIndex === scenarios.length) return false;
        scene = scenarios[sceneIndex];
        frame = -warmupCount;
        lastTick = undefined;
        work = [];
        intervals = [];
        calls = [];
        bytes = [];
        buffers = [];
        sizeSeed = 123456;
        random_set_seed(62354, true);
        system = part_system_create();
        type = part_type_create();
        part_type_shape(type, PT_SHAPE_STAR);
        part_type_speed(type, 1, 5, -.004, .1);
        part_type_direction(type, 0, 360, 0, .15);
        part_type_orientation(type, 0, 360, 0, 0, false);
        part_type_size(type, .3, .8, -.003, .1);
        part_type_color2(type, 0xffffff, 0x6078ff);
        part_type_alpha3(type, .8, .6, 0);
        part_type_life(type, 24, 72);
        emitter = part_emitter_create(system);
        part_emitter_region(system, emitter, 175, 305, 245, 395, PART_ESHAPE_ELLIPSE, PART_EDISTR_LINEAR);
        if (scene === "rooms") volatileSystem = ParticleSystem_Create(-1, false);
        return true;
    }

    function rectangle(x, y, width, height, color) {
        draw_rectangle_color(x, y, x + width, y + height, color, color, color, color, false);
    }

    function drawScene() {
        const step = frame + warmupCount;
        Graphics_ClearScreen(0x20142a);
        if (scene !== "burst" && scene !== "expiry") {
            for (let row = 0; row < 20; row++) {
                const shade = Math.floor(30 + 18 * Math.sin(step * .04 + row * .12));
                rectangle(0, row * 32, 480, 32, (shade * 3 << 16) | (shade * 2 << 8) | shade);
            }
        }
        if (scene === "menu" || scene === "songs") {
            draw_set_alpha(.83);
            for (let row = 0; row < (scene === "songs" ? 13 : 7); row++) {
                const offset = (step * 2) % 48;
                rectangle(25, 5 + row * 48 - offset, 420, 40, 0x795766);
                for (let i = 0; i < 25; i++) rectangle(37 + i * 7, row * 48 - offset + 17, 4, 7, 0xe1d4ff);
            }
            draw_set_alpha(1);
        }
        if (scene === "tiles" || scene === "combined" || scene === "rooms") {
            for (let i = 0; i < 36; i++) {
                rectangle(i % 4 * 120 + 5, (i * 63 + step * 7) % 640, 110, 44, 0x9d3a6e + i * 313);
            }
        }

        if (scene === "burst") {
            part_particles_clear(system);
            part_emitter_burst(system, emitter, type, 1000);
        }
        if (scene === "expiry") {
            part_type_life(type, 1, 1);
            part_particles_create(system, 240, 320, type, 6000);
        }
        if (scene === "combined") {
            part_emitter_burst(system, emitter, type, step % 45 === 0 ? 240 : 12);
            if (step % 24 === 0) playTone();
        }
        if (scene === "rooms" && step % 30 === 0) {
            ParticleSystem_RemoveAllFromLayers();
            if (ParticleSystem_Exists(volatileSystem)) throw new Error("Volatile system leaked");
            roomIndex = 1 - roomIndex;
            g_RunRoom = rooms[roomIndex];
            ParticleSystem_AddAllToLayers();
            if (!part_system_exists(system)) throw new Error("Persistent system was destroyed");
            volatileSystem = ParticleSystem_Create(-1, false);
            part_emitter_burst(system, emitter, type, 200);
        }
        if (scene === "resources") {
            const target = surface_create(128, 128);
            if (!surface_exists(target)) throw new Error("Could not allocate surface");
            surface_free(target);
            if (surface_exists(target)) throw new Error("Surface leaked");
        }
        ParticleSystem_UpdateAll();
        if (scene === "expiry") {
            if (part_particles_count(system) !== 0) throw new Error("Expired particles survived");
        } else if (scene === "burst" || scene === "combined" || scene === "rooms") {
            ParticleSystem_Draw(GetParticleSystemInstanceIndex(system));
        }
    }

    const done = new Promise((resolve, reject) => {
        GameMaker_DoAStep = drawScene;
        const tick = GameMaker_Tick;
        GameMaker_Tick = function (nextFrameScheduled) {
            try {
                if (!scene) return;
                const start = performance.now();
                if (frame === 0) {
                    performance.mark("start:" + scene);
                    markStart = start;
                    audioStart = audioBursts;
                }
                drawCalls = uploads = uploadBytes = 0;
                tick(nextFrameScheduled);
                const end = performance.now();
                if (frame > 0) intervals.push(start - lastTick);
                if (frame >= 0) {
                    work.push(end - start);
                    calls.push(drawCalls);
                    buffers.push(uploads);
                    bytes.push(uploadBytes);
                    lastTick = start;
                }
                if (++frame < frameCount) return;

                performance.mark("end:" + scene);
                const total = stats(intervals);
                const slow = intervals.slice().sort((a, b) => b - a).slice(0, Math.ceil(intervals.length * .01));
                results.push({
                    scene, frames: frameCount, wallMs: end - markStart,
                    fps: 1000 / total.mean, low1: 1000 / stats(slow).mean, interval: total,
                    work: stats(work), drawCalls: stats(calls).mean, uploads: stats(buffers).mean,
                    uploadBytes: stats(bytes).mean, heapBytes: performance.memory?.usedJSHeapSize,
                    audioBursts: audioBursts - audioStart,
                    particleCount: part_particles_count(system),
                    framebuffer: framebufferSignature(gl),
                    glError: gl.getError()
                });
                if (!selectScene()) {
                    scene = null;
                    audio?.close();
                    resolve({ renderer, userAgent: navigator.userAgent, canvas: [canvas.width, canvas.height], results });
                }
            } catch (error) { scene = null; reject(error); }
        };
        selectScene();
        requestAnimationFrame(animate);
    });
    return done;
}

window.runRuntimeBenchmark = () => startBenchmark().then(
    result => {
        document.querySelector("#results").textContent = JSON.stringify(result, null, 2);
        return result;
    },
    error => {
        document.querySelector("#results").textContent = error.stack;
        throw error;
    }
);
if (!benchmarkOptions.has("manual")) window.runRuntimeBenchmark();
