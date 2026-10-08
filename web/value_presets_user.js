// Value Presets: USER presets -- presets kept in the user's own data
// folder under a Preset Type Id, shared by every workflow whose Value
// Presets node has the same Preset Type Id -- and the export / import
// file format.
//
// WHY. A workflow carries its presets inside itself, which is right for
// what the workflow ships with and wrong for what a user saves: the next
// version of the workflow is a new file, and every preset the user made
// stays behind in the old one. User presets live outside the workflow,
// in ComfyUI's per-user storage, through the frontend's own user-data
// API (no route of ours), so a node with the same Preset Type Id finds
// them in any workflow, any version. The workflow's author sets the id,
// once.
//
// ONE FILE PER PRESET:
//   user/<user>/obvpm/presets/<id>/<name>.json   a preset each
//   user/<user>/obvpm/presets/<id>.json          the id's settings (the
//                                                dropdown filters)
// A save writes only the presets that changed, and a delete removes
// only its own file -- so two browser tabs saving different presets no
// longer write over each other, a damaged file costs one preset, and a
// preset can be shared or tidied away as a file. The file NAME is only a
// safe spelling of the preset's name; the name itself is inside the
// file, so any name a preset can have survives. An export of a preset is
// the same file, so a downloaded preset can be dropped into the folder.
//
// Older versions kept the presets all in <id>.json; the first read moves
// them out into their own files (and removes them from <id>.json only
// once every one is written).
//
// The workflow's own presets are untouched by all of this and still what
// the workflow ships; user presets are shown beside them, marked ★.
// What RUNS is still only the node's values, so a user preset is nothing
// the server has to know about.
//
// DATA ONLY. Every file is parsed with JSON.parse and checked for shape
// and size; nothing in them is ever run, and the presets they hold are
// the same {field: value} sets the node stores.

import { api } from "../../scripts/api.js";
import { filtersFrom } from "./value_presets_filter.js";

export const STAR = "★ ";
const DIR = "obvpm/presets/";
const FORMAT = "obvpm-value-presets";       // <id>.json, and the old multi-preset export
const PRESET_FORMAT = "obvpm-value-preset";  // one preset: a folder file, an export
const MAX_BYTES = 1024 * 1024;               // presets.py MAX_PRESET_BYTES
const MAX_PRESETS = 1000;
const MAX_FILE_NAME = 64;
// names a file cannot have on Windows, whatever its extension
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

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

/** A preset name as presets may have it, or "" when it is not one. */
function cleanPresetName(name) {
    const clean = String(name ?? "").trim();
    if (!clean || clean.length > 200 || clean === "custom" || isUserLabel(clean)) return "";
    return clean;
}

/** One preset's values, well-formed only; null when it is not a set. */
function valuesFrom(set) {
    if (!set || typeof set !== "object" || Array.isArray(set)) return null;
    const values = Object.create(null);
    for (const [field, v] of Object.entries(set)) {
        if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
            values[field] = v;
        }
    }
    return values;
}

/** {name: {field: value}} from anything, keeping only well-formed sets. */
export function presetsFrom(value) {
    const out = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    let n = 0;
    for (const [name, set] of Object.entries(value)) {
        if (n >= MAX_PRESETS) break;
        const clean = cleanPresetName(name);
        const values = valuesFrom(set);
        if (!clean || !values) continue;
        out[clean] = values;
        n++;
    }
    return out;
}

/** A safe file name (no extension) for a preset name: path and reserved
 *  characters become _, no trailing dot or space, at most 64 long. */
export function fileStem(name) {
    let stem = String(name ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\s+/g, " ").trim().slice(0, MAX_FILE_NAME).replace(/[. ]+$/, "");
    if (!stem || stem.startsWith(".")) stem = "preset" + stem;
    if (RESERVED.test(stem.split(".")[0])) stem = "_" + stem;
    return stem;
}

/** One preset as a file's text: a folder file and an export alike. */
export function presetFileText({ typeId, name, values }) {
    const body = { format: PRESET_FORMAT, version: 1, name, values: valuesFrom(values) ?? {} };
    if (typeId) body.type_id = typeId;
    return JSON.stringify(body, null, 1);
}

/** {name, values} from a one-preset file's parsed JSON, or null. */
function presetOfFile(data, fallbackName) {
    if (data?.format !== PRESET_FORMAT) return null;
    const name = cleanPresetName(typeof data.name === "string" ? data.name : fallbackName);
    const values = valuesFrom(data.values);
    return name && values ? { name, values } : null;
}

