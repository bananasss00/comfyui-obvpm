// "load settings" rows for a Value Presets node (web/value_presets_restore.js):
// per-field schema changes and per-preset rows start unticked, every
// changed value is its own ticked row, and applying merges only the
// ticked rows into what the node holds now.
//
// Run: node --test tests/test_presets_restore.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { parseSchemaLine, parseSchema, schemaChanges, restoreRows, restoreWrites }
    from "../web/value_presets_restore.js";

const LIVE_SCHEMA = [
    "upscale_to_megapixels: float 0.1..16 = 2 # The size of the upscaled video.",
    "refine_amount: float 0..1 = 0.2 # How much is generated again.",
    "mode: choice fast, slow = fast",
    "",
].join("\n");
const SAVED_SCHEMA = [
    "upscale_factor: float 1..10 = 2 # How much it enlarges.",
    "refine_amount: float 0..1 = 0.3 # How much is generated again, when refined.",
    "mode: choice fast, slow, best = fast when refine_amount = 1",
    "",
].join("\n");

test("a schema line splits the way presets.py's _split_tail does", () => {
    const f = parseSchemaLine("lora: @LoraName.lora_name = a.safetensors when loader != off # a # hint, when ever");
    assert.equal(f.name, "lora");
    assert.equal(f.type, "@LoraName.lora_name");
    assert.equal(f.def, "a.safetensors");
    assert.equal(f.when, "loader != off");
    assert.equal(f.hint, "a # hint, when ever");     // the hint comes off FIRST, whole
    assert.equal(parseSchemaLine("steps: int").def, "");
    assert.equal(parseSchemaLine("no colon here"), null);
    assert.deepEqual([...parseSchema("# a comment\nx: text\n\nx: int\ny: bool = true").keys()], ["x", "y"]);
});

test("schema changes are listed per field and per part", () => {
    const s = schemaChanges(LIVE_SCHEMA, SAVED_SCHEMA);
    const whats = s.lines.map((l) => l.what);
    assert.ok(whats.includes("upscale_factor"), "a field only the take has is listed as added");
    assert.ok(whats.includes("upscale_to_megapixels"), "a field only the node has is listed as removed");
    assert.ok(whats.includes("refine_amount · default"));
    assert.ok(whats.includes("refine_amount · tooltip"));
    assert.ok(whats.includes("mode · type"));
    assert.ok(whats.includes("mode · shown when"));
    assert.ok(!whats.includes("refine_amount · type"), "an unchanged part is not listed");
    const removed = s.lines.find((l) => l.what === "upscale_to_megapixels");
    assert.equal(removed.to, "(removed)");
    const def = s.lines.find((l) => l.what === "refine_amount · default");
    assert.deepEqual([def.from, def.to], ["0.2", "0.3"]);
    assert.equal(s.summary, "2 changed, 1 added, 1 removed");
});

test("the same fields in another order are a change too", () => {
    const s = schemaChanges("a: int\nb: int\n", "b: int\na: int\n");
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].what, "field order");
    assert.equal(s.summary, "fields reordered");
});

const LIVE = {
    schema: LIVE_SCHEMA,
    preset: "custom",
    values: JSON.stringify({ upscale_to_megapixels: 2, refine_amount: 0.2, mode: "fast" }),
    presets: JSON.stringify({ quick: { refine_amount: 0.2 }, keep: { mode: "slow" },
                              mine: { mode: "fast" } }),
    set: "h3_upscale_options",
};
const SAVED = {
    schema: SAVED_SCHEMA,
    preset: "quick",
    values: JSON.stringify({ upscale_factor: 2, refine_amount: 0.3, mode: "fast" }),
    presets: JSON.stringify({ quick: { refine_amount: 0.3, mode: "best" }, keep: { mode: "slow" },
                              old: { mode: "fast" } }),
    set: "h3_upscale_options",
    names: "upscale_factor\nrefine_amount\nmode",
};
const FIELDS = new Set(["upscale_to_megapixels", "refine_amount", "mode"]);

