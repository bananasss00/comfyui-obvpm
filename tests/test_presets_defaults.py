"""Value Presets: a borrowed dropdown whose default is not on this machine
keeps its dropdown (the first entry, said on hover) instead of turning
into a text field; an explicit list's wrong default is still an error.
And the node takes its `set` name without it changing what runs.

Runs without ComfyUI: `nodes` is stubbed as in test_presets_when.py.
"""

import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if "obvpm_testpack" not in sys.modules:
    pack = types.ModuleType("obvpm_testpack")
    pack.__path__ = [str(ROOT)]
    sys.modules[pack.__name__] = pack
try:
    import torch  # noqa: F401
except ImportError:
    sys.modules.setdefault("torch", types.ModuleType("torch"))
if "nodes" not in sys.modules:
    stub = types.ModuleType("nodes")
    stub.NODE_CLASS_MAPPINGS = {}
    sys.modules["nodes"] = stub

from obvpm_testpack import presets  # noqa: E402


class Unet:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"unet_name": (["h3\\model_a.safetensors",
                                            "model_b.safetensors"],)}}


def install(**classes):
    mapping = sys.modules["nodes"].NODE_CLASS_MAPPINGS
    mapping.clear()
    mapping.update(classes)


class BorrowedDefaults(unittest.TestCase):
    def setUp(self):
        install(Unet=Unet)

    def test_a_default_that_is_here_is_used(self):
        (f,) = presets.describe("model: @Unet.unet_name = model_b.safetensors")
        self.assertEqual(f["choices"], ["h3\\model_a.safetensors", "model_b.safetensors"])
        self.assertEqual(f["default"], "model_b.safetensors")
        self.assertNotIn("error", f)

    def test_a_default_that_is_not_here_keeps_the_dropdown(self):
        (f,) = presets.describe("model: @Unet.unet_name = model_c   # the model")
        self.assertEqual(f["choices"], ["h3\\model_a.safetensors", "model_b.safetensors"])
        self.assertEqual(f["default"], "h3\\model_a.safetensors")
        self.assertNotIn("error", f)
        # the note is its own key: the hint is what the schema says, and
        # the editor writes it back (issue #21)
        self.assertIn("'model_c'", f["note"])
        self.assertEqual(f["hint"], "the model")

    def test_a_default_that_is_here_has_no_note(self):
        (f,) = presets.describe("model: @Unet.unet_name = model_b.safetensors # the model")
        self.assertNotIn("note", f)

    def test_the_run_uses_the_first_entry_too(self):
        packed, _ = presets.resolve("model: @Unet.unet_name = model_c", "{}")
        self.assertEqual(packed["model"], "h3\\model_a.safetensors")

    def test_a_stored_value_that_is_not_here_is_still_refused(self):
        with self.assertRaisesRegex(ValueError, "not one of its"):
            presets.resolve("model: @Unet.unet_name",
                            json.dumps({"model": "gone.safetensors"}))

    def test_an_explicit_lists_wrong_default_is_still_an_error(self):
        (f,) = presets.describe("mode: choice a, b = c")
        self.assertIn("error", f)
        self.assertIsNone(f["choices"])


class SetName(unittest.TestCase):
    def test_the_set_name_changes_nothing_that_runs(self):
        node = presets.ValuePresets()
        (a,) = node.pack("steps: int = 20", "custom", "{}", "{}", "steps")
        (b,) = node.pack("steps: int = 20", "custom", "{}", "{}", "steps", set="engine")
        self.assertEqual(dict(a), dict(b))

    def test_set_is_declared_after_the_older_inputs(self):
        # widgets_values is positional: inputs only ever join at the end
        # (`disabled`, after `set`, came later still; then `user_presets`)
        optional = list(presets.ValuePresets.INPUT_TYPES()["optional"])
        self.assertEqual(optional, ["values", "presets", "names", "set", "disabled",
                                    "user_presets"])


if __name__ == "__main__":
    unittest.main()
