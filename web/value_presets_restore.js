/**
 * What "load settings" (comfyui-obvpm-timeline) would change on a Value
 * Presets node, as rows a person can decide on one by one -- instead of
 * the node's raw widgets, where the whole `values` JSON is one row and a
 * schema edit is a wall of text.
 *
 *   schema    one row, OFF by default: a schema is the node's design, not
 *             a setting of the take. Its details list each field that
 *             changed and what about it (type, default, when, tooltip).
 *   presets   one row per workflow preset that differs, OFF by default,
 *             its details listing the values that differ.
 *   preset    the chooser's label, when it differs.
 *   values    one row per field whose value differs, ON by default --
 *             these are the take's settings, the point of loading.
 *   set       the "set to constant" name, when it differs.
 *
 * Pure: plain values in, plain rows out, so it is tested without a
 * browser (tests/test_presets_restore.mjs). value_presets.js wires it to
 * a node (obvpmRestoreRows / obvpmRestoreApply).
 */

// ------------------------------------------------------------ schema text

// The tails as presets.py's _split_tail takes them off: the hint first,
// at the FIRST whitespace-then-#, then `when` at the first ` when `.
const HINT_AT = /\s#/;
const WHEN_AT = /\swhen\s/;

/**
 * A schema line -> its parts, the way the server reads it. Lenient: a
 * line the server would reject still gets parts here, since this only
 * says what differs, it never decides what is valid.
 */
export function parseSchemaLine(line) {
    const text = String(line ?? "").trim();
    const colon = text.indexOf(":");
    if (colon < 0) return null;
    const name = text.slice(0, colon).trim();
    if (!name) return null;
    let rest = text.slice(colon + 1).trim();
    let hint = "";
    const h = HINT_AT.exec(rest);
    if (h) {
        hint = rest.slice(h.index + h[0].length).trim();
        rest = rest.slice(0, h.index).trimEnd();
    }
    let when = "";
    const w = WHEN_AT.exec(rest);
    if (w) {
        when = rest.slice(w.index + w[0].length).trim();
        rest = rest.slice(0, w.index).trimEnd();
    }
    // everything before the first '=' is the type (with its range or
    // choices or @ref), everything after it the default
    const eq = rest.indexOf("=");
    const type = (eq < 0 ? rest : rest.slice(0, eq)).trim().replace(/\s+/g, " ");
    const def = eq < 0 ? "" : rest.slice(eq + 1).trim();
    return { name, type, def, when, hint, line: text };
}

/** The schema's fields in order, by name (a repeated name keeps the first). */
export function parseSchema(text) {
    const out = new Map();
    for (const raw of String(text ?? "").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const f = parseSchemaLine(line);
        if (f && !out.has(f.name)) out.set(f.name, f);
    }
    return out;
}

const PARTS = [["type", "type"], ["def", "default"], ["when", "shown when"],
               ["hint", "tooltip"]];
const NONE = "(none)";

/**
 * Field-by-field: what the saved schema would change about the current
 * one. Lines of { what, from, to }, plus counts for the row's summary.
 */
export function schemaChanges(current, saved) {
    const now = parseSchema(current), then = parseSchema(saved);
    const lines = [];
    let added = 0, removed = 0, changed = 0;
    for (const [name, f] of then) {
        const was = now.get(name);
        if (!was) {
            added += 1;
            lines.push({ what: name, from: "(not in the current schema)", to: f.line });
            continue;
        }
        let differs = false;
        for (const [key, label] of PARTS) {
            if (was[key] === f[key]) continue;
            differs = true;
            lines.push({ what: name + " · " + label,
                         from: was[key] || NONE, to: f[key] || NONE });
        }
        if (differs) changed += 1;
    }
    for (const [name, f] of now) {
        if (then.has(name)) continue;
        removed += 1;
        lines.push({ what: name, from: f.line, to: "(removed)" });
    }
    // the same fields in another order still changes the node's face
    const common = (m, other) => [...m.keys()].filter((n) => other.has(n));
    const a = common(now, then), b = common(then, now);
    if (a.join("\n") !== b.join("\n")) {
        lines.push({ what: "field order", from: a.join(", "), to: b.join(", ") });
    }
    const bits = [];
    if (changed) bits.push(changed + " changed");
    if (added) bits.push(added + " added");
    if (removed) bits.push(removed + " removed");
    if (!bits.length && lines.length) bits.push("fields reordered");
    return { lines, summary: bits.join(", "), differs: lines.length > 0 };
}

// ---------------------------------------------------------------- values

