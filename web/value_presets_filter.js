// Value Presets: DROPDOWN FILTERS -- a user's own short list of a
// field's dropdown, kept with their user presets (the `filters` part of
// user/<user>/obvpm/presets/<Preset Type Id>.json) and so shared by
// every node with that Preset Type Id, in every workflow.
//
// A DISPLAY FILTER, NOTHING MORE. The server never hears of it: the
// schema, presets and the run still take every entry of the list, so a
// preset (or someone else's workflow) holding a file the user hid still
// applies and runs. Two rules keep it from ever hiding what matters:
// the value the field holds is always listed, and a filter that would
// leave nothing is not applied at all.
//
// Pure: no frontend imports, so the tests run it as it is.

const MAX_PATTERNS = 50;
const MAX_PATTERN = 200;
const MAX_FIELDS = 200;

/** Patterns from text: one per line, blank lines dropped. */
export function patternsFrom(text) {
    return String(text ?? "").split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
        .slice(0, MAX_PATTERNS).map((p) => p.slice(0, MAX_PATTERN));
}

/** {field: {include: [...], exclude: [...]}} from anything, well-formed
 *  entries only (a field with neither list is dropped). */
export function filtersFrom(value) {
    const out = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    let n = 0;
    for (const [field, f] of Object.entries(value)) {
        if (n >= MAX_FIELDS) break;
        if (!field || field.length > 200 || !f || typeof f !== "object") continue;
        const list = (v) => (Array.isArray(v)
            ? patternsFrom(v.filter((p) => typeof p === "string").join("\n")) : []);
        const include = list(f.include);
        const exclude = list(f.exclude);
        if (!include.length && !exclude.length) continue;
        out[field] = { include, exclude };
        n++;
    }
    return out;
}

const fold = (text) => String(text ?? "").replace(/\\/g, "/").toLowerCase();
const cache = new Map();

/** A pattern as a test: case-insensitive, found ANYWHERE in the entry,
 *  `*` standing for any run of characters, \ and / the same. */
function tester(pattern) {
    let re = cache.get(pattern);
    if (!re) {
        const body = fold(pattern).split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        re = new RegExp(body);
        if (cache.size > 2000) cache.clear();
        cache.set(pattern, re);
    }
    return re;
}

export function matches(entry, pattern) {
    return tester(pattern).test(fold(entry));
}

/** Whether an entry passes: it matches ANY include (or there is none)
 *  and NO exclude. Order-free: an exclude always wins. */
export function passes(entry, filter) {
    const include = filter?.include ?? [];
    const exclude = filter?.exclude ?? [];
    if (include.length && !include.some((p) => matches(entry, p))) return false;
    return !exclude.some((p) => matches(entry, p));
}

/**
 * A list as the dropdown shows it: {choices, total, shown, ignored}.
 * `current` (the value the field holds) is always kept, in its place; a
 * filter that passes nothing else is ignored (`ignored` true) and the
 * whole list is shown.
 */
export function filterChoices(choices, filter, current) {
    const all = Array.isArray(choices) ? choices : [];
    const total = all.length;
    if (!filter || (!filter.include?.length && !filter.exclude?.length)) {
        return { choices: all, total, shown: total, ignored: false, active: false };
    }
    const passed = all.filter((c) => passes(String(c), filter));
    if (!passed.length) {
        return { choices: all, total, shown: total, ignored: true, active: true };
    }
    const now = current == null ? null : String(current);
    const kept = now == null || passed.some((c) => String(c) === now)
        ? passed : all.filter((c) => String(c) === now || passes(String(c), filter));
    return { choices: kept, total, shown: passed.length, ignored: false, active: true };
}

/** One line for a tooltip about a filtered list, or "". */
export function filterNote(result) {
    if (!result?.active) return "";
    if (result.ignored) {
        return "Your dropdown filter matches none of the " + result.total
            + " entries here, so all of them are listed (config -> Filters).";
    }
    if (result.shown === result.total) return "";
    return "Your dropdown filter lists " + result.shown + " of " + result.total
        + " entries (config -> Filters).";
}
