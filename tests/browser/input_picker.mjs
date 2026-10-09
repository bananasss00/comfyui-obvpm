// Load Images & Compose's "from input folder" picker (issue #22), in a
// real page: the input folder is listed only when the picker opens --
// never on node creation or workflow load -- and the picker adds what is
// chosen. Also prints the add rows' geometry, to compare the picker
// button with the combo it replaced (--baseline serves the committed JS).
//
// usage: node input_picker.mjs <url> [--vue] [--baseline] [--search=<text>]
//
// Touches nothing on the server: settings are rewritten in flight (Nodes
// 2.0 on or off for this tab only) and settings / userdata writes are
// answered without reaching it.
import puppeteer from "puppeteer-core";
import { execFileSync } from "node:child_process";

const url = process.argv[2] ?? "http://127.0.0.1:8188/";
const VUE = process.argv.includes("--vue");
const BASELINE = process.argv.includes("--baseline");
const SEARCH = process.argv.find((a) => a.startsWith("--search="))?.slice(9) ?? "";
const NODE = "LoadImagesCompose (obvpm)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const repo = new URL("../../", import.meta.url);

const browser = await puppeteer.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true, args: ["--no-sandbox", "--window-size=1600,1000"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
let listings = 0;
page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
page.on("dialog", (d) => d.accept().catch(() => {}));
await page.setRequestInterception(true);
page.on("request", async (r) => {
    const u = r.url(), m = r.method();
    try {
        if (/\/obvpm\/input_images/.test(u)) listings++;
        if (m === "GET" && /\/api\/settings$/.test(u)) {
            const json = await (await fetch(u)).json();
            json["Comfy.VueNodes.Enabled"] = VUE;
            return r.respond({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
        }
        if (m !== "GET" && /\/api\/(settings|userdata)/.test(u)) {
            return r.respond({ status: 200, contentType: "application/json", body: "{}" });
        }
        const js = u.match(/\/extensions\/comfyui-obvpm\/(.+\.js)(\?|$)/);
        if (BASELINE && js) {
            let body = "export {};";
            try {
                body = execFileSync("git", ["show", "HEAD:web/" + js[1]],
                                    { cwd: repo, encoding: "utf8", maxBuffer: 1 << 26 });
            } catch { /* new file: nothing in HEAD */ }
            return r.respond({ status: 200, contentType: "text/javascript", body });
        }
    } catch (err) { errors.push("intercept: " + err.message); }
    return r.continue();
});
await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => window.app?.graph && window.app?.canvas, { timeout: 120000 });
await sleep(4000);
const atPageLoad = listings;

// create the node
const made = await page.evaluate(async (type) => {
    const app = window.app;
    app.graph.clear();
    const node = LiteGraph.createNode(type);
    node.pos = [200, 120];
    app.graph.add(node);
    await new Promise((r) => setTimeout(r, 2500));
    return { id: node.id, size: node.size.map(Math.round),
             widgets: node.widgets.map((w) => `${w.type}:${w.name}`) };
}, NODE);
const atCreate = listings - atPageLoad;

// save and load the workflow twice
const sizes = await page.evaluate(async (type) => {
    const out = [];
    for (let i = 0; i < 2; i++) {
        await window.app.loadGraphData(window.app.graph.serialize());
        await new Promise((r) => setTimeout(r, 2500));
        out.push(window.app.graph.nodes.find((n) => n.type === type).size.map(Math.round));
    }
    return out;
}, NODE);
const atLoad = listings - atPageLoad - atCreate;

// the add rows: where they sit and how tall they are
const rows = await page.evaluate((vue) => {
    const node = window.app.graph.nodes[0];
    const named = (re) => node.widgets.find((w) => re.test(String(w.name)) || re.test(String(w.label ?? "")));
    const add = named(/add image/), pick = named(/input folder|^add$/);
    if (!vue) {
        return { add: add?.last_y, pick: pick?.last_y,
                 gap: pick && add ? pick.last_y - add.last_y : null,
                 nodeH: Math.round(node.size[1]) };
    }
    const card = document.querySelector(`[data-node-id="${node.id}"]`);
    const box = (re) => {
        const el = [...(card?.querySelectorAll("button, [role=combobox], select, .p-select") ?? [])]
            .find((e) => re.test(e.textContent ?? ""));
        const r = el?.getBoundingClientRect();
        return r ? { top: Math.round(r.top), h: Math.round(r.height), tag: el.tagName } : null;
    };
    return { add: box(/add image/), pick: box(/input folder/),
             card: card ? Math.round(card.getBoundingClientRect().height) : null };
}, VUE);

// open the picker the way a user does
let picked = null, dialog = null;
if (!BASELINE) {
    const before = listings;
    if (VUE) {
        const handle = await page.evaluateHandle(() => {
            const node = window.app.graph.nodes[0];
            const card = document.querySelector(`[data-node-id="${node.id}"]`);
            return [...card.querySelectorAll("button")].find((b) => /input folder/.test(b.textContent));
        });
        await handle.asElement()?.click();
    } else {
        const at = await page.evaluate(() => {
            const app = window.app, node = app.graph.nodes[0];
            const w = node.widgets.find((x) => /input folder/.test(String(x.name)));
            const p = app.canvas.ds.convertOffsetToCanvas([node.pos[0] + node.size[0] / 2,
                                                            node.pos[1] + w.last_y + 10]);
            const r = app.canvas.canvas.getBoundingClientRect();
            return [r.left + p[0], r.top + p[1]];
        });
        await page.mouse.click(at[0], at[1]);
    }
    await sleep(1500);
    dialog = await page.evaluate(() => {
        const title = [...document.querySelectorAll("div")]
            .find((d) => d.textContent === "Add from the input folder");
        if (!title) return null;
        const panel = title.parentElement;
        const input = panel.querySelector("input");
        return { focused: document.activeElement === input,
                 status: panel.lastElementChild?.firstElementChild?.textContent };
    });
    if (dialog) {
        if (SEARCH) await page.keyboard.type(SEARCH);
        await sleep(300);
        dialog.afterSearch = await page.evaluate(() => {
            const title = [...document.querySelectorAll("div")]
                .find((d) => d.textContent === "Add from the input folder");
            return title?.parentElement.lastElementChild?.firstElementChild?.textContent;
        });
        await page.keyboard.press("Enter");
        await sleep(800);
        picked = await page.evaluate(() => {
            const node = window.app.graph.nodes[0];
            const w = node.widgets.find((x) => x.name === "layers");
            return JSON.parse(w.value || "[]").map((l) => l.image ?? l);
        });
        dialog.closed = await page.evaluate(() => ![...document.querySelectorAll("div")]
            .some((d) => d.textContent === "Add from the input folder"));
    }
    dialog = { ...(dialog ?? { opened: false }), listingsOnOpen: listings - before };
}

console.log(JSON.stringify({ renderer: VUE ? "nodes2" : "classic", baseline: BASELINE,
    listings: { pageLoad: atPageLoad, nodeCreate: atCreate, twoWorkflowLoads: atLoad },
    created: made, reloadedSizes: sizes, rows, dialog, picked, errors }, null, 1));
await browser.close();
