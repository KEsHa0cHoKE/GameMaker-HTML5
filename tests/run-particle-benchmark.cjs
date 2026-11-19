"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance, PerformanceObserver } = require("node:perf_hooks");
const { Session } = require("node:inspector");

const root = path.resolve(process.argv[4] || path.join(__dirname, ".."));
const scenario = process.argv[2] || "reuse";
const cycles = Number(process.argv[3] || 500);
const gcEvents = [];
const observer = new PerformanceObserver(list => {
    for (const { startTime, duration, detail } of list.getEntries()) {
        gcEvents.push({ startTime, duration, kind: detail.kind });
    }
});

const retainedHeap = {};
const context = vm.createContext({
    console,
    benchmarkNode: true,
    navigator: globalThis.navigator,
    URLSearchParams,
    location: { search: `?scenario=${scenario}&cycles=${cycles}` },
    document: { querySelector: () => ({}) },
    requestAnimationFrame: callback => setImmediate(() => callback(performance.now())),
    performance: {
        now: performance.now.bind(performance),
        mark: performance.mark.bind(performance),
        get memory() { return { usedJSHeapSize: process.memoryUsage().heapUsed }; },
    },
    measureRetainedHeap: label => {
        if (global.gc) {
            global.gc();
            retainedHeap[label] = process.memoryUsage().heapUsed;
        }
    },
});

function load(file) {
    const filename = path.join(root, "scripts", file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
}

async function main() {
    vm.runInContext("var window = globalThis; var debug = function () {};", context);
    for (const file of [
        "Vector3.js", "Matrix.js", "Plane.js", "Frustum.js", "Globals.js", "yyVariable.js", "yyBuiltIn.js",
        "yyTypes.js", "yyList.js", "yyOList.js", "yySprite.js", "yyRoom.js",
        "yyParticle.js", "functions/Function_Maths.js", "functions/Function_Particles.js",
        "functions/Function_Layers.js",
    ]) load(file);

    observer.observe({ entryTypes: ["gc"] });
    const profileFile = process.env.PARTICLE_CPU_PROFILE;
    const session = profileFile && new Session();
    const send = (method, params) => new Promise((resolve, reject) => {
        session.post(method, params, (error, result) => error ? reject(error) : resolve(result));
    });
    if (session) {
        session.connect();
        await send("Profiler.enable");
        await send("Profiler.setSamplingInterval", { interval: 200 });
        await send("Profiler.start");
    }
    const filename = path.join(__dirname, "particle-benchmark.js");
    const result = await vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
    if (session) {
        const { profile } = await send("Profiler.stop");
        fs.writeFileSync(profileFile, JSON.stringify(profile));
        session.disconnect();
    }
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    observer.disconnect();
    const start = performance.getEntriesByName("particle-benchmark-start")[0].startTime;
    const stop = performance.getEntriesByName("particle-benchmark-end")[0].startTime;
    const gc = gcEvents.filter(event => event.startTime >= start && event.startTime < stop);
    console.log(JSON.stringify({ ...result, node: process.version, v8: process.versions.v8, retainedHeap, gc }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
