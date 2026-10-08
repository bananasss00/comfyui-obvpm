// Value Presets export / import (web/value_presets_user.js): an export is
// ONE preset, as the same file it is in the user presets folder; an
// import reads such files (several at once) and still reads the
// multi-preset files older versions exported, taking the ticked presets.
//   node --experimental-vm-modules --test tests/test_presets_share.mjs
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

test("an exported preset imports back as itself, its name kept whole", () => {
    const text = U.presetFileText({ typeId: "h3-engine", name: "night / rain",
                                    values: PRESETS["night / rain"] });
    const data = JSON.parse(text);
    assert.equal(data.format, "obvpm-value-preset");
    assert.equal(data.name, "night / rain");
    const back = U.parseImport(text);
    assert.equal(back.error, undefined);
    assert.deepEqual(plain(back.presets), { "night / rain": { steps: 12, cfg: 3 } });
    assert.equal(back.typeId, "h3-engine");
});

test("the download is named as the file is in the presets folder", () => {
    assert.equal(U.exportFileName("night / rain"), "night _ rain.json");
    assert.equal(U.exportFileName("quality"), "quality.json");
    assert.equal(U.exportFileName("../.."), "preset.._.json");     // no path, no hidden file
    assert.equal(U.exportFileName("con"), "_con.json");
    assert.equal(U.exportFileName("ends with dots..."), "ends with dots.json");
    assert.equal(U.exportFileName("x".repeat(100)).length, 64 + 5);
});

test("several files import as one list; a name that comes twice is kept twice", () => {
    const a = U.presetFileText({ name: "quality", values: { steps: 20 } });
    const b = U.presetFileText({ name: "quality", values: { steps: 30 } });
    const old = JSON.stringify({ format: "obvpm-value-presets", version: 1, presets: PRESETS });
    const got = U.parseImports([["a.json", a], ["b.json", b], ["old.json", old], ["bad.json", "{"]]);
    assert.deepEqual(plain(Object.keys(got.presets)),
                     ["quality", "quality 2", "fast draft", "quality 3", "night / rain"]);
    assert.equal(got.errors.length, 1);
    assert.match(got.errors[0], /^bad\.json: Not a presets file/);
});

test("an import takes only the ticked presets of an older multi-preset file", () => {
    const file = U.parseImport(JSON.stringify({ format: "obvpm-value-presets", version: 1,
                                                schema: "steps: int 1..50 = 8", presets: PRESETS }));
    assert.equal("schema" in file, false);
    const merged = U.mergePresets({ quality: { steps: 30 } },
                                  U.pickPresets(file.presets, ["night / rain"]), "keep");
    assert.deepEqual(plain(merged.added), ["night / rain"]);
    assert.deepEqual(Object.keys(merged.presets).sort(), ["night / rain", "quality"]);
    assert.equal(merged.presets.quality.steps, 30, "what was not ticked is left alone");
    // a name like a prototype key is not taken from the prototype
    assert.deepEqual(Object.keys(U.pickPresets(PRESETS, ["toString"])), []);
});

test("a one-preset file that is not readable says so", () => {
    const r = U.parseImport(JSON.stringify({ format: "obvpm-value-preset", name: "x", values: [1] }));
    assert.match(r.error, /not readable/);
    const reserved = U.parseImport(JSON.stringify({ format: "obvpm-value-preset", name: "custom", values: {} }));
    assert.match(reserved.error, /not readable/);
});
