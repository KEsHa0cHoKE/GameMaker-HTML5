"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = process.env.TEST_RUNTIME_ROOT || path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "scripts/libWebGL/yyCommandBuilder.js"), "utf8");

test("frame lighting is snapshotted and applied before subsequent per-light updates", () => {
    const uploads = [];
    const sandbox = {
        yyGL: { MAX_LIGHTS: 8 },
        Matrix: class {},
        gl: {
            getExtension: () => ({}),
            getParameter: () => 0,
            enable() {},
            useProgram() {},
            uniform4fv: (name, value) => uploads.push({ name, value: Array.from(value) })
        }
    };
    vm.runInNewContext(script + `
        var builder = { _gl: gl };
        yyCommandBuilder.call(builder);
        builder.SetShader({
            pointLightPosAttribute: "point",
            dirLightDirAttribute: "direction",
            lightColourAttribute: "color"
        });
        var point = new Float32Array(32);
        var direction = new Float32Array(32);
        var color = new Float32Array(32);
        point[0] = 2;
        direction[4] = 3;
        color[12] = 4;
        if (builder.SetLights) {
            builder.SetLights(point, direction, color);
        } else {
            for (var i = 0; i < 8; i++) {
                var offset = i * 4;
                builder.SetLight(i, point.subarray(offset, offset + 4),
                    direction.subarray(offset, offset + 4), color.subarray(offset, offset + 4));
            }
        }
        point[0] = direction[4] = color[12] = 99;
        builder.SetLight(1, [5, 0, 0, 0], [6, 0, 0, 0], [7, 0, 0, 0]);
        builder.Execute();
    `, sandbox);
    const [point, direction, color] = uploads.slice(-6, -3);
    assert.equal(point.value[0], 2);
    assert.equal(direction.value[4], 3);
    assert.equal(color.value[12], 4);
    assert.deepEqual(uploads.slice(-3).map(entry => entry.value[4]), [5, 6, 7]);
    if (!process.env.TEST_RUNTIME_ROOT) assert.equal(uploads.length, 9);
});
