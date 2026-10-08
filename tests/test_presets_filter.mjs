// Value Presets dropdown filters (web/value_presets_filter.js) and their
// place in the user presets file (web/value_presets_user.js): what a
// filter lists, what it never hides, and that saving one part of the
// file keeps the other.
//   node --experimental-vm-modules --test tests/test_presets_filter.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);
const plain = (o) => JSON.parse(JSON.stringify(o));

/** The two modules in a vm, the user data API answered from `files`. */
async function load(files = new Map()) {
    const context = vm.createContext({ console });
    const writes = [];
    const api = {
        getUserData: async (path) => (files.has(path)
            ? { status: 200, text: async () => files.get(path) }
            : { status: 404, text: async () => "" }),
        storeUserData: async (path, text) => { writes.push(path); files.set(path, text); },
    };
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const source = async (name) => new vm.SourceTextModule(
        await readFile(new URL(name, root), "utf8"), { context, identifier: name });
    const filter = await source("value_presets_filter.js");
    const user = await source("value_presets_user.js");
    const link = (spec) => {
        if (spec.endsWith("scripts/api.js")) return mock({ api });
        if (spec === "./value_presets_filter.js") return filter;
        throw new Error("unexpected import " + spec);
    };
    await filter.link(link);
    await user.link(link);
    await user.evaluate();
    return { F: filter.namespace, U: user.namespace, files, writes };
}

const MODELS = [
    "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "h3\\fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
    "h3\\minimax_h3_fp8.safetensors",
    "old\\minimax_h3_v0.safetensors",
    "wan2.2_t2v.safetensors",
];

test("include any, exclude always wins, order-free", async () => {
    const { F } = await load();
    const r = F.filterChoices(MODELS, { include: ["h3"], exclude: ["fp8", "old/"] });
    assert.deepEqual(plain(r.choices), [MODELS[0], MODELS[1]]);
    assert.equal(r.shown, 2);
    assert.equal(r.total, 5);
    const swapped = F.filterChoices(MODELS, { exclude: ["old/", "fp8"], include: ["h3"] });
    assert.deepEqual(plain(swapped.choices), plain(r.choices));
});

test("patterns: anywhere, any case, * for anything, \\ and / the same", async () => {
    const { F } = await load();
    assert.equal(F.matches("h3\\Model_A.safetensors", "model_a"), true);
    assert.equal(F.matches("h3\\model_a.safetensors", "h3/"), true);
    assert.equal(F.matches("h3\\model_a.safetensors", "h3\\model"), true);
    assert.equal(F.matches("minimax_h3_fp8.safetensors", "minimax*fp8"), true);
    assert.equal(F.matches("minimax_h3_int8.safetensors", "minimax*fp8"), false);
    // regex characters are plain text
    assert.equal(F.matches("wan2.2_t2v", "wan2.2"), true);
    assert.equal(F.matches("wan2x2_t2v", "wan2.2"), false);
    assert.equal(F.matches("a(b)", "(b)"), true);
});

test("the value the field holds is always listed, in its place", async () => {
    const { F } = await load();
    const r = F.filterChoices(MODELS, { include: ["fastvideo"] }, MODELS[3]);
    assert.deepEqual(plain(r.choices), [MODELS[1], MODELS[3]]);
    assert.equal(r.shown, 1);           // what the filter passes, not the kept value
});

test("a filter that passes nothing is not applied", async () => {
    const { F } = await load();
    const r = F.filterChoices(MODELS, { include: ["nothing like this"] }, MODELS[0]);
    assert.equal(r.ignored, true);
    assert.equal(r.choices.length, MODELS.length);
    assert.match(F.filterNote(r), /matches none of the 5/);
    assert.equal(F.filterNote(F.filterChoices(MODELS, null)), "");
    assert.match(F.filterNote(F.filterChoices(MODELS, { exclude: ["wan"] })), /lists 4 of 5/);
});

test("filters from a file: bad entries dropped, empty fields dropped", async () => {
    const { F } = await load();
    const got = F.filtersFrom({
        model: { include: ["h3", "", 7, "  fast  "], exclude: ["fp8"] },
        empty: { include: [], exclude: [] },
        bad: "h3",
        list: [1, 2],
    });
    assert.deepEqual(plain(got), { model: { include: ["h3", "fast"], exclude: ["fp8"] } });
    assert.deepEqual(plain(F.patternsFrom("a\n\n  b \r\nc")), ["a", "b", "c"]);
});

test("saving filters keeps the presets, saving presets keeps the filters", async () => {
    const files = new Map([["obvpm/presets/h3-engine.json", JSON.stringify({
        format: "obvpm-value-presets", version: 1, type_id: "h3-engine",
        presets: { quality: { steps: 20 } } })]]);
    const { U } = await load(files);
    await U.saveUserFilters("h3-engine", { model: { include: ["h3/"], exclude: [] } });
    let saved = JSON.parse(files.get("obvpm/presets/h3-engine.json"));
    assert.deepEqual(saved.presets, { quality: { steps: 20 } });
    assert.deepEqual(saved.filters, { model: { include: ["h3/"], exclude: [] } });
    await U.saveUserPresets("h3-engine", { quality: { steps: 20 }, fast: { steps: 4 } });
    saved = JSON.parse(files.get("obvpm/presets/h3-engine.json"));
    assert.deepEqual(saved.filters, { model: { include: ["h3/"], exclude: [] } });
    assert.deepEqual(Object.keys(saved.presets), ["quality", "fast"]);
    assert.deepEqual(plain(U.userFilters("h3-engine")), saved.filters);
});

test("a file that cannot be read is never written over", async () => {
    const files = new Map([["obvpm/presets/broken.json", "{ not json"]]);
    const { U, writes } = await load(files);
    await assert.rejects(U.saveUserFilters("broken", { model: { include: ["x"], exclude: [] } }),
                         /not saved/);
    await assert.rejects(U.saveUserPresets("broken", { a: { steps: 1 } }), /not saved/);
    assert.deepEqual(writes, []);
    assert.equal(files.get("obvpm/presets/broken.json"), "{ not json");
});

test("no filters, no filters key: older readers see the file they knew", async () => {
    const { U, files } = await load();
    await U.saveUserPresets("plain", { a: { steps: 1 } });
    assert.equal("filters" in JSON.parse(files.get("obvpm/presets/plain.json")), false);
});
