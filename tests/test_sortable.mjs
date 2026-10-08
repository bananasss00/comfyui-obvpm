// Reordering rows (web/obvpm_ui.js, issue #19): the moves a drag or
// Alt+Up/Down makes, on a plain array, with and without whole groups.
//   node --experimental-vm-modules --test tests/test_sortable.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);
const context = vm.createContext({ console });
const mod = new vm.SourceTextModule(await readFile(new URL("obvpm_ui.js", root), "utf8"),
                                    { context, identifier: "obvpm_ui.js" });
await mod.link(() => { throw new Error("obvpm_ui.js imports nothing"); });
await mod.evaluate();
const { moveBlock, stepSlot } = mod.namespace;

const names = (rows) => rows.map((r) => r.n).join(" ");
const make = (spec) => spec.split(" ").map((t) => {
    const [n, g] = t.split(":");
    return { n, g: g ?? "" };
});
const groupOf = (r) => r.g;

test("a drag moves a row into a slot (a gap between rows)", () => {
    const rows = make("a b c d e");
    assert.deepEqual(moveBlock(rows, 4, 4, 0).map((r) => r.n), ["e"]);
    assert.equal(names(rows), "e a b c d");
    moveBlock(rows, 0, 0, 5);           // below the last row
    assert.equal(names(rows), "a b c d e");
    moveBlock(rows, 1, 1, 4);           // b to just above e
    assert.equal(names(rows), "a c d b e");
});

test("dropping a row next to itself moves nothing", () => {
    const rows = make("a b c");
    assert.equal(moveBlock(rows, 1, 1, 1), null);
    assert.equal(moveBlock(rows, 1, 1, 2), null);
    assert.equal(names(rows), "a b c");
});

test("a block of rows moves together", () => {
    const rows = make("a b c d e");
    moveBlock(rows, 2, 3, 0);
    assert.equal(names(rows), "c d a b e");
    moveBlock(rows, 0, 1, 5);
    assert.equal(names(rows), "a b e c d");
});

test("Alt+Up/Down steps one row, and stops at the ends", () => {
    const rows = make("a b c");
    assert.equal(stepSlot(rows, 0, 0, -1), null);
    assert.equal(stepSlot(rows, 2, 2, 1), null);
    moveBlock(rows, 1, 1, stepSlot(rows, 1, 1, -1));
    assert.equal(names(rows), "b a c");
    moveBlock(rows, 0, 0, stepSlot(rows, 0, 0, 1));
    assert.equal(names(rows), "a b c");
});

test("Alt+Shift+Up/Down steps a whole group past the next group", () => {
    const rows = make("a:x b:x c:y d:y e:y f:z");
    // group y up: past the whole of group x
    moveBlock(rows, 2, 4, stepSlot(rows, 2, 4, -1, groupOf));
    assert.equal(names(rows), "c d e a b f");
    // group y down again: past x, not just one row of it
    moveBlock(rows, 0, 2, stepSlot(rows, 0, 2, 1, groupOf));
    assert.equal(names(rows), "a b c d e f");
    // group x down past y
    moveBlock(rows, 0, 1, stepSlot(rows, 0, 1, 1, groupOf));
    assert.equal(names(rows), "c d e a b f");
});
