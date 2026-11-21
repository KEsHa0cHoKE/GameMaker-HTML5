"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = process.env.TEST_RUNTIME_ROOT || path.join(__dirname, "..");
const files = [
    "Vector3.js", "Matrix.js", "Plane.js", "Frustum.js", "Globals.js", "yyVariable.js", "yyBuiltIn.js",
    "yyTypes.js", "yyList.js", "yyOList.js", "yySprite.js", "yyRoom.js",
    "yyParticle.js", "functions/Function_Maths.js", "functions/Function_Particles.js",
    "functions/Function_Layers.js"
];
const runtime = files.map(name => fs.readFileSync(path.join(root, "scripts", name), "utf8")).join("\n");

function load() {
    const context = vm.createContext({ console, navigator: globalThis.navigator });
    vm.runInContext("var window = globalThis; var debug = function () {};\n" + runtime, context);
    vm.runInContext(`
        g_isZeus = true;
        g_ParticleTypes = [];
        g_ParticleSystemManager = new yyParticleSystemManager();
        g_pLayerManager = new LayerManager();
        g_RunRoom = new yyRoom();
        random_set_seed(38161, true);
        Math.random = () => .5;
        var id = GetParticleSystemInstanceIndex(part_system_create());
        var system = g_ParticleSystemManager.Get(id);
        var index = ParticleSystem_Emitter_Create(id);
        var emitter = system.emitters[index];
    `, context);
    return code => vm.runInContext(code, context);
}

test("expiry preserves survivor order, null entries and the same-tick processing of child particles", () => {
    const run = load();
    const result = run(`
        var stable = ParticleType_Create();
        var child = ParticleType_Create();
        var dies = ParticleType_Create();
        var steps = ParticleType_Create();
        g_ParticleTypes[stable].lifemin = g_ParticleTypes[stable].lifemax = 5;
        g_ParticleTypes[child].lifemin = g_ParticleTypes[child].lifemax = 6;
        g_ParticleTypes[dies].lifemin = g_ParticleTypes[dies].lifemax = 1;
        g_ParticleTypes[dies].deathnumber = 1;
        g_ParticleTypes[dies].deathtype = child;
        g_ParticleTypes[steps].stepnumber = 1;
        g_ParticleTypes[steps].steptype = child;
        emitter.particles.push(CreateParticle(system, 10, 5, dies));
        emitter.particles.push(CreateParticle(system, 20, 5, stable));
        emitter.particles.push(null);
        emitter.particles.push(CreateParticle(system, 30, 5, steps));
        emitter.particles.push(CreateParticle(system, 40, 5, dies));
        HandleLife(id, index);
        JSON.stringify(emitter.particles.map(p => p && [p.x, p.parttype, p.age]));
    `);
    assert.deepEqual(JSON.parse(result), [[20, 0, 1], null, [30, 3, 1], [10, 1, 1], [30, 1, 1], [40, 1, 1]]);
});

test("particle color parameters are isolated from later changes and other particles", () => {
    const run = load();
    const result = run(`
        var type = ParticleType_Create();
        ParticleType_Color2(type, 0x123456, 0x654321);
        var original = CreateParticle(system, 0, 0, type);
        var other = CreateParticle(system, 0, 0, type);
        var originalColors = original.colpar.slice();
        ParticleType_Color2(type, 0xccaabb, 0x112233);
        other.colpar[0] = 0;
        JSON.stringify({
            colorsUnchanged: original.colpar.every((c, i) => c === originalColors[i]),
            typeHasNewColor: g_ParticleTypes[type].colpar[0] !== originalColors[0],
            missingType: CreateParticle(system, 0, 0, -1)
        });
    `);
    assert.deepEqual(JSON.parse(result), { colorsUnchanged: true, typeHasNewColor: true, missingType: null });
});