test("rows: schema and presets unticked with details, values ticked one per field", () => {
    const rows = restoreRows(LIVE, SAVED, FIELDS);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));

    assert.equal(by.schema.checked, false);
    assert.ok(by.schema.details.lines.length >= 5);

    // each preset that differs is its own row, unticked, with its values
    assert.equal(by["preset:quick"].checked, false);
    assert.deepEqual(by["preset:quick"].details.lines.map((l) => l.what), ["refine_amount", "mode"]);
    assert.equal(by["preset:quick"].to, "2 value(s) differ");
    assert.equal(by["preset:old"].from, "(not in this workflow)");
    assert.equal(by["preset:mine"].to, "(deleted in the take)");
    assert.equal(by["preset:keep"], undefined, "an identical preset is not a row");

    assert.equal(by.preset.checked, true);
    assert.deepEqual([by.preset.from, by.preset.to], ["custom", "quick"]);

    // values: one row each, only the ones that differ
    assert.equal(by["value:refine_amount"].checked, true);
    assert.deepEqual([by["value:refine_amount"].from, by["value:refine_amount"].to], ["0.2", "0.3"]);
    assert.equal(by["value:mode"], undefined);
    // a field the node does not show: listed, but unticked and said so
    assert.equal(by["value:upscale_factor"].checked, false);
    assert.match(by["value:upscale_factor"].what, /not in the current schema/);

    assert.equal(by.set, undefined, "an equal constant name is not a row");
    assert.equal(by.names, undefined, "names is derived, never a row");
    assert.equal(by.values, undefined, "the raw values JSON is not a row");
});

test("the take's values come first, the schema and presets last", () => {
    const keys = restoreRows(LIVE, SAVED, FIELDS).map((r) => r.key);
    const firstDesign = keys.findIndex((k) => k === "schema" || k.startsWith("preset:"));
    const lastValue = keys.map((k) => k.startsWith("value:") || k === "preset" || k === "set")
        .lastIndexOf(true);
    assert.ok(lastValue < firstDesign, keys.join(", "));
    assert.equal(keys[firstDesign], "schema", "the schema leads the design rows");
});

test("a wired widget gives no rows", () => {
    const rows = restoreRows(LIVE, SAVED, FIELDS, (name) => name === "values" || name === "schema");
    assert.ok(!rows.some((r) => r.key.startsWith("value:") || r.key === "schema"));
    assert.ok(rows.some((r) => r.key === "preset"));
});

test("equal settings give no rows at all", () => {
    assert.deepEqual(restoreRows(LIVE, { ...LIVE }, FIELDS), []);
});

test("applying merges only the ticked rows into what the node holds now", () => {
    const w = restoreWrites(LIVE, SAVED, new Set(["value:refine_amount", "preset:quick", "preset:mine"]));
    assert.deepEqual(Object.keys(w).sort(), ["presets", "values"]);
    assert.deepEqual(JSON.parse(w.values),
                     { upscale_to_megapixels: 2, refine_amount: 0.3, mode: "fast" });
    const presets = JSON.parse(w.presets);
    assert.deepEqual(presets.quick, { refine_amount: 0.3, mode: "best" });
    assert.equal(presets.mine, undefined, "a preset the take lacks is deleted when ticked");
    assert.deepEqual(presets.keep, { mode: "slow" }, "an unticked preset is left alone");
    assert.equal(presets.old, undefined, "an unticked added preset is not added");

    const all = restoreWrites(LIVE, SAVED, new Set(["schema", "preset"]));
    assert.deepEqual(all, { schema: SAVED_SCHEMA, preset: "quick" });
});

test("unreadable JSON is offered whole instead of per field", () => {
    const rows = restoreRows({ ...LIVE, values: "{broken" }, SAVED, FIELDS);
    const v = rows.find((r) => r.key === "values");
    assert.ok(v && v.checked);
    assert.deepEqual(restoreWrites(LIVE, SAVED, new Set(["values"])), { values: SAVED.values });
});