// ---------------------------------------------------------------------
// the user presets store: one cached copy per id, read once, written through
// ---------------------------------------------------------------------

const libs = new Map();          // id -> {presets, files, filters, loaded, loading, error}
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
        // files: preset name -> its file, relative to the id's folder
        e = { presets: Object.create(null), files: Object.create(null),
              filters: Object.create(null), loaded: false, loading: null, error: null };
        libs.set(name, e);
    }
    return e;
}

/** The user presets as far as known right now (sync; may be empty
 *  until the first load lands). */
export function userPresets(name) {
    return name ? entry(name).presets : Object.create(null);
}

/** The user's dropdown filters for this id (sync, like userPresets):
 *  {field: {include, exclude}}. */
export function userFilters(name) {
    return name ? entry(name).filters : Object.create(null);
}

export function userPresetsError(name) {
    return name ? entry(name).error : null;
}

const folderOf = (name) => DIR + name + "/";
const settingsPath = (name) => DIR + name + ".json";

async function readText(path) {
    const resp = await api.getUserData(path);
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw new Error("the server answered " + resp.status + " for " + path);
    const text = await resp.text();
    if (text.length > MAX_BYTES) throw new Error(path + " is larger than 1 MB");
    return text;
}

async function writeText(path, text) {
    if (text.length > MAX_BYTES) throw new Error("the file would be larger than 1 MB");
    await api.storeUserData(path, text, {
        overwrite: true, stringify: false, throwOnError: true, full_info: false,
    });
}

/** <id>.json's text: the id's settings. No `presets` in it any more. */
function settingsText(name, filters) {
    const body = { format: FORMAT, version: 2, type_id: name };
    if (Object.keys(filters).length) body.filters = filters;
    return JSON.stringify(body, null, 1);
}

/** A file name in the id's folder for a new preset, not yet taken
 *  (compared without case: Windows folders do not tell them apart). */
