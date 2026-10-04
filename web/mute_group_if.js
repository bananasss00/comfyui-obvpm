// Mute Group If: mutes the group the node sits in while its `mute` value
// is true (false with `invert`).
//
// All in the browser. The value is read the way the switches read theirs
// before a run (obvpm_dynamic.js staticInput: widgets, primitives, Value
// Presets fields, Unbundle, Not, Get/Set, a node's obvpmStaticOutput such
// as the timeline's `upscaling`). Muted (Never) nodes are left out of the
// prompt, so the group does not run at all -- loaders included -- and it
// shows greyed. The node itself has no outputs and never runs.
//
// "The group it sits in": the smallest group frame holding the node's
// centre; its nodes are those whose centre is inside that frame -- the
// frontend's own rule for what a group moves (LGraphGroup
// recomputeInsideNodes). Computed here rather than by calling that, which
// also re-sorts the graph's groups and would read as an edit on every tick.
//
// The nodes feeding a Mute Group If (its Get, a Not) are never muted
// either, so they may sit beside it inside the group it controls.
//
// Inside a subgraph with no group around it there, it acts on the group
// around the subgraph's node in the graph that holds it (climbing further
// while that node is in no group either) -- once per place the subgraph
// is used. The subgraph's node itself is never muted (it holds the
// switch), nor what feeds it. A group inside the subgraph still wins.
//
// Only nodes a Mute Group If muted are unmuted again (they carry FLAG): a
// node muted or bypassed by hand keeps its mode. Several of these may
// cover one node; it stays muted while any of them wants it muted. A value
// that cannot be read before the run leaves the group ON: unmuted is the
// safe side wherever a lazy switch or a gate still decides at run time.
//
// When: on a short poll (the value can change anywhere -- a preset, a
// toggle on another node), and once more right before every prompt is
// built, so a queued run always matches.

import { app } from "../../scripts/app.js";
import { staticInput } from "./obvpm_dynamic.js";

export const TYPE = "MuteGroupIf (obvpm)";
export const FLAG = "obvpm_group_muted";
const ALWAYS = 0;
const NEVER = 2;
const BYPASS = 4;
const POLL_MS = 400;

function graphsOf(root) {
    const out = [];
    const walk = (g, depth) => {
        if (!g || out.includes(g) || depth > 8) return;
        out.push(g);
        for (const n of g._nodes ?? g.nodes ?? []) {
            if (n.subgraph) walk(n.subgraph, depth + 1);
        }
    };
    walk(root, 0);
    return out;
}

/** graph -> [{holder, parent}]: each node that uses a subgraph, and the
 *  graph that node sits in. */
function hostsOf(graphs) {
    const hosts = new Map();
    for (const parent of graphs) {
        for (const holder of parent._nodes ?? parent.nodes ?? []) {
            if (!holder.subgraph) continue;
            if (!hosts.has(holder.subgraph)) hosts.set(holder.subgraph, []);
            hosts.get(holder.subgraph).push({ holder, parent });
        }
    }
    return hosts;
}

/** Where a controller (or the subgraph node holding it) acts: the group
 *  around it in its own graph, else -- in a subgraph -- the group around
 *  each node using that subgraph, climbing on while there is none.
 *  [{graph, group, holders}]: `holders` are the subgraph nodes climbed
 *  through, which hold the controller and are never muted. */
function targetsOf(graph, node, hosts, holders = [], depth = 0) {
    const group = groupOf(graph, node);
    if (group) return [{ graph, group, holders }];
    if (depth > 8) return [];
    return (hosts.get(graph) ?? []).flatMap(({ holder, parent }) =>
        targetsOf(parent, holder, hosts, [...holders, holder], depth + 1));
}

function centre(node) {
    const r = node.boundingRect;
    // (all zeros on a node not drawn yet -- a subgraph just made: use pos)
    if (r && r.length >= 4 && (r[2] || r[3])) return [r[0] + r[2] / 2, r[1] + r[3] / 2];
    const title = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    return [node.pos[0] + node.size[0] / 2, node.pos[1] - title + (node.size[1] + title) / 2];
}

function frame(group) {
    return group._bounding ?? group.bounding;
}

function inside([x, y], b) {
    return !!b && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
}

/** The smallest group frame holding the node's centre, or null. */
export function groupOf(graph, node) {
    const c = centre(node);
    let best = null;
    for (const g of graph._groups ?? graph.groups ?? []) {
        const b = frame(g);
        if (!inside(c, b)) continue;
        if (!best || b[2] * b[3] < frame(best)[2] * frame(best)[3]) best = g;
    }
    return best;
}

/** True / false when the node's value is known before the run, else undefined. */
export function wantsMute(node) {
    const mute = staticInput(node, "mute");
    if (typeof mute !== "boolean") return undefined;
    const invert = staticInput(node, "invert");
    return invert === true ? !mute : mute;
}

function linkOf(graph, id) {
    const links = graph?.links;
    if (!links || id == null) return null;
    return typeof links.get === "function" ? links.get(id) : links[id];
}

/** The nodes feeding a controller's inputs (wired upstream, any depth):
 *  never muted, so a Get beside the controller inside its own group keeps
 *  the value readable -- muting it would leave the value unknown, and the
 *  group would come straight back on. */
function sourcesOf(graph, ctl, out = new Set()) {
    const stack = [ctl];
    while (stack.length) {
        const n = stack.pop();
        for (const slot of n.inputs ?? []) {
            const l = linkOf(graph, slot.link);
            const src = l ? graph.getNodeById?.(l.origin_id) : null;
            if (src && !out.has(src)) {
                out.add(src);
                stack.push(src);
            }
        }
    }
    return out;
}

