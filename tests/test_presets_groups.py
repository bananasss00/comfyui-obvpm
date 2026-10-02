"""Value Presets: `## Title` headings and fields switched off per node.

A heading is display only: the bundle, the store and the field order do
not change. A disabled field is hidden and None on the bundle, but the
fields its `when` decides read it at its default -- the engine settings
that turn `dual_stage` off on the upscale node must still show
`schedule ... when dual_stage = false` there.

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
from obvpm_testpack import overrides as ov  # noqa: E402

SCHEMA = """
# a comment, not a heading
steps: int 1..200 = 8
## Schedule
dual_stage: bool = false
schedule: choice full, first_x_steps = full when dual_stage = false
refine_amount: float 0..1.00 = 0.2
## First stage
first_stage_scale: float 0.25..1.00 = 0.5 when dual_stage = true
##
shift_video: int = 12
"""


class Groups(unittest.TestCase):
    def test_headings_group_the_fields_below_them(self):
        fields = presets.parse_schema(SCHEMA)
        self.assertEqual([(f.name, f.group) for f in fields], [
            ("steps", None), ("dual_stage", "Schedule"), ("schedule", "Schedule"),
            ("refine_amount", "Schedule"), ("first_stage_scale", "First stage"),
            ("shift_video", None)])

    def test_described_with_their_group(self):
        described = {f["name"]: f for f in presets.describe(SCHEMA)}
        self.assertEqual(described["schedule"]["group"], "Schedule")
        self.assertIsNone(described["steps"]["group"])

    def test_headings_change_nothing_the_bundle_holds(self):
        plain = "\n".join(l for l in SCHEMA.splitlines() if not l.startswith("##"))
        values = json.dumps({"dual_stage": True, "first_stage_scale": 0.7})
        self.assertEqual(presets.resolve(SCHEMA, values)[0],
                         presets.resolve(plain, values)[0])


class Disabled(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(presets.parse_disabled("dual_stage\n refine_amount ,x\n\n"),
                         {"dual_stage", "refine_amount", "x"})
        self.assertEqual(presets.parse_disabled(""), set())

    def test_hidden_and_none_whatever_is_stored(self):
        packed, _ = presets.resolve(SCHEMA, json.dumps({"refine_amount": 0.3}),
                                    disabled={"refine_amount"})
        self.assertIsNone(packed["refine_amount"])

    def test_it_still_decides_at_its_default(self):
        # stored true, but switched off on this node: the fields it decides
        # see its default (false), so `schedule` stays and the first stage
        # fields stay hidden
        packed, _ = presets.resolve(SCHEMA, json.dumps({"dual_stage": True}),
                                    disabled={"dual_stage"})
        self.assertIsNone(packed["dual_stage"])
        self.assertEqual(packed["schedule"], "full")
        self.assertIsNone(packed["first_stage_scale"])

    def test_the_label_check_skips_it(self):
        library = json.dumps({"p": {"refine_amount": 0.3}})
        with self.assertLogs("obvpm", level="INFO") as logged:
            presets._LOG.info("marker")
            presets.resolve(SCHEMA, json.dumps({"refine_amount": 0.9}), library, "p",
                            disabled={"refine_amount"})
        self.assertFalse([m for m in logged.output if "changed" in m], logged.output)

    def test_the_node_reads_its_widget_and_the_bundle_carries_it(self):
        (bundle,) = presets.ValuePresets().pack(
            SCHEMA, "custom", json.dumps({"refine_amount": 0.3}), "{}", "", "",
            "refine_amount")
        self.assertIsNone(bundle["refine_amount"])
        self.assertEqual(bundle.obvpm_disabled, frozenset({"refine_amount"}))
        # an override downstream re-resolves with it still off
        out = ov.apply_overrides(bundle, json.dumps(
            {"fields": ["steps"], "on": ["steps"], "values": {"steps": 4}}))
        self.assertEqual(out["steps"], 4)
        self.assertIsNone(out["refine_amount"])

    def test_disabled_is_the_last_input(self):
        optional = list(presets.ValuePresets.INPUT_TYPES()["optional"])
        self.assertEqual(optional[-2:], ["set", "disabled"])


if __name__ == "__main__":
    unittest.main()
