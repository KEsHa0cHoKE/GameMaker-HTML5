"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const root = process.argv[2];
if (!root) throw new Error("Usage: node tests/run-musical-tiles-shaders.cjs /path/to/Piano-Tiles");
const experimentRoot = process.argv[3];
const readShader = (project, name, stage) => fs.readFileSync(path.join(project, "shaders", name, name + "." + stage), "utf8");
const backgroundName = "shd_metaball_background";

function backgroundShaders(project) {
    return {
        vertex: readShader(project, backgroundName, "vsh"),
        fragment: readShader(project, backgroundName, "fsh")
    };
}

async function main() {
    const args = [];
    if (process.env.BENCH_SWIFTSHADER === "1") args.push("--enable-unsafe-swiftshader", "--use-angle=swiftshader");
    if (process.env.BENCH_SINGLE_PROCESS === "1") args.push("--single-process", "--no-zygote");
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args });
    try {
        const page = await browser.newPage();
        const result = await page.evaluate(({ background, blur, experiment }) => {
            const canvas = document.createElement("canvas");
            canvas.width = 480;
            canvas.height = 640;
            const gl = canvas.getContext("webgl");
            if (!gl) throw new Error("WebGL is unavailable");
            const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
            const renderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            const compile = (stage, source) => {
                const shader = gl.createShader(stage);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
                return shader;
            };
            const vertex = compile(gl.VERTEX_SHADER, `
                attribute vec2 position;
                varying mediump vec2 v_background_uv;
                varying mediump vec2 v_vTexcoord;
                void main() {
                    gl_Position = vec4(position, 0., 1.);
                    v_vTexcoord = v_background_uv = position * .5 + .5;
                }
            `);
            const makeProgram = (source, vertexShader = vertex, position = "position") => {
                const shader = compile(gl.FRAGMENT_SHADER, source);
                const program = gl.createProgram();
                gl.bindAttribLocation(program, 0, position);
                gl.attachShader(program, vertexShader);
                gl.attachShader(program, shader);
                gl.linkProgram(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
                gl.deleteShader(shader);
                return program;
            };
            const gradient = makeProgram(`
                precision mediump float;
                varying mediump vec2 v_background_uv;
                void main() {
                    gl_FragColor = vec4(v_background_uv.y * .5, v_background_uv.y * .2, .5, 1.);
                }
            `);
            const makeBackground = shaders => {
                const vertexSource = "#define MATRIX_WORLD_VIEW_PROJECTION 4\nuniform highp mat4 gm_Matrices[5];\n" + shaders.vertex;
                const program = makeProgram(shaders.fragment, compile(gl.VERTEX_SHADER, vertexSource), "in_Position");
                gl.useProgram(program);
                const matrices = new Float32Array(16 * 5);
                for (let i = 0; i < 5; i++) for (let d = 0; d < 4; d++) matrices[i * 16 + d * 5] = 1;
                gl.uniformMatrix4fv(gl.getUniformLocation(program, "gm_Matrices[0]"), false, matrices);
                gl.uniform4f(gl.getUniformLocation(program, "u_viewRect"), -1, -1, 2, 2);
                return program;
            };
            const ribbons = makeBackground(background);
            const experimentalRibbons = experiment && makeBackground(experiment);
            const blurProgram = makeProgram("precision mediump float;\nuniform sampler2D gm_BaseTexture;\n" + blur);
            const vertices = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

            function target(width, height) {
                const texture = gl.createTexture();
                const framebuffer = gl.createFramebuffer();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Incomplete framebuffer");
                return { width, height, texture, framebuffer };
            }
            const source = target(canvas.width, canvas.height);
            const quarterA = target(canvas.width / 4, canvas.height / 4);
            const quarterB = target(quarterA.width, quarterA.height);
            const setupTarget = ({ framebuffer, width, height }) => {
                gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                gl.viewport(0, 0, width, height);
            };
            const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            const uniforms = (program, names) => Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
            const names = ["u_flow", "u_motionA", "u_motionB", "u_palette_shift", "u_light_palette", "u_intensity"];
            const baseUniforms = uniforms(ribbons, names);
            const experimentalUniforms = experimentalRibbons && uniforms(experimentalRibbons, names);
            const filter = uniforms(blurProgram, ["u_texel", "u_step", "u_copy"]);
            const drawGradient = () => {
                setupTarget(source);
                gl.useProgram(gradient);
                draw();
            };
            const drawBackground = (program, bg, frame, lightPalette = 1) => {
                setupTarget(source);
                gl.useProgram(program);
                gl.uniform4f(bg.u_flow, 1.1, .88, .6, .75);
                gl.uniform4f(bg.u_motionA, Math.sin(frame * .073), .5, .2, -.1);
                gl.uniform4f(bg.u_motionB, .1, .4, -.55, .2);
                gl.uniform1f(bg.u_palette_shift, (frame / 180) % 4);
                gl.uniform1f(bg.u_light_palette, lightPalette);
                gl.uniform1f(bg.u_intensity, .8);
                draw();
            };
            const blurPass = (input, output, x, y, copy) => {
                setupTarget(output);
                gl.bindTexture(gl.TEXTURE_2D, input.texture);
                gl.uniform2f(filter.u_texel, 1 / input.width, 1 / input.height);
                gl.uniform2f(filter.u_step, x, y);
                gl.uniform1f(filter.u_copy, copy);
                draw();
            };
            const drawBlur = () => {
                gl.useProgram(blurProgram);
                blurPass(source, quarterA, 0, 0, 1);
                blurPass(quarterA, quarterB, 1 / 480, 0, 0);
                blurPass(quarterB, quarterA, 0, 1 / 640, 0);
            };
            const pixels = new Uint8Array(4);
            const timed = fn => {
                const samples = [];
                for (let i = -20; i < 90; i++) {
                    const start = performance.now();
                    fn(i + 20);
                    // Readback is deliberate here to measure completed software rendering.
                    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    if (i >= 0) samples.push(performance.now() - start);
                }
                samples.sort((a, b) => a - b);
                return { p50Ms: samples[44], p95Ms: samples[85] };
            };
            const gradientResult = timed(drawGradient);
            const backgroundResult = timed(frame => drawBackground(ribbons, baseUniforms, frame));
            const blurResult = timed(drawBlur);
            const experimentResult = experimentalRibbons && timed(frame => drawBackground(experimentalRibbons, experimentalUniforms, frame));
            const pixelChecks = [];
            if (experimentalRibbons) {
                const originalPixels = new Uint8Array(source.width * source.height * 4);
                const patchedPixels = new Uint8Array(originalPixels.length);
                const read = pixels => gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                for (const palette of [0, 1]) {
                    for (const frame of [0, 1, 157, 180, 261, 360, 481, 540, 721]) {
                        drawBackground(ribbons, baseUniforms, frame, palette);
                        read(originalPixels);
                        drawBackground(experimentalRibbons, experimentalUniforms, frame, palette);
                        read(patchedPixels);
                        let maxDifference = 0;
                        let differingChannels = 0;
                        for (let i = 0; i < originalPixels.length; i++) {
                            const delta = Math.abs(originalPixels[i] - patchedPixels[i]);
                            if (delta) differingChannels++;
                            maxDifference = Math.max(maxDifference, delta);
                        }
                        pixelChecks.push({ frame, palette, maxDifference, differingChannels, channels: originalPixels.length });
                    }
                }
            }
            const error = gl.getError();
            if (error !== 0) throw new Error("WebGL error " + error);
            return { renderer, resolution: [canvas.width, canvas.height], gradient: gradientResult, background: backgroundResult, blur: blurResult, experiment: experimentResult, pixelChecks };
        }, {
            background: backgroundShaders(root),
            blur: readShader(root, "shd_backdrop_blur", "fsh"),
            experiment: experimentRoot ? backgroundShaders(experimentRoot) : null
        });
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