function setMode(node, mode) {
    if (typeof node.changeMode === "function") node.changeMode(mode);
    else node.mode = mode;
}

/** Bring every graph's muting in line with its Mute Group If nodes; true
 *  when any node's mode changed. Each controller gets `__obvpmMuteStatus`
 *  (what it is doing, for diagnostics -- the node shows no status line:
 *  the greyed group says it). */
export function applyMuteGroups(root) {
    const graphs = graphsOf(root);
    const hosts = hostsOf(graphs);
    // Decided over every graph first, then applied: a controller in a
    // subgraph may act on the graph around it.
    const muteSet = new Set();
    const keep = new Set();         // feeders and holders: never muted
    const acts = [];
    for (const graph of graphs) {
        for (const ctl of graph._nodes ?? graph.nodes ?? []) {
            if (ctl.type !== TYPE) continue;
            sourcesOf(graph, ctl, keep);
            const targets = targetsOf(graph, ctl, hosts);
            for (const t of targets) {
                for (const h of t.holders) keep.add(h);
                // what feeds the subgraph node the switch climbed out of
                const last = t.holders[t.holders.length - 1];
                if (last) sourcesOf(t.graph, last, keep);
            }
            acts.push({ ctl, targets });
        }
    }
    for (const { ctl, targets } of acts) {
        const off = ctl.mode === NEVER || ctl.mode === BYPASS;
        const want = off ? false : wantsMute(ctl);
        let status;
        if (!targets.length) {
            status = { text: "not in a group", tone: "dim" };
        } else {
            let count = 0;
            for (const t of targets) {
                const b = frame(t.group);
                const members = (t.graph._nodes ?? t.graph.nodes ?? []).filter(
                    (n) => n !== ctl && n.type !== TYPE && !keep.has(n)
                           && inside(centre(n), b));
                if (want === true) members.forEach((n) => muteSet.add(n));
                count += members.length;
            }
            const name = String(targets[0].group.title ?? "group")
                + (targets.length > 1 ? ` (+${targets.length - 1} more)` : "");
            status = off ? { text: "switched off: " + name + " left on", tone: "dim" }
                : want === true ? { text: `muting ${name} (${count})`, tone: "off" }
                : want === false ? { text: `running ${name} (${count})`, tone: "on" }
                : { text: "value not known before the run: " + name + " left on", tone: "warn" };
        }
        if (JSON.stringify(status) !== JSON.stringify(ctl.__obvpmMuteStatus)) {
            ctl.__obvpmMuteStatus = status;
        }
    }
    let changed = false;
    for (const graph of graphs) {
        let graphChanged = false;
        for (const n of graph._nodes ?? graph.nodes ?? []) {
            if (n.type === TYPE) continue;
            const mute = muteSet.has(n);
            if (mute && n.mode === ALWAYS) {
                setMode(n, NEVER);
                (n.properties ??= {})[FLAG] = true;
                graphChanged = true;
            } else if (!mute && n.properties?.[FLAG]) {
                if (n.mode === NEVER) setMode(n, ALWAYS);
                delete n.properties[FLAG];
                graphChanged = true;
            }
        }
        if (graphChanged) {
            changed = true;
            graph.setDirtyCanvas?.(true, true);
        }
    }
    // what reads modes (the Value Presets fades) refreshes on this
    if (changed && typeof window !== "undefined") {
        window.dispatchEvent?.(new CustomEvent("obvpm:modes-changed"));
    }
    return changed;
}

let timer = null;
function root() {
    return app.rootGraph ?? app.graph;
}

app.registerExtension({
    name: "obvpm.mute_group_if",
    setup() {
        // right before every prompt is built: a queued run always matches
        const toPrompt = app.graphToPrompt;
        if (typeof toPrompt === "function") {
            app.graphToPrompt = async function (...args) {
                try {
                    applyMuteGroups(root());
                } catch (err) {
                    console.error("[obvpm] Mute Group If:", err);
                }
                return toPrompt.apply(this, args);
            };
        }
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== TYPE) return;
        // As tall as its widgets. Litegraph sizes a node from its slot
        // rows -- at least one, `max(inputs, outputs, 1)` -- plus its
        // widgets; this node has no outputs and its only inputs are the
        // widgets' own sockets, drawn in the widget rows, so that one row
        // was an empty strip under them. (A loaded node keeps the size it
        // was saved with.)
        const computeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (out) {
            const size = computeSize.call(this, out);
            const slots = (this.outputs?.length ?? 0) > 0
                || (this.inputs ?? []).some((i) => !i.widget);
            if (!slots) {
                const row = (typeof LiteGraph !== "undefined" && LiteGraph.NODE_SLOT_HEIGHT) || 20;
                size[1] = Math.max(0, size[1] - row);
            }
            return size;
        };
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            if (!timer) {
                const tick = () => {
                    try {
                        applyMuteGroups(root());
                    } catch (err) {
                        console.error("[obvpm] Mute Group If:", err);
                    }
                };
                timer = setInterval(tick, POLL_MS);
                // most values change on a click or a key: follow at once
                // rather than on the next poll (the click has landed by then)
                const soon = () => setTimeout(tick, 30);
                window.addEventListener("pointerup", soon, true);
                window.addEventListener("keyup", soon, true);
            }
            return r;
        };
    },
});
