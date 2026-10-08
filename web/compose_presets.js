// Load Images & Compose: PRESETS -- whole configurations (the layer list
// with its crops, aspects and mutes, and the sheet settings) kept in the
// user's own data folder, so a set of references used before is one pick
// away in any workflow.
//
// One file per preset, user/<user>/obvpm/compose_presets/<name>.json,
// through the frontend's own user-data API (no route of ours). The file
// name IS the preset's name, so a preset can be copied, renamed or
// shared by handling its file. The images themselves are not copied: a
// preset names files in the input folder, as the node does.
//
// DATA ONLY. Each file is parsed with JSON.parse and checked for shape
// and size; what a preset holds is the same values the node stores.

import { api } from "../../scripts/api.js";
import { parseLayers } from "./obvpm_image_limits.js";

const DIR = "obvpm/compose_presets/";
const FORMAT = "obvpm-compose-preset";
const MAX_BYTES = 1024 * 1024;
const MAX_PRESETS = 500;
const MAX_NAME = 64;
// names a file cannot have on Windows, whatever its extension
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

// the sheet settings a preset carries besides the layers
export const SETTINGS = ["max_megapixels", "background", "padding", "gap"];

let cache = null;           // {name: preset}, once read
let loading = null;
let loadError = "";
const listeners = new Set();

/** A preset name that is also a file name everywhere ("" when it is
 *  not one): no path or reserved characters, no trailing dot or space,
 *  at most 64 characters. */
export function cleanName(text) {
    const name = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > MAX_NAME) return "";
    if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) return "";
    if (RESERVED.test(name.split(".")[0])) return "";
    return name;
}

const fileOf = (name) => DIR + name + ".json";

/** One preset as stored, checked; null when it is not one. */
export function presetFrom(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    let layers;
    try {
        layers = parseLayers(JSON.stringify(value.layers ?? []));
    } catch (err) {
        return null;
    }
    const out = { layers };
    for (const key of SETTINGS) {
        const v = value[key];
        if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
        else if (typeof v === "string" && v.length <= 64) out[key] = v;
    }
    return out;
}

/** A preset file's text. */
export function presetText(preset) {
    return JSON.stringify({ format: FORMAT, version: 1, ...presetFrom(preset) }, null, 1);
}

/** The preset in a file's text, or null. */
export function presetFromText(text) {
    if (String(text ?? "").length > MAX_BYTES) return null;
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return null;
    }
    return data?.format === FORMAT ? presetFrom(data) : null;
}

/** The presets as far as known right now (empty until the first load). */
export function composePresets() {
    return cache ?? Object.create(null);
}

export function composePresetsError() {
    return loadError;
}

export function onComposePresetsChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function changed() {
    for (const fn of listeners) fn();
}

/** Read every preset file (once, unless `fresh`). A file that is not a
 *  preset is skipped, not fatal. */
export async function loadComposePresets({ fresh = false } = {}) {
    if (cache && !fresh) return cache;
    if (loading) return loading;
    loading = (async () => {
        const found = Object.create(null);
        try {
            const files = (await api.listUserDataFullInfo(DIR))
                .map((f) => String(f?.path ?? ""))
                .filter((p) => p.toLowerCase().endsWith(".json") && !p.includes("/"))
                .slice(0, MAX_PRESETS);
            await Promise.all(files.map(async (path) => {
                const name = cleanName(path.slice(0, -5));
                if (!name) return;
                const resp = await api.getUserData(DIR + path);
                if (resp.status !== 200) return;
                const preset = presetFromText(await resp.text());
                if (preset) found[name] = preset;
            }));
            loadError = "";
        } catch (err) {
            loadError = "could not read the compose presets: " + String(err?.message ?? err);
        } finally {
            loading = null;
        }
        cache = found;
        changed();
        return cache;
    })();
    return loading;
}

/** Write one preset, as its own file (replacing one of that name). */
export async function savePresetFile(name, preset) {
    const clean = cleanName(name);
    if (!clean) throw new Error("not a usable preset name");
    const text = presetText(preset);
    if (text.length > MAX_BYTES) throw new Error("the preset would be larger than 1 MB");
    await api.storeUserData(fileOf(clean), text, {
        overwrite: true, stringify: false, throwOnError: true, full_info: false,
    });
    cache = Object.assign(Object.create(null), composePresets(),
                          { [clean]: presetFrom(preset) });
    changed();
}

/** Delete one preset's file. */
export async function deletePresetFile(name) {
    const resp = await api.deleteUserData(fileOf(name));
    if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404) {
        throw new Error("the server answered " + resp.status);
    }
    const next = Object.assign(Object.create(null), composePresets());
    delete next[name];
    cache = next;
    changed();
}
