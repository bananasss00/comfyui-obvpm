// Value Presets: USER presets -- presets kept in the user's own data
// folder under a Preset Type Id, shared by every workflow whose Value
// Presets node has the same Preset Type Id -- and the export / import
// file format.
//
// WHY. A workflow carries its presets inside itself, which is right for
// what the workflow ships with and wrong for what a user saves: the next
// version of the workflow is a new file, and every preset the user made
// stays behind in the old one. User presets live outside the workflow,
// in ComfyUI's per-user storage (user/<user>/obvpm/presets/<id>.json,
// through the frontend's own user-data API -- no route of ours), so a
// node with the same Preset Type Id finds them in any workflow, any
// version. The workflow's author sets the id, once.
//
// The workflow's own presets are untouched by all of this and still what
// the workflow ships; user presets are shown beside them, marked ★.
// What RUNS is still only the node's values, so a user preset is nothing
// the server has to know about.
//
// DATA ONLY. A user presets file and an export file are parsed with
// JSON.parse and checked for shape and size; nothing in them is ever
// run, and the presets they hold are the same {field: value} sets the
// node stores.

import { api } from "../../scripts/api.js";
import { filtersFrom } from "./value_presets_filter.js";

export const STAR = "★ ";
const DIR = "obvpm/presets/";
const FORMAT = "obvpm-value-presets";
const MAX_BYTES = 1024 * 1024;          // presets.py MAX_PRESET_BYTES
const MAX_PRESETS = 1000;

/** A Preset Type Id as stored on the node, or "" if it is not usable. */
export function cleanTypeId(text) {
    const name = String(text ?? "").trim();
    if (!name || name.length > 64) return "";
    // a file name inside the user's folder: letters, digits, space, - _ .
    // and never a path or a hidden file
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) return "";
    return name;
}

export function typeIdOf(node) {
    return cleanTypeId(node?.properties?.obvpm_presets_type_id);
}

export function isUserLabel(label) {
    return String(label ?? "").startsWith(STAR);
}

export function bareName(label) {
    return isUserLabel(label) ? String(label).slice(STAR.length) : String(label ?? "");
}

/** {name: {field: value}} from anything, keeping only well-formed sets. */
export function presetsFrom(value) {
    const out = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    let n = 0;
    for (const [name, set] of Object.entries(value)) {
        if (n >= MAX_PRESETS) break;
        const clean = String(name).trim();
        if (!clean || clean.length > 200 || clean === "custom" || isUserLabel(clean)) continue;
        if (!set || typeof set !== "object" || Array.isArray(set)) continue;
        const values = Object.create(null);
        for (const [field, v] of Object.entries(set)) {
            if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
                values[field] = v;
            }
        }
        out[clean] = values;
        n++;
    }
    return out;
}

// ---------------------------------------------------------------------
// the user presets store: one cached copy per id, read once, written through
// ---------------------------------------------------------------------

const libs = new Map();          // name -> {presets, loaded, loading}
const listeners = new Set();     // called with the Preset Type Id on change

export function onUserPresetsChange(fn) {
    listeners.add(fn);
}

function changed(name) {
    for (const fn of listeners) {
        try { fn(name); } catch (err) { console.error("[obvpm-presets] user presets listener:", err); }
    }
}

function entry(name) {
    let e = libs.get(name);
    if (!e) {
        e = { presets: Object.create(null), filters: Object.create(null),
              loaded: false, loading: null, error: null };
        libs.set(name, e);
    }
    return e;
}

/** The user presets as far as known right now (sync; may be empty
 *  until the first load lands). */
export function userPresets(name) {
    return name ? entry(name).presets : Object.create(null);
}

/** The user's dropdown filters kept with these user presets (sync, like
 *  userPresets): {field: {include, exclude}}. */
export function userFilters(name) {
    return name ? entry(name).filters : Object.create(null);
}

export function userPresetsError(name) {
    return name ? entry(name).error : null;
}

/** Read the user presets from the user's folder (once, unless `fresh`). */
export async function loadUserPresets(name, { fresh = false } = {}) {
    if (!name) return Object.create(null);
    const e = entry(name);
    if (e.loaded && !fresh) return e.presets;
    if (e.loading) return e.loading;
    e.loading = (async () => {
        try {
            const resp = await api.getUserData(DIR + name + ".json");
            if (resp.status === 404) {
                e.presets = Object.create(null);
                e.filters = Object.create(null);
                e.error = null;
            } else if (resp.status !== 200) {
                e.error = "could not read the user presets (" + resp.status + ")";
            } else {
                const text = await resp.text();
                if (text.length > MAX_BYTES) throw new Error("the user presets file is larger than 1 MB");
                const data = JSON.parse(text);
                e.presets = presetsFrom(data?.presets);
                e.filters = filtersFrom(data?.filters);
                e.error = null;
            }
        } catch (err) {
            e.error = "could not read the user presets: " + String(err?.message ?? err);
        } finally {
            e.loaded = true;
            e.loading = null;
        }
        changed(name);
        return e.presets;
    })();
    return e.loading;
}

