"""Value Presets: a preset name on a WIRE selects that preset (issue #20).

A picked preset only labels the values (the values run). A wired name
selects: the preset's saved values run, looked up among the workflow
presets and the user presets the browser puts in the prompt while the
input is wired. The server reads no folder.

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

SCHEMA = "steps: int 1..100 = 20\ncfg: float 0..10.0 = 3.0"
WORKFLOW = json.dumps({"fast": {"steps": 4, "cfg": 1.0}, "both": {"steps": 30}})
USER = json.dumps({"mine": {"steps": 12, "cfg": 2.5}, "both": {"steps": 50}})
HAND = json.dumps({"steps": 77, "cfg": 9.0})


def prompt(preset_input):
    """A prompt in which node 7's `preset` is `preset_input`."""
    return {"7": {"class_type": "ValuePresets (obvpm)", "inputs": {"preset": preset_input}}}


def run(name, wired=True, user=USER):
    node = presets.ValuePresets()
    out = node.pack(SCHEMA, name, HAND, WORKFLOW, "steps\ncfg",
                    user_presets=user, unique_id="7",
                    prompt=prompt(["3", 0] if wired else name))
    if isinstance(out, dict):
        return dict(out["result"][0]), out["ui"]["obvpm_preset_ran"][0]
    return dict(out[0]), None


class WiredPreset(unittest.TestCase):
    def test_a_picked_preset_is_only_a_label(self):
        bundle, ran = run("fast", wired=False)
        self.assertEqual(bundle, {"steps": 77, "cfg": 9.0})
        self.assertIsNone(ran)

    def test_a_wired_name_runs_the_workflow_presets_values(self):
        bundle, ran = run("fast")
        self.assertEqual(bundle, {"steps": 4, "cfg": 1.0})
        self.assertEqual(ran, "fast")

    def test_a_field_the_preset_lacks_takes_its_default(self):
        bundle, _ = run("both")          # the workflow's "both" wins over the user's
        self.assertEqual(bundle, {"steps": 30, "cfg": 3.0})

    def test_a_user_preset_by_name_or_by_star(self):
        self.assertEqual(run("mine"), ({"steps": 12, "cfg": 2.5}, "★ mine"))
        self.assertEqual(run("★ both"), ({"steps": 50, "cfg": 3.0}, "★ both"))

    def test_custom_runs_the_hand_set_values(self):
        bundle, ran = run("custom")
        self.assertEqual(bundle, {"steps": 77, "cfg": 9.0})
        self.assertIsNone(ran)

    def test_an_unknown_name_is_refused_with_the_names(self):
        with self.assertRaisesRegex(ValueError, "no preset named 'nope'.*both, fast, ★ both, ★ mine"):
            run("nope")

    def test_a_user_preset_without_the_browsers_copy_is_refused(self):
        with self.assertRaisesRegex(ValueError, "only sent from the browser"):
            run("mine", user="")

    def test_no_prompt_at_all_is_not_wired(self):
        node = presets.ValuePresets()
        (bundle,) = node.pack(SCHEMA, "fast", HAND, WORKFLOW, "steps\ncfg")
        self.assertEqual(dict(bundle), {"steps": 77, "cfg": 9.0})

    def test_the_bundle_carries_the_selected_values_for_overrides(self):
        node = presets.ValuePresets()
        out = node.pack(SCHEMA, "fast", HAND, WORKFLOW, "steps\ncfg", user_presets=USER,
                        unique_id="7", prompt=prompt(["3", 0]))
        self.assertEqual(out["result"][0].obvpm_values, {"steps": 4, "cfg": 1.0})

    def test_the_prompt_only_input_is_declared_last_and_hidden_inputs_asked(self):
        types_ = presets.ValuePresets.INPUT_TYPES()
        self.assertEqual(list(types_["optional"])[-1], "user_presets")
        self.assertEqual(types_["hidden"], {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"})


if __name__ == "__main__":
    unittest.main()
