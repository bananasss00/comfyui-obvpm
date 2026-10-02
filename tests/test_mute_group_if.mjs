// Mute Group If (web/mute_group_if.js): which nodes it mutes and unmutes.
// The value reader (obvpm_dynamic.js staticInput) is stubbed: a node's
// `values` hold what it would read before the run; the reader itself is
// covered by the browser check on a real workflow.
//   node --experimental-vm-modules tests/test_mute_group_if.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../web/", import.meta.url);

async function load() {
    const context = vm.createContext({ console, setInterval: () => 0, LiteGraph: {} });
    const mock = (values) => new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
    const app = { registerExtension() {} };
    const mod = new vm.SourceTextModule(await readFile(new URL("mute_group_if.js", root), "utf8"),
                                        { context, identifier: "mute_group_if.js" });
    await mod.link((spec) => {
        if (spec.endsWith("scripts/app.js")) return mock({ app });
        if (spec === "./obvpm_dynamic.js") return mock({ staticInput: (n, name) => n.values?.[name] });
        if (spec === "./obvpm_ui.js") return mock({ legacyCanvasBox: (c, w, h) => [w, h] });
        throw new Error("unexpected import " + spec);
    });
    await mod.evaluate();
    return mod.namespace;
}
const M = await load();

const ALWAYS = 0, NEVER = 2, BYPASS = 4;
let ids = 0;
// a node whose centre is (x, y)
const node = (x, y, extra = {}) => ({ id: ++ids, type: "X", mode: ALWAYS, properties: {},
                                      boundingRect: [x - 10, y - 10, 20, 20], ...extra });
const ctl = (x, y, mute, invert = false) => node(x, y, { type: M.TYPE, values: { mute, invert } });
const group = (title, x, y, w, h) => ({ title, _bounding: [x, y, w, h] });

function scene() {
    // generate frame (0..100), upscale frame (200..300), a small group
    // nested inside the generate one (60..100)
    const g = { gen: group("Generate", 0, 0, 100, 100), up: group("Upscale", 200, 0, 100, 100),
                inner: group("First stage", 60, 60, 40, 40) };
    const n = { a: node(20, 20), b: node(40, 40), deep: node(80, 80),
                u1: node(220, 20), u2: node(250, 50), free: node(500, 500),
                mine: node(30, 30, { mode: NEVER }), byp: node(35, 35, { mode: BYPASS }) };
    return { g, n, graph: { _nodes: Object.values(n), _groups: Object.values(g) } };
}

test("mutes the group it sits in, and itself never", () => {
    const { n, graph } = scene();
    const c = ctl(10, 10, true);
    graph._nodes.push(c);
    assert.equal(M.applyMuteGroups(graph), true);
    for (const k of ["a", "b", "deep"]) {
        assert.equal(n[k].mode, NEVER, k);
        assert.equal(n[k].properties[M.FLAG], true);
    }
    assert.equal(c.mode, ALWAYS);
    for (const k of ["u1", "u2", "free"]) assert.equal(n[k].mode, ALWAYS, k);
    assert.equal(n.byp.mode, BYPASS, "a bypassed node is left alone");
    assert.equal(n.mine.properties[M.FLAG], undefined, "already muted by hand: not ours");
    assert.equal(M.applyMuteGroups(graph), false, "again: nothing to change");
    assert.match(c.__obvpmMuteStatus.text, /^muting Generate/);
});

test("unmutes only what it muted, when the value turns", () => {
    const { n, graph } = scene();
    const c = ctl(10, 10, true);
    graph._nodes.push(c);
    M.applyMuteGroups(graph);
    c.values.mute = false;
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, ALWAYS);
    assert.equal(n.a.properties[M.FLAG], undefined);
    assert.equal(n.mine.mode, NEVER, "your own mute stays");
    assert.match(c.__obvpmMuteStatus.text, /^running Generate/);
});

test("invert mutes while the value is false", () => {
    const { n, graph } = scene();
    graph._nodes.push(ctl(210, 10, false, true));
    M.applyMuteGroups(graph);
    assert.equal(n.u1.mode, NEVER);
    assert.equal(n.a.mode, ALWAYS);
});

test("the innermost group: a node in a nested frame mutes only that frame", () => {
    const { n, graph } = scene();
    graph._nodes.push(ctl(65, 65, true));
    M.applyMuteGroups(graph);
    assert.equal(n.deep.mode, NEVER);
    assert.equal(n.a.mode, ALWAYS);
});

test("several controllers: muted while any wants it", () => {
    const { n, graph } = scene();
    const outer = ctl(10, 10, false), inner = ctl(65, 65, true);
    graph._nodes.push(outer, inner);
    M.applyMuteGroups(graph);
    assert.equal(n.deep.mode, NEVER);
    inner.values.mute = false;
    outer.values.mute = true;
    M.applyMuteGroups(graph);
    assert.equal(n.deep.mode, NEVER, "the outer one now wants it");
    outer.values.mute = false;
    M.applyMuteGroups(graph);
    assert.equal(n.deep.mode, ALWAYS);
});

test("a value not known before the run leaves the group on", () => {
    const { n, graph } = scene();
    const c = ctl(10, 10, true);
    graph._nodes.push(c);
    M.applyMuteGroups(graph);
    c.values.mute = undefined;
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, ALWAYS);
    assert.match(c.__obvpmMuteStatus.text, /not known before the run/);
});

test("moving the controller out unmutes its old group; a muted controller mutes nothing", () => {
    const { n, graph } = scene();
    const c = ctl(10, 10, true);
    graph._nodes.push(c);
    M.applyMuteGroups(graph);
    c.boundingRect = [490, 490, 20, 20];
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, ALWAYS);
    assert.equal(c.__obvpmMuteStatus.text, "not in a group");
    c.boundingRect = [0, 0, 20, 20];
    c.mode = NEVER;
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, ALWAYS);
});

test("a deleted controller leaves nothing muted", () => {
    const { n, graph } = scene();
    const c = ctl(10, 10, true);
    graph._nodes.push(c);
    M.applyMuteGroups(graph);
    graph._nodes = graph._nodes.filter((x) => x !== c);
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, ALWAYS);
});

test("the nodes feeding it stay on, so its value stays readable", () => {
    const { n, graph } = scene();
    const get = node(15, 15), not = node(25, 25);
    const c = ctl(10, 10, true);
    c.inputs = [{ name: "mute", link: 1 }];
    not.inputs = [{ name: "value", link: 2 }];
    graph._nodes.push(c, get, not);
    graph.links = { 1: { origin_id: not.id }, 2: { origin_id: get.id } };
    graph.getNodeById = (id) => graph._nodes.find((x) => x.id === id);
    M.applyMuteGroups(graph);
    assert.equal(n.a.mode, NEVER);
    assert.equal(get.mode, ALWAYS);
    assert.equal(not.mode, ALWAYS);
    // a, b, deep, mine, byp: its Get and Not are not counted
    assert.match(c.__obvpmMuteStatus.text, /^muting Generate \(5\)/);
});

test("subgraphs are walked too", () => {
    const inner = node(20, 20);
    const sub = { _nodes: [inner, ctl(10, 10, true)], _groups: [group("Inside", 0, 0, 100, 100)] };
    const holder = node(900, 900, { subgraph: sub });
    M.applyMuteGroups({ _nodes: [holder], _groups: [] });
    assert.equal(inner.mode, NEVER);
});
