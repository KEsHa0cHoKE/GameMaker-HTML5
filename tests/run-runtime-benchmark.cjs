"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const updated = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const baseline = process.argv[3] && path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4] || "runtime-benchmark-results.json");
const repeat = Number(process.env.BENCH_REPEATS || 3);
const frames = Number(process.env.BENCH_FRAMES || 120);
const warmup = Number(process.env.BENCH_WARMUP || 90);
const scenarios = process.env.BENCH_SCENARIOS || "menu,songs,tiles,burst,expiry,combined,rooms,resources";
const variants = baseline ? { baseline, updated } : { updated };
const profiles = {
    desktop: { cpu: 1, config: { viewport: { width: 900, height: 850 } } },
    cpu4: { cpu: 4, config: { viewport: { width: 900, height: 850 } } },
    mobile: { cpu: 4, config: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } }
};
const selectedProfiles = (process.env.BENCH_PROFILES || Object.keys(profiles).join(",")).split(",");
const mime = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png" };

const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const match = url.pathname.match(/^\/(baseline|updated)\/(tests\/runtime-benchmark\.(?:html|js)|scripts\/[a-zA-Z0-9_./-]+)$/);
    if (!match || !variants[match[1]] || match[2].split("/").includes("..")) {
        response.writeHead(404).end();
        return;
    }
    const root = match[2].startsWith("tests/") ? updated : variants[match[1]];
    const filename = path.join(root, match[2]);
    const stream = fs.createReadStream(filename);
    stream.on("error", () => response.writeHead(404).end());
    stream.once("open", () => {
        response.setHeader("Content-Type", mime[path.extname(filename)] || "application/octet-stream");
        stream.pipe(response);
    });
});

async function run(browser, url, variant, profileName, runNumber) {
    const { cpu, config } = profiles[profileName];
    const context = await browser.newContext(config);
    try {
        const page = await context.newPage();
        const client = await context.newCDPSession(page);
        const trace = [];
        client.on("Tracing.dataCollected", ({ value }) => trace.push(...value));
        const traceComplete = new Promise(resolve => client.once("Tracing.tracingComplete", resolve));
        await client.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        await page.goto(url);
        await client.send("Tracing.start", {
            categories: "devtools.timeline,v8,blink.user_timing", transferMode: "ReportEvents"
        });
        if (process.env.BENCH_CPU_PROFILE) {
            await client.send("Profiler.enable");
            await client.send("Profiler.start");
        }
        const benchmark = page.evaluate(() => window.runRuntimeBenchmark());
        if (process.env.BENCH_FREEZE_MS) {
            const phase = scenarios.split(",")[0];
            await page.waitForFunction(name => performance.getEntriesByName("start:" + name).length > 0, phase);
            await client.send("Page.setWebLifecycleState", { state: "frozen" });
            await new Promise(resolve => setTimeout(resolve, Number(process.env.BENCH_FREEZE_MS)));
            await client.send("Page.setWebLifecycleState", { state: "active" });
        }
        const result = await benchmark;
        if (process.env.BENCH_CPU_PROFILE) {
            const { profile } = await client.send("Profiler.stop");
            fs.writeFileSync(output + "." + variant + "." + profileName + "." + runNumber + ".cpuprofile", JSON.stringify(profile));
        }
        await client.send("Tracing.end");
        await traceComplete;
        for (const row of result.results) {
            const first = trace.find(x => x.name === "start:" + row.scene);
            const last = trace.find(x => x.name === "end:" + row.scene);
            if (!first || !last) throw new Error("Missing trace marks for " + row.scene);
            const events = trace.filter(x => x.pid === first.pid && x.tid === first.tid && x.ts >= first.ts && x.ts <= last.ts);
            const collect = names => events.filter(x => names.includes(x.name) && x.ph === "X");
            const gc = collect(["MinorGC", "MajorGC"]);
            const callbacks = collect(["FireAnimationFrame"]);
            row.gcMs = gc.reduce((sum, x) => sum + x.dur / 1000, 0);
            row.gcCount = gc.length;
            row.callbackThreadMsPerFrame = callbacks.length && callbacks.every(x => x.tdur !== undefined)
                ? callbacks.reduce((sum, x) => sum + x.tdur / 1000, 0) / row.frames
                : null;
            if (row.glError !== 0) throw new Error("WebGL error in " + row.scene + ": " + row.glError);
        }
        return { variant, profile: profileName, run: runNumber, ...result };
    } finally {
        await context.close();
    }
}

async function main() {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const args = ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"];
        if (process.env.BENCH_SWIFTSHADER === "1") args.push("--enable-unsafe-swiftshader", "--use-angle=swiftshader");
        if (process.env.BENCH_SINGLE_PROCESS === "1") args.push("--single-process", "--no-zygote");
        const base = "http://127.0.0.1:" + server.address().port;
        const measurements = [];
        const metadata = { browser: null, frames, warmup, repeats: repeat, scenarios, profiles: selectedProfiles };
        for (const profile of selectedProfiles) {
            for (let i = 0; i < repeat; i++) {
                const order = Object.keys(variants);
                if (i % 2 === 1) order.reverse();
                for (const variant of order) {
                    const url = base + "/" + variant + "/tests/runtime-benchmark.html?manual=1&frames=" + frames + "&warmup=" + warmup + "&scenarios=" + scenarios;
                    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args });
                    try {
                        metadata.browser = browser.version();
                        measurements.push(await run(browser, url, variant, profile, i + 1));
                    } finally {
                        await browser.close();
                    }
                    fs.writeFileSync(output, JSON.stringify({ ...metadata, measurements }, null, 2) + "\n");
                    console.log(profile, i + 1, variant);
                }
            }
        }
    } finally {
        server.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
