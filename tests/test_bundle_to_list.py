"""Bundle to List: a bundle's values as a real ComfyUI list.

A list is declared by an output socket (OUTPUT_IS_LIST), so it cannot
come out of an Unbundle; this node is where it is declared. The case it
was made for is Load Images & Compose's extras -> images_bundle: the
layers, each at its own size, one list item each.

Runs without ComfyUI: `nodes` is stubbed as in test_bundle_pool.py.
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

from obvpm_testpack import bundle  # noqa: E402


class BundleToList(unittest.TestCase):
    def test_the_output_is_declared_a_list(self):
        self.assertEqual(bundle.BundleToList.OUTPUT_IS_LIST, (True,))
        self.assertEqual(len(bundle.BundleToList.RETURN_TYPES), 1)
        self.assertEqual(list(bundle.BundleToList.INPUT_TYPES()["required"]), ["in"])

    def test_values_come_out_in_field_order(self):
        (packed,) = bundle.Bundle().pack("b\na\nc", in_1=2, in_2=1, in_3=3)
        (values,) = bundle.BundleToList().to_list(**{"in": packed})
        self.assertEqual(values, [2, 1, 3])

    def test_an_unconnected_field_stays_in_its_place(self):
        # positions match the bundle's fields, so item k is field k
        (values,) = bundle.BundleToList().to_list(**{"in": {"x": 1, "y": None, "z": 3}})
        self.assertEqual(values, [1, None, 3])

    def test_a_nested_bundle_is_one_item(self):
        inner = {"image_0": "a", "image_1": "b"}
        (values,) = bundle.BundleToList().to_list(**{"in": {"inner": inner}})
        self.assertEqual(values, [inner])

    def test_an_empty_bundle_is_refused_by_name(self):
        with self.assertRaisesRegex(ValueError, "Bundle to List: the bundle is empty"):
            bundle.BundleToList().to_list(**{"in": {}})

    def test_a_miswire_is_refused(self):
        with self.assertRaisesRegex(ValueError, "Bundle to List: expected a bundle"):
            bundle.BundleToList().to_list(**{"in": [1, 2]})

    def test_registered_with_its_display_name(self):
        init = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('"BundleToList (obvpm)": BundleToList,', init)
        self.assertIn('"BundleToList (obvpm)": "Bundle to List",', init)


if __name__ == "__main__":
    unittest.main()
