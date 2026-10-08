// Value Presets export / import of SOME presets (web/value_presets_user.js):
// one preset, picked from many, makes a file of its own that imports back
// as just that preset; an import takes only the presets ticked in a file.
//   node --experimental-vm-modules tests/test_presets_share.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);

async function load() {
    const context = vm.createContext({ console });
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const mod = new vm.SourceTextModule(await readFile(new URL("value_presets_user.js", root), "utf8"),
                                        { context, identifier: "value_presets_user.js" });
    const filter = new vm.SourceTextModule(
        await readFile(new URL("value_presets_filter.js", root), "utf8"),
        { context, identifier: "value_presets_filter.js" });
    await mod.link((spec) => {
        if (spec.endsWith("scripts/api.js")) return mock({ api: {} });
        if (spec === "./value_presets_filter.js") return filter;
        throw new Error("unexpected import " + spec);
    });
    await mod.evaluate();
    return mod.namespace;
}
const U = await load();

const PRESETS = {
    "fast draft": { steps: 4, cfg: 1 },
    "quality": { steps: 20, cfg: 4.5 },
    "night / rain": { steps: 12, cfg: 3 },
};
const plain = (o) => JSON.parse(JSON.stringify(o));

test("one preset picked from many is all the export carries", () => {
    const text = U.exportText({ typeId: "h3-engine", presets: U.pickPresets(PRESETS, ["quality"]) });
    const back = U.parseImport(text);
    assert.equal(back.error, undefined);
    assert.deepEqual(plain(back.presets), { quality: { steps: 20, cfg: 4.5 } });
    assert.equal(back.typeId, "h3-engine");
});

test("picking keeps the order asked and skips names that are not there", () => {
    const got = U.pickPresets(PRESETS, ["quality", "gone", "fast draft"]);
    assert.deepEqual(plain(Object.keys(got)), ["quality", "fast draft"]);
    assert.deepEqual(Object.keys(U.pickPresets(PRESETS, [])), []);
    // a name like a prototype key is not taken from the prototype
    assert.deepEqual(Object.keys(U.pickPresets(PRESETS, ["toString"])), []);
});

test("an import takes only the ticked presets of a file", () => {
    const file = U.parseImport(U.exportText({ presets: PRESETS }));
    const merged = U.mergePresets({ quality: { steps: 30 } },
                                  U.pickPresets(file.presets, ["night / rain"]), "keep");
    assert.deepEqual(plain(merged.added), ["night / rain"]);
    assert.deepEqual(Object.keys(merged.presets).sort(), ["night / rain", "quality"]);
    assert.equal(merged.presets.quality.steps, 30, "what was not ticked is left alone");
});

test("a file of one preset is named after it", () => {
    assert.equal(U.exportFileName(["night / rain"], "h3-engine"), "night_rain.presets.json");
    assert.equal(U.exportFileName(["quality", "fast draft"], "h3-engine"), "h3-engine.presets.json");
    assert.equal(U.exportFileName([], ""), "presets.presets.json");
    assert.equal(U.exportFileName(["../.."], "x"), "presets.presets.json");
    assert.equal(U.exportFileName(["★"], "x"), "presets.presets.json");
});

test("an export carries no schema, and an older file with one still imports", () => {
    assert.equal("schema" in JSON.parse(U.exportText({ presets: PRESETS })), false);
    const old = JSON.stringify({ format: "obvpm-value-presets", version: 1,
                                 schema: "steps: int 1..50 = 8", presets: { quality: { steps: 20 } } });
    const got = U.parseImport(old);
    assert.equal(got.error, undefined);
    assert.deepEqual(plain(got.presets), { quality: { steps: 20 } });
    assert.equal("schema" in got, false);
});
