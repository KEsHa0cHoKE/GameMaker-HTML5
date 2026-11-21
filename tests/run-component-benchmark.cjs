"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");

const updated = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const baseline = process.argv[3] && path.resolve(process.argv[3]);
const samples = Number(process.env.COMPONENT_SAMPLES || 120);
const files = ["Vector3.js", "Matrix.js", "Plane.js", "Frustum.js", "Globals.js", "yyParticle.js", "functions/Function_Maths.js"];

function workload(root) {
    const context = vm.createContext({
        console, navigator: globalThis.navigator, performance,
        g_ParticleSystemManager: null,
        yyGetReal: Number, yyGetInt32: v => v | 0
    });
    vm.runInContext("var window = globalThis; var debug = function () {};", context);
    for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(root, "scripts", file), "utf8"), context, { filename: file });
    }
    return vm.runInContext(`(() => {
        Math.random = () => .5;
        var emitter = { particles: [] };
        var system = { emitters: [emitter], globalSpaceParticles: false };
        g_ParticleSystemManager = { Get: () => system };
        g_ParticleTypes = [new yyParticleType()];

        var retiringParticles = Array.from({ length: 6000 }, (_, i) => {
            var particle = CreateParticle(system, i, i, 0);
            particle.lifetime = i % 6 === 0 ? 2 : 1;
            return particle;
        });
        var sample = (action) => {
            var start = performance.now();
            var result = action();
            return { ms: performance.now() - start, result: result };
        };

        return {
            rng: () => {
                random_set_seed(391295, true);
                return sample(() => {
                    var sum = 0;
                    for (var i = 0; i < 25000; i++) sum += rand();
                    return sum;
                });
            },
            allocation: () => {
                random_set_seed(391295);
                emitter.particles = [];
                return sample(() => {
                    EmitParticles(system, emitter, 20, 40, 0, 6000);
                    return emitter.particles.length;
                });
            },
            expiry: () => {
                for (var particle of retiringParticles) particle.age = 0;
                emitter.particles = retiringParticles.slice();
                return sample(() => {
                    HandleLife(0, 0);
                    return emitter.particles.length;
                });
            }
        };
    })()`, context);
}

const versions = baseline ? { baseline: workload(baseline), updated: workload(updated) } : { updated: workload(updated) };
const result = {};
for (const scenario of ["rng", "allocation", "expiry"]) {
    const timings = Object.fromEntries(Object.keys(versions).map(name => [name, []]));
    for (let i = -40; i < samples; i++) {
        const order = Object.keys(versions);
        if (i % 2 === 1) order.reverse();
        let expected;
        for (const name of order) {
            const value = versions[name][scenario]();
            if (expected !== undefined) assert.equal(value.result, expected, scenario);
            expected = value.result;
            if (i >= 0) timings[name].push(value.ms);
        }
    }
    result[scenario] = Object.fromEntries(Object.entries(timings).map(([name, values]) => {
        values.sort((a, b) => a - b);
        return [name, { p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1] }];
    }));
}
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, samples, results: result }, null, 2));
