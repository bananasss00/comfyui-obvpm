"""Bundle / Unbundle: the declared pool of fields (issue #18).

The pool was 16, below Value Presets' 64 fields, so a big Value Presets
bundle could not be unbundled whole. It is 128 now: a bundle from any
Value Presets node fits one Unbundle, and fields past 16 pack and unpack.

Runs without ComfyUI: `nodes` is stubbed as in test_presets_when.py.
"""

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

from obvpm_testpack import bundle, presets  # noqa: E402


class BundlePool(unittest.TestCase):
    def test_the_pool_holds_any_value_presets_bundle(self):
        self.assertEqual(bundle.MAX_FIELDS, 128)
        self.assertGreaterEqual(bundle.MAX_FIELDS, presets.MAX_FIELDS)
        self.assertEqual(len(bundle.UnbundleAuto.RETURN_TYPES), 128)
        self.assertEqual(bundle.UnbundleAuto.RETURN_NAMES[-1], "out_128")
        self.assertIn("in_128", bundle.Bundle.INPUT_TYPES()["optional"])
        # declared LAST, after the whole pool: saves keep their widget positions
        self.assertEqual(list(bundle.Bundle.INPUT_TYPES()["optional"])[-1], "set")
        self.assertEqual(list(bundle.UnbundleAuto.INPUT_TYPES()["optional"])[-1], "get")

    def test_thirty_fields_pack_and_unpack(self):
        names = "\n".join(f"f{i}" for i in range(1, 31))
        values = {f"in_{i}": i * 10 for i in range(1, 31)}
        (packed,) = bundle.Bundle().pack(names, **values)
        self.assertEqual(len(packed), 30)
        self.assertEqual(packed["f30"], 300)
        out = bundle.UnbundleAuto().unpack(**{"in": packed})
        self.assertEqual(len(out), 128)
        self.assertEqual(out[:30], tuple(i * 10 for i in range(1, 31)))
        self.assertEqual(set(out[30:]), {None})

    def test_a_chosen_subset_past_sixteen(self):
        packed = {f"f{i}": i for i in range(1, 41)}
        out = bundle.UnbundleAuto().unpack(**{"in": packed, "names": "f40\nf17\nf3"})
        self.assertEqual(out[:3], (40, 17, 3))


if __name__ == "__main__":
    unittest.main()
