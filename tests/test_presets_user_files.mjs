// Value Presets user presets on disk (web/value_presets_user.js): one
// file per preset in obvpm/presets/<id>/, the id's settings (filters) in
// obvpm/presets/<id>.json, presets an older version kept in <id>.json
// moved out, and saves that touch only what changed.
//   node --experimental-vm-modules --test tests/test_presets_user_files.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);
const plain = (o) => JSON.parse(JSON.stringify(o));
const ID = "h3-engine";
const SETTINGS = `obvpm/presets/${ID}.json`;
const FOLDER = `obvpm/presets/${ID}/`;

/** The store in a vm, the user data API answered from `files` (path ->
 *  text). `failWrites` names paths whose write fails. */
async function load(files = new Map(), { failWrites = [] } = {}) {
    const context = vm.createContext({ console: { ...console, warn() {}, error() {} } });
    const log = [];
    const api = {
        getUserData: async (path) => (files.has(path)
            ? { status: 200, text: async () => files.get(path) }
            : { status: 404, text: async () => "" }),
        storeUserData: async (path, text) => {
            if (failWrites.includes(path)) throw new Error("disk full");
            log.push("write " + path);
            files.set(path, text);
        },
        deleteUserData: async (path) => {
            log.push("delete " + path);
            return { status: files.delete(path) ? 204 : 404 };
        },
        // as the frontend answers: paths relative to the folder, recursive
        listUserDataFullInfo: async (dir) => [...files.keys()]
            .filter((p) => p.startsWith(dir)).map((p) => ({ path: p.slice(dir.length) })),
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
    return { U: user.namespace, files, log };
}

const presetFile = (name, values) => JSON.stringify({ format: "obvpm-value-preset", version: 1,
                                                      type_id: ID, name, values });
const read = (files, path) => JSON.parse(files.get(path));

test("presets an older version kept in <id>.json move to their own files", async () => {
    const files = new Map([[SETTINGS, JSON.stringify({
        format: "obvpm-value-presets", version: 1, type_id: ID,
        presets: { quality: { steps: 20 }, "night / rain": { steps: 12 } },
        filters: { model: { include: ["h3/"], exclude: [] } } })]]);
    const { U } = await load(files);
    const got = await U.loadUserPresets(ID);
    assert.deepEqual(plain(got), { quality: { steps: 20 }, "night / rain": { steps: 12 } });
    assert.equal(read(files, FOLDER + "quality.json").name, "quality");
    assert.equal(read(files, FOLDER + "night _ rain.json").name, "night / rain");
    const settings = read(files, SETTINGS);
    assert.equal("presets" in settings, false);
    assert.deepEqual(settings.filters, { model: { include: ["h3/"], exclude: [] } });
    assert.equal(settings.version, 2);
});

test("a move that fails leaves <id>.json as it was, and the presets listed", async () => {
    const old = JSON.stringify({ format: "obvpm-value-presets", version: 1, type_id: ID,
                                 presets: { quality: { steps: 20 }, fast: { steps: 4 } } });
    const files = new Map([[SETTINGS, old]]);
    const { U } = await load(files, { failWrites: [FOLDER + "fast.json"] });
    const got = await U.loadUserPresets(ID);
    assert.deepEqual(Object.keys(got).sort(), ["fast", "quality"]);
    assert.equal(files.get(SETTINGS), old);
    assert.equal(U.userPresetsError(ID), null);
});

test("a moved preset whose name a file already has: same values merge, others are kept", async () => {
    const files = new Map([
        [SETTINGS, JSON.stringify({ format: "obvpm-value-presets", version: 1,
                                    presets: { same: { steps: 1 }, clash: { steps: 2 } } })],
        [FOLDER + "same.json", presetFile("same", { steps: 1 })],
        [FOLDER + "clash.json", presetFile("clash", { steps: 9 })],
    ]);
    const { U } = await load(files);
    const got = await U.loadUserPresets(ID);
    assert.deepEqual(plain(got), { clash: { steps: 9 }, same: { steps: 1 }, "clash 2": { steps: 2 } });
    assert.equal(read(files, FOLDER + "clash 2.json").name, "clash 2");
});

test("a save writes only what changed and deletes only what was removed", async () => {
    const files = new Map([
        [FOLDER + "a.json", presetFile("a", { steps: 1 })],
        [FOLDER + "b.json", presetFile("b", { steps: 2 })],
        [FOLDER + "c.json", presetFile("c", { steps: 3 })],
    ]);
    const { U, log } = await load(files);
    await U.loadUserPresets(ID);
    // b changed, c removed, d added; a untouched
    await U.saveUserPresets(ID, { a: { steps: 1 }, b: { steps: 20 }, d: { steps: 4 } });
    assert.deepEqual(log, [`write ${FOLDER}b.json`, `write ${FOLDER}d.json`, `delete ${FOLDER}c.json`]);
    assert.deepEqual(plain(U.userPresets(ID)), { a: { steps: 1 }, b: { steps: 20 }, d: { steps: 4 } });
    assert.equal(files.has(SETTINGS), false, "no settings file is needed for presets");
});

test("a rename writes the new file before it deletes the old one", async () => {
    const files = new Map([[FOLDER + "old name.json", presetFile("old name", { steps: 5 })]]);
    const { U, log } = await load(files);
    await U.loadUserPresets(ID);
    await U.saveUserPresets(ID, { "new name": { steps: 5 } });
    assert.deepEqual(log, [`write ${FOLDER}new name.json`, `delete ${FOLDER}old name.json`]);
});

test("a preset saved meanwhile from another tab is left alone", async () => {
    const files = new Map([[FOLDER + "a.json", presetFile("a", { steps: 1 })]]);
    const { U } = await load(files);
    await U.loadUserPresets(ID);
    files.set(FOLDER + "other tab.json", presetFile("other tab", { steps: 7 }));
    await U.saveUserPresets(ID, { a: { steps: 1 }, mine: { steps: 2 } });
    assert.equal(files.has(FOLDER + "other tab.json"), true);
    await U.loadUserPresets(ID, { fresh: true });
    assert.deepEqual(Object.keys(U.userPresets(ID)).sort(), ["a", "mine", "other tab"]);
});

test("file names that differ only in case are not taken twice", async () => {
    const files = new Map([[FOLDER + "Quality.json", presetFile("Quality", { steps: 1 })]]);
    const { U } = await load(files);
    await U.loadUserPresets(ID);
    await U.saveUserPresets(ID, { Quality: { steps: 1 }, quality: { steps: 2 } });
    assert.equal(read(files, FOLDER + "quality 2.json").name, "quality");
});

test("the name inside the file wins over its file name; a file that is no preset is skipped", async () => {
    const files = new Map([
        [FOLDER + "renamed by hand.json", presetFile("quality", { steps: 20 })],
        [FOLDER + "notes.json", JSON.stringify({ hello: 1 })],
        [FOLDER + "broken.json", "{"],
        [FOLDER + "sub/deep.json", presetFile("deep", { steps: 1 })],
    ]);
    const { U } = await load(files);
    assert.deepEqual(plain(await U.loadUserPresets(ID)), { quality: { steps: 20 } });
    assert.equal(U.userPresetsError(ID), null);
});

test("saving filters writes only <id>.json; the preset files are not touched", async () => {
    const files = new Map([[FOLDER + "a.json", presetFile("a", { steps: 1 })]]);
    const { U, log } = await load(files);
    await U.saveUserFilters(ID, { model: { include: ["h3/"], exclude: [] } });
    assert.deepEqual(log, [`write ${SETTINGS}`]);
    assert.deepEqual(read(files, SETTINGS).filters, { model: { include: ["h3/"], exclude: [] } });
    assert.deepEqual(plain(U.userPresets(ID)), { a: { steps: 1 } });
    await U.saveUserFilters(ID, {});
    assert.equal("filters" in read(files, SETTINGS), false);
});

test("a settings file that cannot be read is never written over", async () => {
    const files = new Map([[SETTINGS, "{ not json"]]);
    const { U, log } = await load(files);
    await assert.rejects(U.saveUserFilters(ID, { model: { include: ["x"], exclude: [] } }),
                         /not saved/);
    await assert.rejects(U.saveUserPresets(ID, { a: { steps: 1 } }), /not saved/);
    assert.deepEqual(log, []);
    assert.equal(files.get(SETTINGS), "{ not json");
});