function parseObject(text) {
    try {
        const v = JSON.parse(String(text ?? "") || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (err) {
        return null;
    }
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** How a value reads in the dialog: text as is, the rest as JSON. */
export function valueText(v) {
    if (v === undefined) return "(unset)";
    if (typeof v === "string") return v === "" ? '""' : v;
    try {
        return JSON.stringify(v);
    } catch (err) {
        return String(v);
    }
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A preset's values that differ, as lines. */
function presetLines(now, then) {
    const lines = [];
    const keys = [...new Set([...Object.keys(then), ...Object.keys(now)])];
    for (const k of keys) {
        const a = has(now, k) ? now[k] : undefined;
        const b = has(then, k) ? then[k] : undefined;
        if (same(a, b)) continue;
        lines.push({ what: k, from: a === undefined ? "(not set)" : valueText(a),
                     to: b === undefined ? "(not set)" : valueText(b) });
    }
    return lines;
}

/**
 * The rows. `live` and `saved` hold the node's declared widgets by name
 * (schema, preset, values, presets, set); `fields` is the set of field
 * names the node shows now; `wired` answers whether a widget is fed by a
 * wire (a wired widget's value is dead -- the wire supplies it).
 *
 * Each row: { key, what, from, to, checked, details? } with details
 * { summary, lines: [{ what, from, to }] } -- shown collapsed.
 */
export function restoreRows(live, saved, fields, wired = () => false) {
    // the take's settings first; the node's design (schema, presets) after
    // them, since those are the rows people usually leave alone
    const rows = [], design = [];
    const differs = (name) => has(saved, name) && saved[name] !== undefined
        && !wired(name) && !same(live[name], saved[name]);

    if (differs("schema")) {
        const s = schemaChanges(live.schema, saved.schema);
        if (s.differs) {
            design.push({ key: "schema", what: "schema", checked: false,
                        from: "the current schema",
                        to: "the take's schema: " + s.summary,
                        details: { summary: s.lines.length + " change(s) by field",
                                   lines: s.lines } });
        }
    }

    if (differs("presets")) {
        const now = parseObject(live.presets), then = parseObject(saved.presets);
        if (now && then) {
            const names = [...new Set([...Object.keys(then), ...Object.keys(now)])];
            for (const name of names) {
                const a = has(now, name) ? now[name] : undefined;
                const b = has(then, name) ? then[name] : undefined;
                if (same(a, b)) continue;
                const count = (o) => Object.keys(o ?? {}).length;
                const lines = presetLines(a ?? {}, b ?? {});
                design.push({
                    key: "preset:" + name, what: "preset “" + name + "”",
                    checked: false,
                    from: a === undefined ? "(not in this workflow)" : count(a) + " value(s)",
                    to: b === undefined ? "(deleted in the take)"
                        : a === undefined ? "added, " + count(b) + " value(s)"
                        : lines.length + " value(s) differ",
                    details: { summary: lines.length + " value(s)", lines },
                });
            }
        } else {
            // unreadable on one side: offered whole, the way it is stored
            design.push({ key: "presets", what: "presets", checked: false,
                        from: valueText(live.presets), to: valueText(saved.presets) });
        }
    }

    if (differs("preset")) {
        rows.push({ key: "preset", what: "preset", checked: true,
                    from: valueText(live.preset), to: valueText(saved.preset) });
    }

    if (differs("values")) {
        const now = parseObject(live.values), then = parseObject(saved.values);
        if (now && then) {
            for (const [name, v] of Object.entries(then)) {
                if (has(now, name) && same(now[name], v)) continue;
                const known = fields.has(name);
                rows.push({
                    key: "value:" + name,
                    // a value for a field this node does not show would be
                    // dropped by its next build -- unless the schema row
                    // brings the field back, which is the user's call
                    what: known ? name : name + " (not in the current schema)",
                    checked: known,
                    from: has(now, name) ? valueText(now[name]) : "(not set)",
                    to: valueText(v),
                });
            }
        } else {
            rows.push({ key: "values", what: "values", checked: true,
                        from: valueText(live.values), to: valueText(saved.values) });
        }
    }

    if (differs("set")) {
        rows.push({ key: "set", what: "set_constant", checked: true,
                    from: valueText(live.set), to: valueText(saved.set) });
    }
    return [...rows, ...design];
}

/**
 * What applying the ticked rows makes of the node's stored widgets: the
 * new text for each widget that changes ({ schema?, preset?, values?,
 * presets?, set? }). Merged row by row into what the node holds NOW, so
 * an unticked value or preset keeps the current one.
 */
export function restoreWrites(live, saved, keys) {
    const out = {};
    if (keys.has("schema")) out.schema = saved.schema;
    if (keys.has("preset")) out.preset = saved.preset;
    if (keys.has("set")) out.set = saved.set;
    if (keys.has("presets")) out.presets = saved.presets;
    if (keys.has("values")) out.values = saved.values;

    const presetKeys = [...keys].filter((k) => k.startsWith("preset:"));
    if (presetKeys.length) {
        const now = parseObject(live.presets) ?? {};
        const then = parseObject(saved.presets) ?? {};
        for (const k of presetKeys) {
            const name = k.slice("preset:".length);
            if (has(then, name)) now[name] = then[name];
            else delete now[name];
        }
        out.presets = JSON.stringify(now);
    }
    const valueKeys = [...keys].filter((k) => k.startsWith("value:"));
    if (valueKeys.length) {
        const now = parseObject(live.values) ?? {};
        const then = parseObject(saved.values) ?? {};
        for (const k of valueKeys) {
            const name = k.slice("value:".length);
            if (has(then, name)) now[name] = then[name];
        }
        out.values = JSON.stringify(now);
    }
    return out;
}