/** Write the file: the presets and the filters, both parts every time
 *  (each save replaces one of them and keeps the other as read). */
async function writeFile(name, presets, filters) {
    const body = { format: FORMAT, version: 1, type_id: name, presets };
    if (Object.keys(filters).length) body.filters = filters;
    const text = JSON.stringify(body, null, 1);
    if (text.length > MAX_BYTES) throw new Error("the user presets would be larger than 1 MB");
    await api.storeUserData(DIR + name + ".json", text, {
        overwrite: true, stringify: false, throwOnError: true, full_info: false,
    });
    const e = entry(name);
    e.presets = presets;
    e.filters = filters;
    e.loaded = true;
    e.error = null;
    changed(name);
}

/** Read the file before a write that keeps part of it: never write over
 *  what could not be read. */
async function readBeforeWrite(name) {
    const e = entry(name);
    if (!e.loaded || e.error) await loadUserPresets(name, { fresh: !!e.error });
    if (e.error) throw new Error(e.error + " -- not saved, so nothing in it is lost");
    return e;
}

/** Replace the user presets and write the file (its filters kept). */
export async function saveUserPresets(name, presets) {
    if (!name) throw new Error("this node has no Preset Type Id (set one in config -> Presets)");
    const e = await readBeforeWrite(name);
    await writeFile(name, presetsFrom(presets), e.filters);
}

/** Replace the dropdown filters and write the file (its presets kept). */
export async function saveUserFilters(name, filters) {
    if (!name) throw new Error("this node has no Preset Type Id (set one in config -> Presets)");
    const e = await readBeforeWrite(name);
    await writeFile(name, e.presets, filtersFrom(filters));
}

// ---------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------

/** The export file's text. The fields are not in it: an import matches
 *  presets to the node's own fields by name. */
export function exportText({ typeId, presets }) {
    const body = { format: FORMAT, version: 1, presets: presetsFrom(presets) };
    if (typeId) body.type_id = typeId;
    return JSON.stringify(body, null, 1);
}

/** An export file's presets, or an error. (A `schema` an older export
 *  carries is ignored, as it always was.) */
export function parseImport(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return { error: "Nothing to import." };
    if (raw.length > MAX_BYTES) return { error: "The file is larger than 1 MB." };
    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        return { error: "Not a presets file (not valid JSON): " + err.message };
    }
    // an exported file, or a bare {name: {field: value}} map
    const presets = presetsFrom(data?.format === FORMAT ? data.presets : data);
    if (!Object.keys(presets).length) {
        return { error: "No presets found in it." };
    }
    return {
        presets,
        typeId: typeof data?.type_id === "string" ? data.type_id : "",
    };
}

/** The presets of `presets` named in `names`, in that order: an export or
 *  an import of only some of them (one preset, to share it). */
export function pickPresets(presets, names) {
    const out = Object.create(null);
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(presets, name)) out[name] = presets[name];
    }
    return out;
}

/** The name an export downloads as: the preset's own when it is the only
 *  one, else `fallback` (the Preset Type Id or the node's title). */
export function exportFileName(names, fallback) {
    const base = names.length === 1 ? names[0] : fallback;
    const safe = String(base ?? "").replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[._]+|[._]+$/g, "");
    return (safe || "presets") + ".presets.json";
}

/** Merge `incoming` into `into`: replace or keep both (renamed "name 2"). */
export function mergePresets(into, incoming, mode) {
    const out = Object.assign(Object.create(null), into);
    const added = [];
    for (const [name, set] of Object.entries(incoming)) {
        let target = name;
        if (mode === "keep" && Object.prototype.hasOwnProperty.call(out, name)) {
            let n = 2;
            while (Object.prototype.hasOwnProperty.call(out, `${name} ${n}`)) n++;
            target = `${name} ${n}`;
        }
        out[target] = set;
        added.push(target);
    }
    return { presets: out, added };
}

/** Offer a text as a file download. */
export function download(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