function freeFile(e, presetName) {
    const taken = new Set(Object.values(e.files).map((f) => f.toLowerCase()));
    const stem = fileStem(presetName);
    let file = stem + ".json";
    for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${stem} ${n}.json`;
    return file;
}

/** Read the user presets from the user's folder (once, unless `fresh`). */
export async function loadUserPresets(name, { fresh = false } = {}) {
    if (!name) return Object.create(null);
    const e = entry(name);
    if (e.loaded && !fresh) return e.presets;
    if (e.loading) return e.loading;
    e.loading = (async () => {
        try {
            // the id's settings, and (from an older version) its presets
            const settings = await readText(settingsPath(name));
            const data = settings == null ? null : JSON.parse(settings);
            const filters = filtersFrom(data?.filters);
            const legacy = presetsFrom(data?.presets);
            // one file per preset; a file that is not one is skipped
            const presets = Object.create(null);
            const files = Object.create(null);
            const listed = (await api.listUserDataFullInfo(folderOf(name)))
                .map((f) => String(f?.path ?? ""))
                .filter((p) => p.toLowerCase().endsWith(".json") && !p.includes("/"))
                .sort((a, b) => a.localeCompare(b))
                .slice(0, MAX_PRESETS);
            const read = await Promise.all(listed.map(async (file) => {
                try {
                    const text = await readText(folderOf(name) + file);
                    return text == null ? null
                        : { file, preset: presetOfFile(JSON.parse(text), file.slice(0, -5)) };
                } catch (err) {
                    console.warn("[obvpm-presets] skipped " + file + ":", err);
                    return null;
                }
            }));
            for (const r of read) {
                // two files with one name inside: the first (by file name) wins
                if (!r?.preset || r.preset.name in presets) continue;
                presets[r.preset.name] = r.preset.values;
                files[r.preset.name] = r.file;
            }
            e.presets = presets;
            e.files = files;
            e.filters = filters;
            e.error = null;
            if (Object.keys(legacy).length) await moveOut(name, e, legacy);
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

/**
 * Presets still inside <id>.json (saved by an older version): each written as
 * its own file, then <id>.json rewritten without them -- only once all of
 * them are written, so a failure leaves them where they were (and listed).
 * A file already holding the same name and values is that preset; the
 * same name with other values is kept as "name 2".
 */
async function moveOut(name, e, legacy) {
    let failed = 0;
    for (const [preset, values] of Object.entries(legacy)) {
        const there = e.presets[preset];
        if (there && JSON.stringify(there) === JSON.stringify(values)) continue;
        let target = preset;
        for (let n = 2; target in e.presets; n++) target = `${preset} ${n}`;
        e.presets[target] = values;
        try {
            const file = freeFile(e, target);
            await writeText(folderOf(name) + file,
                            presetFileText({ typeId: name, name: target, values }));
            e.files[target] = file;
        } catch (err) {
            failed++;
            console.error("[obvpm-presets] could not move '" + preset + "' to its own file:", err);
        }
    }
    if (!failed) await writeText(settingsPath(name), settingsText(name, e.filters));
}

/** Read before a write: never write on top of what could not be read. */
async function readBeforeWrite(name) {
    const e = entry(name);
    if (!e.loaded || e.error) await loadUserPresets(name, { fresh: !!e.error });
    if (e.error) throw new Error(e.error + " -- not saved, so nothing there is lost");
    return e;
}

/**
 * Make the user presets `presets`, writing only what differs from what
 * was read: a changed or new preset's file is written, a removed one's
 * deleted (after the writes, so a rename is never a moment with neither).
 * A preset saved meanwhile from another tab is not this save's business
 * and is left alone.
 */
export async function saveUserPresets(name, presets) {
    if (!name) throw new Error("this node has no Preset Type Id (set one in config -> Presets)");
    const e = await readBeforeWrite(name);
    const next = presetsFrom(presets);
    for (const [preset, values] of Object.entries(next)) {
        const old = e.presets[preset];
        if (old && e.files[preset] && JSON.stringify(old) === JSON.stringify(values)) continue;
        const file = e.files[preset] ?? freeFile(e, preset);
        await writeText(folderOf(name) + file, presetFileText({ typeId: name, name: preset, values }));
        e.files[preset] = file;
        e.presets[preset] = values;
    }
    for (const preset of Object.keys(e.presets)) {
        if (preset in next) continue;
        const file = e.files[preset];
        if (file) {
            const resp = await api.deleteUserData(folderOf(name) + file);
            if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404) {
                throw new Error("could not delete " + file + " (the server answered " + resp.status + ")");
            }
        }
        delete e.files[preset];
        delete e.presets[preset];
    }
    // in the order asked (the chooser lists them so)
    e.presets = Object.assign(Object.create(null), next);
    changed(name);
}

/** Replace the dropdown filters and write <id>.json. */
export async function saveUserFilters(name, filters) {
    if (!name) throw new Error("this node has no Preset Type Id (set one in config -> Presets)");
    const e = await readBeforeWrite(name);
    const clean = filtersFrom(filters);
    await writeText(settingsPath(name), settingsText(name, clean));
    e.filters = clean;
    changed(name);
}

// ---------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------

/** The name a preset downloads as: the same file name it has in the
 *  presets folder, so it can be dropped in there. */
export function exportFileName(name) {
    return fileStem(name) + ".json";
}

/**
 * The presets in a file or a pasted text, or an error: a one-preset file
 * (an export, or a file from the presets folder), a multi-preset export
 * from an older version, or a bare {name: {field: value}} map.
 */
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
    const typeId = typeof data?.type_id === "string" ? data.type_id : "";
    if (data?.format === PRESET_FORMAT) {
        const one = presetOfFile(data, "imported");
        if (!one) return { error: "The preset in it is not readable." };
        return { presets: Object.assign(Object.create(null), { [one.name]: one.values }), typeId };
    }
    const presets = presetsFrom(data?.format === FORMAT ? data.presets : data);
    if (!Object.keys(presets).length) return { error: "No presets found in it." };
    return { presets, typeId };
}

/** Several files' presets as one: {presets, errors, typeIds}, from
 *  [label, text] pairs. A name that comes twice is kept twice ("name 2"). */
export function parseImports(texts) {
    let presets = Object.create(null);
    const errors = [];
    const typeIds = new Set();
    for (const [label, text] of texts) {
        const r = parseImport(text);
        if (r.error) {
            errors.push(label + ": " + r.error);
            continue;
        }
        if (r.typeId) typeIds.add(r.typeId);
        presets = mergePresets(presets, r.presets, "keep").presets;
    }
    return { presets, errors, typeIds: [...typeIds] };
}

/** The presets of `presets` named in `names`, in that order: an import
 *  of only some of a file's presets. */
export function pickPresets(presets, names) {
    const out = Object.create(null);
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(presets, name)) out[name] = presets[name];
    }
    return out;
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
