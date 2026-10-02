"""Override Bundle Values: change some of a bundle's values, one at a time.

A bundle -- usually a Value Presets node's -- comes in; the same bundle
goes out with the fields you chose replaced. Which fields can be
overridden is picked in the node's config dialog; each chosen field gets
a toggle and a value (or, for a value no widget can hold -- an image, a
model, a latent -- an input socket: wire something in and it replaces
the field, leave it unwired and the bundle's own value passes).

THE BUNDLE COMING IN IS NEVER CHANGED. The same bundle often feeds
several nodes (a Set/Get pair hands one bundle to many), and editing it
in place would leak an override into every one of them. A new bundle
goes out.

FROM A VALUE PRESETS NODE the override is checked exactly as the preset
node checks its own values -- the same range, choices and decimals, the
same refusal of anything outside them -- because the bundle carries the
schema it was resolved from (bundle.SchemaBundle). The schema's `when`
lines are applied again as well: overriding a deciding field brings back
the fields it hides, with the values the preset node holds for them,
instead of passing their None on.

FROM ANY OTHER BUNDLE there is no schema, so an override takes the type
of the value it replaces (a whole number stays a whole number, a switch
stays true/false).

Like Value Presets, the node's signature never follows the fields: the
browser builds the rows and mirrors them into one JSON channel, `state`
(which fields are chosen, which are on, their values), and the sockets'
field names into `wires`. A saved workflow therefore stores everything
by NAME, never by position.
"""

import json
import logging

from . import presets as _presets
from .bundle import BUNDLE, SchemaBundle, _as_bundle
from .common import ANY, _lines

_LOG = logging.getLogger("obvpm")

NODE = "Override Bundle Values"
# the declared wire_N pool; the browser shows one socket per wired field
MAX_WIRES = 16


def _typed_like(current, value, name):
    """`value` as the type of the value it replaces (no schema to ask)."""
    what = "%s: override for %r" % (NODE, name)
    if isinstance(current, bool):
        return _presets._as_bool(value, name, "override")
    if isinstance(current, int):
        try:
            number = float(value)
        except (TypeError, ValueError):
            number = None
        if number is None or isinstance(value, bool) or number != int(number):
            raise ValueError("%s must be a whole number (got %r)." % (what, value))
        return int(number)
    if isinstance(current, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            raise ValueError("%s must be a number (got %r)." % (what, value))
    if isinstance(current, str) or current is None:
        if isinstance(value, (dict, list)):
            raise ValueError("%s must be a single value (got %s)."
                             % (what, type(value).__name__))
        return value if current is None else str(value)
    raise ValueError(
        "%s: %r holds %s, which no widget can set -- choose it as a wired "
        "field instead." % (NODE, name, type(current).__name__))


def apply_overrides(bundle, state, wires="", wired=None):
    """The bundle with the overrides in `state` (and the wired values)
    applied, as a NEW bundle. `state` is the node's JSON channel:
    {"fields": [...], "on": [...], "values": {name: value}}."""
    _as_bundle(bundle, NODE)
    st = _presets.load_store(state, "override state")
    on = [n for n in (st.get("on") or []) if isinstance(n, str)]
    values = st.get("values") if isinstance(st.get("values"), dict) else {}
    chosen = {n: values[n] for n in on if n in values}

    schema = getattr(bundle, "obvpm_schema", "")
    if schema:
        merged = dict(getattr(bundle, "obvpm_values", {}) or {})
        merged.update(chosen)
        off = getattr(bundle, "obvpm_disabled", frozenset())
        try:
            packed, _fields = _presets.resolve(schema, json.dumps(merged),
                                               disabled=off)
        except ValueError as why:
            raise ValueError("%s: %s" % (NODE, why)) from None
        out = SchemaBundle(packed, schema, merged, off)
        missing = sorted(n for n in chosen if n not in packed)
        if missing:
            _LOG.warning("%s: the preset has no field %s; not overridden",
                         NODE, ", ".join(missing))
    else:
        out = dict(bundle)
        for name, value in chosen.items():
            if name not in bundle:
                _LOG.warning("%s: the bundle has no field %r; adding it", NODE, name)
            out[name] = _typed_like(bundle.get(name), value, name)

    wired = wired or {}
    for i, name in enumerate(_lines(wires)[:MAX_WIRES], start=1):
        value = wired.get("wire_%d" % i)
        if value is not None:
            out[name] = value
    return out


class OverrideBundleValues:
    CATEGORY = "obvpm/bundle"
    FUNCTION = "override"
    RETURN_TYPES = (BUNDLE,)
    RETURN_NAMES = ("bundle",)
    DESCRIPTION = (
        "Overrides some of a bundle's values -- typically a Value Presets "
        "node's -- without touching the preset. Choose which fields may be "
        "overridden in the config dialog (the gear); each gets a toggle and "
        "a value, or, for a value no widget can hold (an image, a model), "
        "an input socket. Toggled off or unwired, the bundle's own value "
        "passes. From a Value Presets node, an override is checked against "
        "that node's schema (range, choices) and its 'when' lines apply "
        "again. The bundle coming in is never changed; a new one goes out.")
    OUTPUT_TOOLTIPS = ("The bundle with the overrides applied (a new bundle; "
                       "the incoming one is untouched).",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            # owned by the UI and hidden there (see the module docstring)
            "state": ("STRING", {"default": "{}", "multiline": True}),
            "wires": ("STRING", {"default": "", "multiline": True}),
        }
        for i in range(1, MAX_WIRES + 1):
            optional["wire_%d" % i] = (ANY, {
                "tooltip": "A value for the field this socket is named "
                           "after; it replaces the bundle's. Unwired, the "
                           "bundle's own value passes."})
        # LAST: widgets_values is positional, and a save from before it
        # existed holds the two above. The constant's name while "set to
        # constant" is on (the config dialog), as on a Value Presets
        # node -- see web/obvpm_constants.js.
        optional["set"] = ("STRING", {
            "default": "",
            "tooltip": "The name other nodes get this bundle by (an "
                       "Unbundle with 'get', or a KJNodes Get). Turned on "
                       "in the config dialog."})
        return {
            "required": {
                "bundle": (BUNDLE, {
                    "tooltip": "The bundle to override values of -- from a "
                               "Value Presets node, a Bundle, or a Get."}),
            },
            "optional": optional,
        }

    def override(self, bundle, state="{}", wires="", set="", **wired):
        # `set` is a name for the browser to join nodes by; nothing to do
        # with it here
        return (apply_overrides(bundle, state, wires, wired),)
