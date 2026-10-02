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
import { legacyCanvasBox } from "./obvpm_ui.js";

export const TYPE = "MuteGroupIf (obvpm)";
export const FLAG = "obvpm_group_muted";
const ALWAYS = 0;
const NEVER = 2;
const BYPASS = 4;
const POLL_MS = 400;
const STATUS_H = 22;

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

function centre(node) {
    const r = node.boundingRect;
    if (r && r.length >= 4) return [r[0] + r[2] / 2, r[1] + r[3] / 2];
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
 *  when any node's mode changed. Each controller gets `__obvpmMuteStatus`. */
export function applyMuteGroups(root) {
    let changed = false;
    for (const graph of graphsOf(root)) {
        const nodes = graph._nodes ?? graph.nodes ?? [];
        const muteSet = new Set();
        const exempt = new Set();
        for (const ctl of nodes) {
            if (ctl.type === TYPE) sourcesOf(graph, ctl, exempt);
        }
        for (const ctl of nodes) {
            if (ctl.type !== TYPE) continue;
            const group = groupOf(graph, ctl);
            const off = ctl.mode === NEVER || ctl.mode === BYPASS;
            const want = off ? false : wantsMute(ctl);
            let status;
            if (!group) {
                status = { text: "not in a group", tone: "dim" };
            } else {
                const b = frame(group);
                const members = nodes.filter((n) => n !== ctl && n.type !== TYPE && !exempt.has(n)
                                                    && inside(centre(n), b));
                if (want === true) members.forEach((n) => muteSet.add(n));
                const name = String(group.title ?? "group");
                status = off ? { text: "switched off: " + name + " left on", tone: "dim" }
                    : want === true ? { text: `muting ${name} (${members.length})`, tone: "off" }
                    : want === false ? { text: `running ${name} (${members.length})`, tone: "on" }
                    : { text: "value not known before the run: " + name + " left on", tone: "warn" };
            }
            if (JSON.stringify(status) !== JSON.stringify(ctl.__obvpmMuteStatus)) {
                ctl.__obvpmMuteStatus = status;
                ctl.__obvpmStatusWidget?.triggerDraw?.();
                ctl.setDirtyCanvas?.(true, false);
            }
        }
        let graphChanged = false;
        for (const n of nodes) {
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

const TONES = { on: "#69db7c", off: "#ffa94d", warn: "#ff6b6b", dim: null };

function addStatus(node) {
    const widget = {
        name: "status",
        type: "obvpm_mute_group_status",
        value: "",
        serialize: false,
        options: { serialize: false },
        computeSize: (width) => [width, STATUS_H],
        computeLayoutSize: () => ({ minHeight: STATUS_H, maxHeight: STATUS_H, minWidth: 0 }),
        draw(ctx, _node, width, y) {
            [width] = legacyCanvasBox(ctx, width, STATUS_H, false);
            const s = node.__obvpmMuteStatus ?? { text: "…", tone: "dim" };
            ctx.save();
            ctx.font = "12px sans-serif";
            ctx.textBaseline = "middle";
            ctx.fillStyle = TONES[s.tone] ?? (LiteGraph?.WIDGET_SECONDARY_TEXT_COLOR ?? "#999");
            let text = s.text;
            const room = (width || node.size[0]) - 20;
            while (text.length > 4 && ctx.measureText(text).width > room) text = text.slice(0, -2);
            if (text !== s.text) text = text.slice(0, -1) + "…";
            ctx.fillText(text, 10, y + STATUS_H / 2);
            ctx.restore();
        },
    };
    node.addCustomWidget(widget);
    Object.defineProperty(widget, "width", { configurable: true, get: () => undefined, set: () => {} });
    node.__obvpmStatusWidget = widget;
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
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            addStatus(this);
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
