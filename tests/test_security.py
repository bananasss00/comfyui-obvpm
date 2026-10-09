"""Focused offline regressions. Run: python -m unittest discover -s tests -v.
Real tensor checks additionally run when Torch is available (embedded Python).
No ComfyUI server, registry imports, private data or network is needed.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
pack = types.ModuleType("obvpm_testpack")
pack.__path__ = [str(ROOT)]
sys.modules[pack.__name__] = pack
try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    sys.modules["torch"] = types.ModuleType("torch")

folders = types.ModuleType("folder_paths")
# Deliberately unsafe old-core methods: pack code must never call them.
folders.get_annotated_filepath = lambda name: name
folders.exists_annotated_filepath = lambda name: True
folders.get_input_directory = lambda: str(ROOT / "synthetic-missing-root")
folders.filter_files_content_types = lambda files, _: files
sys.modules["folder_paths"] = folders
helpers = types.ModuleType("node_helpers")
helpers.pillow = lambda fn, *args: fn(*args)
sys.modules["node_helpers"] = helpers
registry = types.ModuleType("nodes")
registry.NODE_CLASS_MAPPINGS = {}
sys.modules["nodes"] = registry

class Routes:
    handlers = {}
    def get(self, path):
        return lambda fn: self.handlers.setdefault(path, fn)
    post = get

server = types.ModuleType("server")
server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=Routes()))
sys.modules["server"] = server
from obvpm_testpack import image_safety as safety
from obvpm_testpack import load_image_crop as crop
from obvpm_testpack import compose_images as compose
from obvpm_testpack import presets as presets
presets.register()


class ImageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        for kind in ("input", "output", "temp"):
            root = self.base / kind
            root.mkdir()
            setattr(folders, "get_%s_directory" % kind, lambda root=root: str(root))
            (root / "nested").mkdir()
            Image.new("RGBA", (32, 16), (255, 0, 0, 128)).save(root / "nested" / "sample.png")
        self.name = "nested/sample.png"
        self.path = self.base / "input" / self.name
        self.outside = self.base / "outside.png"
        Image.new("RGB", (2, 2)).save(self.outside)

    def tearDown(self):
        # links first, each the link itself and never what it leads to
        for link in reversed(getattr(self, "_links", [])):
            if os.path.lexists(link):
                os.rmdir(link) if os.path.isdir(link) else os.unlink(link)
        self.temp.cleanup()

    def test_confined_annotations_and_unsafe_core_unused(self):
        with patch.object(folders, "get_annotated_filepath", side_effect=AssertionError), patch.object(folders, "exists_annotated_filepath", side_effect=AssertionError):
            for kind in ("input", "output", "temp"):
                name = self.name + " [%s]" % kind
                self.assertEqual(safety.image_path(name), str(self.base / kind / self.name))
                self.assertIs(crop.LoadImageCrop.VALIDATE_INPUTS(name), True)
                self.assertIs(compose.LoadImagesCompose.VALIDATE_INPUTS(json.dumps([name])), True)
                self.assertEqual(len(crop.LoadImageCrop.IS_CHANGED(name)), 64)
            self.assertEqual(safety.image_path(str(self.path)), str(self.path))
            self.assertEqual(safety.image_path("nested\\sample.png"), str(self.path))

    def test_path_attacks_all_entrypoints(self):
        for name in ("../outside.png", "nested/../../outside.png", "..\\outside.png", str(self.outside), "//server/share/a.png", "\\\\server\\share\\a.png", "C:relative.png", "nested/sample.png:stream", "bad\0.png", "nested", {}, 4):
            with self.subTest(name=name):
                with self.assertRaises((ValueError, OSError)):
                    safety.image_path(name)
                self.assertIsNot(crop.LoadImageCrop.VALIDATE_INPUTS(name), True)
                with self.assertRaises((ValueError, OSError)):
                    crop.LoadImageCrop.IS_CHANGED(name)
                with self.assertRaises((ValueError, OSError)):
                    crop.LoadImageCrop().load(name)

    def _link(self, link, target):
        """A link inside a root: a Windows junction for a folder (no admin
        rights needed), else a symlink. False when the host can make
        neither (symlinks need rights on Windows)."""
        if os.name == "nt" and target.is_dir():
            import subprocess
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
            if link.is_dir():
                self.__dict__.setdefault("_links", []).append(link)
                return True
        try:
            link.symlink_to(target, target_is_directory=target.is_dir())
        except OSError:
            return False
        self.__dict__.setdefault("_links", []).append(link)
        return True

    def test_a_link_inside_the_root_is_followed(self):
        # a library linked into the input folder from elsewhere loads like
        # any other image, the way core's Load Image treats it
        library = self.base / "library"
        (library / "set").mkdir(parents=True)
        Image.new("RGB", (2, 2)).save(library / "set" / "far.png")
        followed = 0
        if self._link(self.base / "input" / "lib", library):
            self.assertEqual(safety.image_path("lib/set/far.png"),
                             str(self.base / "input" / "lib" / "set" / "far.png"))
            followed += 1
        if self._link(self.base / "input" / "escape.png", self.outside):
            self.assertEqual(safety.image_path("escape.png"), str(self.base / "input" / "escape.png"))
            followed += 1
        if not followed:
            self.skipTest("host can make no links")

    def test_names_that_leave_the_root_are_refused_even_beside_a_link(self):
        library = self.base / "library"
        library.mkdir()
        Image.new("RGB", (2, 2)).save(library / "far.png")
        if not self._link(self.base / "input" / "lib", library):
            self.skipTest("host can make no links")
        for name in ("lib/../../library/far.png", "../library/far.png", str(library / "far.png"),
                     "lib/../../outside.png", "lib"):
            with self.subTest(name=name), self.assertRaises((ValueError, OSError)):
                safety.image_path(name)

    def test_input_listing_walks_links_and_keeps_real_folders(self):
        root = self.base / "input"
        (root / "deep" / "a" / "b").mkdir(parents=True)
        Image.new("RGB", (2, 2)).save(root / "deep" / "a" / "b" / "c.png")
        Image.new("RGB", (2, 2)).save(root / "top.png")
        (root / "notes.txt").write_text("not an image, still a file")
        (root / "empty").mkdir()
        (root / "big.png").write_bytes(b"x" * 4000)
        to_output = self._link(root / "jn_out", self.base / "output")
        # sorts BEFORE the real folder it leads to, and one leads back up
        to_nested = self._link(root / "a_alias", root / "nested")
        to_root = self._link(root / "deep" / "up", root)
        with patch.object(safety, "MAX_FILE_BYTES", 2000):
            listed = crop._input_images()
            for name in listed:
                safety.image_path(name)      # everything listed loads
        for name in ("deep/a/b/c.png", "nested/sample.png", "top.png", "notes.txt"):
            self.assertIn(name, listed)
        self.assertNotIn("big.png", listed)
        self.assertEqual(len(listed), len(set(listed)))
        if to_output:
            self.assertIn("jn_out/nested/sample.png", listed)
        if to_nested:
            self.assertNotIn("a_alias/sample.png", listed)    # the real folder keeps its name
        if to_root:
            self.assertFalse([n for n in listed if n.startswith("deep/up/")])   # no loop

    def test_input_listing_resolves_no_plain_file(self):
        # the cost of issue #22: realpath + stat per file; plain files must
        # be judged from the directory listing alone
        Image.new("RGB", (2, 2)).save(self.base / "input" / "top.png")
        with patch.object(crop, "image_path", side_effect=AssertionError("per-file resolve")):
            self.assertEqual(crop._input_images(), ["nested/sample.png", "top.png"])

    def test_input_listing_is_shared_for_a_moment(self):
        # ComfyUI calls INPUT_TYPES several times per prompt: one walk for
        # the burst, but an upload into the input folder shows at once
        root = self.base / "input"
        first = crop._input_images()
        Image.new("RGB", (2, 2)).save(root / "nested" / "later.png")
        with patch.object(crop, "_walk_input", side_effect=AssertionError("walked again")):
            self.assertEqual(crop._input_images(), first)
        Image.new("RGB", (2, 2)).save(root / "uploaded.png")
        self.assertIn("uploaded.png", crop._input_images())
        self.assertIn("nested/later.png", crop._input_images())
        with patch.object(crop, "LISTING_TTL", 0):
            (root / "nested" / "later.png").unlink()
            self.assertNotIn("nested/later.png", crop._input_images())

    def test_one_file_check_for_dropped_images(self):
        (self.base / "input" / "notes.txt").write_text("text")
        self.assertTrue(compose._input_image_known("nested/sample.png"))
        for name in ("missing.png", "../outside.png", str(self.outside), "nested", "", None):
            with self.subTest(name=name):
                self.assertFalse(compose._input_image_known(name))
        with patch.object(folders, "filter_files_content_types",
                          lambda files, _: [f for f in files if f.endswith(".png")]):
            self.assertFalse(compose._input_image_known("notes.txt"))

    def test_file_and_aggregate_limits_before_open(self):
        with patch.object(safety, "MAX_FILE_BYTES", 1), patch.object(safety.Image, "open", side_effect=AssertionError("must not decode")):
            with self.assertRaisesRegex(ValueError, "input-file"):
                safety.inspect_images([self.name])
            with self.assertRaises(ValueError):
                safety.hash_images([self.name])
        with patch.object(safety, "MAX_TOTAL_FILE_BYTES", self.path.stat().st_size), patch.object(safety.Image, "open", side_effect=AssertionError):
            with self.assertRaisesRegex(ValueError, "aggregate"):
                safety.inspect_images([self.name, self.name])

    def test_compose_with_no_images_passes_none_on(self):
        # an empty node is not an error: it outputs None, like an unconnected
        # optional input, so a spare Picture slot need not be bypassed
        with patch.object(compose, "_load_layer", side_effect=AssertionError("no decode")):
            for empty in ("", "[]", "  "):
                image, extras = compose.LoadImagesCompose().compose(empty)
                self.assertIsNone(image)
                self.assertEqual(extras, {"images": [], "selected_image": None,
                                          "images_bundle": {}})

    def test_compose_preflight_before_loading_any_layer(self):
        with patch.object(compose, "_load_layer", side_effect=AssertionError("no decode")):
            with self.assertRaises(ValueError):
                compose.LoadImagesCompose().compose(json.dumps([self.name] * 65))
            with patch.object(safety, "MAX_TOTAL_PIXELS", 700):
                with self.assertRaisesRegex(ValueError, "aggregate"):
                    compose.LoadImagesCompose().compose(json.dumps([self.name, self.name]))

    def test_hash_is_chunked_and_validates_all_before_reads(self):
        reads = []
        real_open = open
        class Reader:
            def __init__(self, path, mode): self.stream = real_open(path, mode)
            def __enter__(self): return self
            def __exit__(self, *_): self.stream.close()
            def read(self, size=-1):
                reads.append(size)
                self.assert_size(size)
                return self.stream.read(size)
            def assert_size(self, size):
                if not 0 < size <= 1024 * 1024: raise AssertionError(size)
        with patch("builtins.open", Reader):
            safety.hash_images([self.name])
            self.assertTrue(reads)
            reads.clear()
            with self.assertRaises(ValueError):
                safety.hash_images([self.name, "../outside.png"])
            self.assertFalse(reads)

    def test_layer_json_and_pixel_limits(self):
        self.assertEqual(compose._parse_layers(json.dumps([self.name])), [(self.name, None, None, False)])
        self.assertEqual(compose._parse_layers(json.dumps([{"image": self.name, "muted": True}])),
                         [(self.name, None, None, True)])
        # only a real true mutes: a stray string does not
        self.assertEqual(compose._parse_layers(json.dumps([{"image": self.name, "muted": "yes"}]))[0][3], False)
        with self.assertRaisesRegex(ValueError, "64 layers"):
            compose._parse_layers(json.dumps([self.name] * 65))
        with self.assertRaisesRegex(ValueError, "byte limit"):
            compose._parse_layers(" " * (safety.MAX_JSON_BYTES + 1))
        with patch.object(safety, "MAX_PIXELS", 511):
            with self.assertRaises(ValueError): safety.inspect_images([self.name])
        with patch.object(safety, "MAX_TOTAL_PIXELS", 700):
            with self.assertRaisesRegex(ValueError, "aggregate"):
                safety.inspect_images([self.name, self.name])

    def animation(self, frames=3):
        images = [Image.new("RGB", (16, 8), (n % 256, n // 256, 0)) for n in range(frames)]
        name = "animation.gif"
        images[0].save(self.base / "input" / name, save_all=True, append_images=images[1:], duration=20)
        return name

    def test_frame_limit(self):
        name = self.animation(129)
        with self.assertRaisesRegex(ValueError, "128 frame"):
            safety.inspect_images([name], animation=True)
    def test_gif_rectangles_refused_before_any_pillow_allocation(self):
        import re
        import struct
        frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
        out = io.BytesIO()
        frames[0].save(out, format="GIF", save_all=True, append_images=frames[1:], disposal=2)
        original = out.getvalue()
        pillow_limit = Image.MAX_IMAGE_PIXELS
        offsets = [m.start() for m in re.finditer(b",\x00\x00\x00\x00\x08\x00\x08\x00", original)]
        self.assertEqual(len(offsets), 2)
        for case in ("screen", "first", "later", "offset"):
            data = bytearray(original)
            if case == "screen":
                struct.pack_into("<HH", data, 6, 8192, 8192)
            elif case == "offset":
                struct.pack_into("<H", data, offsets[1] + 1, 16384)
            else:
                struct.pack_into("<HH", data, offsets[case == "later"] + 5, 8192, 8192)
            name = "disposal.gif"
            (self.base / "input" / name).write_bytes(data)
            with self.subTest(case=case), patch.object(Image.core, "fill", side_effect=AssertionError("pixel allocation before guard")) as fill, patch.object(Image, "open", wraps=Image.open) as opened:
                for call in (lambda: safety.inspect_images([name], animation=True),
                             lambda: safety.inspect_images([name]),
                             lambda: compose._load_layer(name, None),
                             lambda: crop.LoadImageCrop().load(name)):
                    with self.assertRaisesRegex(ValueError, "safety limit"):
                        call()
                opened.assert_not_called()
                fill.assert_not_called()
        self.assertEqual(Image.MAX_IMAGE_PIXELS, pillow_limit)

    def test_apng_disposal_and_later_frame_preflight(self):
        import struct
        import zlib
        frames = [Image.new("RGBA", (8, 8), (n, 0, 0, 255)) for n in (0, 128)]
        out = io.BytesIO()
        frames[0].save(out, format="PNG", save_all=True, append_images=frames[1:], disposal=[1, 1])
        original = out.getvalue()
        chunks = []
        at = 8
        while at < len(original):
            size = int.from_bytes(original[at:at + 4], "big")
            chunks.append((original[at + 4:at + 8], at + 8, size))
            at += size + 12
        controls = [chunk for chunk in chunks if chunk[0] == b"fcTL"]
        self.assertEqual(len(controls), 2)
        for kind, start, size in [chunks[0], controls[0], controls[1]]:
            data = bytearray(original)
            offset = start if kind == b"IHDR" else start + 4
            struct.pack_into(">II", data, offset, 8192, 8192)
            struct.pack_into(">I", data, start + size, zlib.crc32(data[start - 4:start + size]))
            name = "disposal.png"
            (self.base / "input" / name).write_bytes(data)
            with self.subTest(chunk=kind, offset=start), patch.object(Image.core, "fill", side_effect=AssertionError("APNG allocation before guard")) as fill, patch.object(Image, "open", wraps=Image.open) as opened:
                with self.assertRaises(ValueError): safety.inspect_images([name], animation=True)
                opened.assert_not_called()
                fill.assert_not_called()

    def test_webp_dimensions_before_native_decoder_construction(self):
        from PIL import WebPImagePlugin, features
        if not features.check("webp"):
            self.skipTest("Pillow lacks WebP support")
        frame = Image.new("RGB", (8, 8), "red")
        cases = []
        for lossless in (False, True):
            out = io.BytesIO()
            frame.save(out, format="WEBP", lossless=lossless)
            data = bytearray(out.getvalue())
            kind = b"VP8L" if lossless else b"VP8 "
            at = data.index(kind) + 8
            if lossless:
                bits = int.from_bytes(data[at + 1:at + 5], "little")
                bits = (bits & 0xf0000000) | 8191 | (8191 << 14)
                data[at + 1:at + 5] = bits.to_bytes(4, "little")
            else:
                data[at + 6:at + 10] = (8192).to_bytes(2, "little") * 2
            cases.append(data)
        out = io.BytesIO()
        frame.save(out, format="WEBP", save_all=True, append_images=[Image.new("RGB", (8, 8), "blue")], lossless=True)
        original = out.getvalue()
        data = bytearray(original)
        at = data.index(b"VP8X") + 8
        data[at + 4:at + 10] = (8191).to_bytes(3, "little") * 2
        cases.append(data)
        data = bytearray(original)
        at = data.index(b"ANMF", data.index(b"ANMF") + 4) + 8
        data[at + 6:at + 12] = (8191).to_bytes(3, "little") * 2
        cases.append(data)
        for index, data in enumerate(cases):
            name = "oversized.webp"
            (self.base / "input" / name).write_bytes(data)
            with self.subTest(case=index), patch.object(WebPImagePlugin._webp, "WebPAnimDecoder", side_effect=AssertionError("native allocation before guard")) as decoder:
                with self.assertRaises(ValueError): safety.inspect_images([name], animation=True)
                decoder.assert_not_called()

    def test_preflight_preserves_normal_containers_and_animations(self):
        from PIL import features
        formats = ["GIF", "PNG", "TIFF"]
        if features.check("webp"):
            formats.append("WEBP")
        frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
        for image_format in formats:
            name = "normal." + image_format.lower()
            frames[0].save(self.base / "input" / name, format=image_format, save_all=True, append_images=frames[1:])
            paths, counts = safety.inspect_images([name], animation=True)
            self.assertEqual(counts, [2], image_format)
            with safety.open_checked_image(paths[0]) as image:
                image.seek(1)
                self.assertEqual(image.convert("RGB").size, (8, 8))
            if HAS_TORCH:
                images, masks = crop.LoadImageCrop().load(name)
                self.assertEqual(tuple(images.shape), (2, 8, 8, 3))
                self.assertEqual(tuple(masks.shape), (2, 8, 8))
        for image_format in ("JPEG", "BMP"):
            name = "normal." + image_format.lower()
            frames[0].save(self.base / "input" / name, format=image_format)
            self.assertEqual(safety.inspect_images([name], animation=True)[1], [1])

    def test_container_work_bound(self):
        name = self.animation()
        with patch.object(safety, "MAX_CONTAINER_BLOCKS", 1), patch.object(Image, "open", side_effect=AssertionError("must not open")):
            with self.assertRaisesRegex(ValueError, "structural block limit"):
                safety.inspect_images([name])
    def test_numeric_safety(self):
        for value in (float("nan"), float("inf"), -1, 1e300):
            with self.assertRaises(ValueError):
                crop.LoadImageCrop().load(self.name, max_megapixels=value)
            with self.assertRaises(ValueError):
                crop._parse_crop(json.dumps(dict(x=value, y=0, w=1, h=1)), 32, 16)
        for aspect in ("nan:1", "1:0", "-1:2", "1e300:1"):
            with self.assertRaises(ValueError): crop._aspect_value(aspect)
        self.assertEqual(crop._parse_crop('{"x":0.25,"y":0,"w":0.5,"h":1}', 32, 16), (8, 0, 24, 16))

    @unittest.skipUnless(HAS_TORCH, "Torch unavailable; run embedded Python for tensors")
    def test_normal_tensors_masks_animations_and_canvas_guard(self):
        comfy = types.ModuleType("comfy")
        utils = types.ModuleType("comfy.utils")
        utils.common_upscale = lambda tensor, w, h, *_: torch.nn.functional.interpolate(tensor, (h, w), mode="bilinear", align_corners=False)
        comfy.utils = utils
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.utils": utils}):
            images, masks = crop.LoadImageCrop().load(self.name, aspect="1:1")
            self.assertEqual(tuple(images.shape), (1, 16, 16, 3))
            self.assertAlmostEqual(float(masks[0, 0, 0]), 127 / 255, places=5)
            images, masks = crop.LoadImageCrop().load(self.animation(), max_megapixels=0.00003)
            self.assertEqual(images.shape[0], 3)
            self.assertEqual(tuple(masks.shape), tuple(images.shape[:3]))
            self.assertLess(images.shape[1] * images.shape[2], 128)
            result, _extras = compose.LoadImagesCompose().compose(json.dumps([self.name]), max_megapixels=0)
            self.assertEqual(tuple(result.shape), (1, 16, 32, 3))
            with self.assertRaisesRegex(ValueError, "gap"):
                compose.LoadImagesCompose().compose(json.dumps([self.name]), gap=1e300)
            with patch.object(compose.compose_layout, "plan", return_value={"width": 16384, "height": 16384}), patch.object(torch, "full", side_effect=AssertionError("no allocation")):
                with self.assertRaisesRegex(ValueError, "safety limit"):
                    compose.LoadImagesCompose().compose(json.dumps([self.name]), max_megapixels=0)


@unittest.skipUnless(HAS_TORCH, "Torch unavailable; run embedded Python for tensors")
class ComposeExtrasTests(unittest.TestCase):
    """The extras bundle, muted layers, padding and the selection."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name) / "input"
        root.mkdir()
        self._input = folders.get_input_directory
        folders.get_input_directory = lambda: str(root)
        # three plain images of known size and colour
        for name, size, colour in (("red.png", (32, 16), (255, 0, 0)),
                                   ("green.png", (16, 16), (0, 255, 0)),
                                   ("blue.png", (8, 24), (0, 0, 255))):
            Image.new("RGB", size, colour).save(root / name)
        comfy = types.ModuleType("comfy")
        utils = types.ModuleType("comfy.utils")
        utils.common_upscale = lambda tensor, w, h, *_: torch.nn.functional.interpolate(
            tensor, (h, w), mode="nearest")
        comfy.utils = utils
        self.modules = patch.dict(sys.modules, {"comfy": comfy, "comfy.utils": utils})
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        folders.get_input_directory = self._input
        self.temp.cleanup()

    def run_node(self, layers, **kw):
        return compose.LoadImagesCompose().compose(json.dumps(layers), max_megapixels=0, **kw)

    def test_extras_hold_each_layer_at_its_own_size(self):
        image, extras = self.run_node(["red.png", {"image": "green.png", "crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}}])
        self.assertEqual([tuple(t.shape) for t in extras["images"]], [(1, 16, 32, 3), (1, 16, 8, 3)])
        self.assertEqual(list(extras["images_bundle"]), ["image_0", "image_1"])
        self.assertIs(extras["images_bundle"]["image_1"], extras["images"][1])
        self.assertIs(extras["selected_image"], image, "Result selected: the packed image")
        self.assertEqual(float(extras["images"][1][0, 0, 0, 1]), 1.0)

    def test_a_muted_layer_is_left_out_and_the_rest_renumbered(self):
        layers = ["red.png", {"image": "green.png", "muted": True}, "blue.png"]
        image, extras = self.run_node(layers)
        self.assertEqual([tuple(t.shape[1:3]) for t in extras["images"]], [(16, 32), (24, 8)])
        self.assertEqual(list(extras["images_bundle"]), ["image_0", "image_1"])
        # and not in the sheet: no green anywhere in it
        self.assertEqual(float(image[..., 1].max()), 0.0)
        everything_off = [{"image": "red.png", "muted": True}]
        image, extras = self.run_node(everything_off)
        self.assertIsNone(image)
        self.assertEqual(extras["images"], [])

    def test_the_selection_is_what_selected_image_is(self):
        layers = ["red.png", {"image": "green.png", "muted": True}, "blue.png"]
        _image, extras = self.run_node(layers, selected=2)
        self.assertIs(extras["selected_image"], extras["images"][1])
        # a muted layer can still be selected and taken alone
        _image, extras = self.run_node(layers, selected=1)
        self.assertEqual(tuple(extras["selected_image"].shape), (1, 16, 16, 3))
        self.assertEqual(float(extras["selected_image"][0, 0, 0, 1]), 1.0)
        # a selection past the list (a stale one) is Result
        image, extras = self.run_node(layers, selected=9)
        self.assertIs(extras["selected_image"], image)

    def test_padding_frames_the_sheet_and_each_image(self):
        image0, _ = self.run_node(["red.png", "blue.png"])
        image, extras = self.run_node(["red.png", "blue.png"], padding=5, background="white")
        h0, w0 = image0.shape[1:3]
        self.assertEqual(image.shape[1] % 16, 0)
        self.assertEqual(image.shape[2] % 16, 0)
        self.assertGreaterEqual(image.shape[1], h0 + 10)
        self.assertGreaterEqual(image.shape[2], w0 + 10)
        # every side keeps at least the padding of background
        for edge in (image[0, :5], image[0, -5:], image[0, :, :5], image[0, :, -5:]):
            self.assertEqual(float(edge.min()), 1.0)
        red = extras["images"][0]
        self.assertEqual(tuple(red.shape), (1, 26, 42, 3))
        self.assertEqual(float(red[0, 0, 0].min()), 1.0)          # the padding
        self.assertEqual(tuple(red[0, 5, 5].tolist()), (1.0, 0.0, 0.0))

    def test_pad_plan_aligns_and_centres(self):
        layout = {"width": 48, "height": 32, "boxes": [(0, 0, 48, 32)], "fill": 1.0,
                  "rows": None, "scale": 1.0, "order": "given"}
        padded = compose.compose_layout.pad_plan(layout, 5)
        self.assertEqual((padded["width"], padded["height"]), (64, 48))
        self.assertEqual(padded["boxes"], [(8, 8, 48, 32)])
        self.assertIs(compose.compose_layout.pad_plan(layout, 0), layout)


class PresetTests(unittest.TestCase):
    def setUp(self):
        registry.NODE_CLASS_MAPPINGS.clear()

    def test_describe_deduplicates_per_class_and_refreshes(self):
        class Installed:
            calls = 0
            choices = ["one", "two"]
            @classmethod
            def INPUT_TYPES(cls):
                cls.calls += 1
                return {"required": {"a": (cls.choices,), "b": (cls.choices,)}}
        registry.NODE_CLASS_MAPPINGS["Installed"] = Installed
        registry.NODE_CLASS_MAPPINGS["Alias"] = Installed
        schema = "\n".join("f%d: @%s.%s" % (n, "Installed" if n % 2 else "Alias", "a" if n % 2 else "b") for n in range(64))
        fields = presets.describe(schema)
        self.assertEqual(Installed.calls, 1)
        self.assertEqual(len(fields), 64)
        self.assertEqual(fields[0]["default"], "one")
        Installed.choices = ["fresh"]
        self.assertEqual(presets.describe(schema)[0]["default"], "fresh")
        self.assertEqual(Installed.calls, 2)

    def test_failure_dedup_and_numeric_refusals(self):
        class Broken:
            calls = 0
            @classmethod
            def INPUT_TYPES(cls):
                cls.calls += 1
                raise ValueError("broken")
        registry.NODE_CLASS_MAPPINGS["Broken"] = Broken
        registry.NODE_CLASS_MAPPINGS["BrokenAlias"] = Broken
        fields = presets.describe("a: @Broken.a\nb: @BrokenAlias.a")
        self.assertEqual(Broken.calls, 1)
        self.assertIn("error", fields[0])
        self.assertIn("Broken.a", fields[0]["error"])
        self.assertIn("BrokenAlias.a", fields[1]["error"])
        presets.describe("a: @Broken.a\nb: @BrokenAlias.a")
        self.assertEqual(Broken.calls, 2)  # failures are request-scoped too
        for schema in ("x: float = nan", "x: float -inf..inf", "x: int = inf"):
            with self.assertRaises(ValueError): presets.resolve(schema, "{}")
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaises(ValueError): presets.resolve("x: float", '{"x":%s}' % value)

    def test_response_and_choice_bounds(self):
        class Huge:
            @classmethod
            def INPUT_TYPES(cls): return {"required": {"a": (["x"] * 8193,)}}
        registry.NODE_CLASS_MAPPINGS["Huge"] = Huge
        self.assertIn("error", presets.describe("x: @Huge.a")[0])
        normal, _ = presets.resolve("x: int 0..20 = 3\ny: choice a,b", "{}")
        self.assertEqual(normal, {"x": 3, "y": "a"})


if __name__ == "__main__":
    unittest.main()


class PackGroupingTests(unittest.TestCase):
    """The type picker groups by pack: this pack, then core, then others."""

    def test_v3_combos_are_borrowable(self):
        """A V3 node hides its choices one level deeper than a V1 one.

        Core converts a V3 Combo input back to the V1 declaration by
        writing ("COMBO", {"options": [...]}) -- the io_type in slot 0,
        the list in the options dict. Reading slot 0 alone (what this
        node did until now) sees the string "COMBO" and concludes the
        input is not a dropdown at all, which on a current install is
        more than half of every dropdown there is, KSamplerSelect's
        sampler_name among them.
        """
        registry.NODE_CLASS_MAPPINGS.clear()
        v3 = ("COMBO", {"options": ["euler", "heun"], "default": "heun"})

        class Sampler:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"sampler_name": v3},
                        "optional": {"bit_depth": ("COMBO", {"options": ["auto", 8, 10]}),
                                     # a remote combo names a route, not a list
                                     "image": ("COMBO", {"remote": {"route": "/x"}}),
                                     "pixels": ("IMAGE",)}}
        registry.NODE_CLASS_MAPPINGS["Sampler"] = Sampler
        try:
            self.assertEqual(presets.ref_choices("Sampler.sampler_name", "f"),
                             ["euler", "heun"])
            # numbers are legal options and stay as the node wrote them
            self.assertEqual(presets.ref_choices("Sampler.bit_depth", "f"),
                             ["auto", 8, 10])
            # a preset arrives as JSON, so a borrowed number may come back
            # as text -- it matches by text but is handed on as declared,
            # because core validates with `val not in options` and coerces
            # nothing, and the node's own `bit_depth >= 10` needs a number
            values, _ = presets.resolve("depth: @Sampler.bit_depth", '{"depth": "8"}')
            self.assertEqual(values, {"depth": 8})
            self.assertIsInstance(values["depth"], int)
            self.assertEqual(presets.resolve("depth: @Sampler.bit_depth", "{}")[0],
                             {"depth": "auto"})
            self.assertEqual(presets.describe("x: @Sampler.sampler_name")[0]["default"],
                             "euler")
            for input_name in ("image", "pixels"):
                with self.assertRaisesRegex(ValueError, "not a dropdown"):
                    presets.ref_choices("Sampler.%s" % input_name, "f")
            listed = {(t["node"], t["input"]): t for t in presets.catalogue()}
            self.assertEqual(listed[("Sampler", "sampler_name")]["count"], 2)
            self.assertEqual(listed[("Sampler", "bit_depth")]["sample"],
                             ["auto", 8, 10])
            self.assertNotIn(("Sampler", "image"), listed)
            self.assertNotIn(("Sampler", "pixels"), listed)
        finally:
            registry.NODE_CLASS_MAPPINGS.clear()

    def test_combo_options_reads_both_declarations(self):
        read = presets._combo_options
        self.assertEqual(read((["a", "b"], {"default": "a"})), ["a", "b"])
        self.assertEqual(read(("COMBO", {"options": ["a", "b"]})), ["a", "b"])
        self.assertEqual(read(("COMBO", {"options": [1, 2.5]})), [1, 2.5])
        for entry in (("COMBO",), ("COMBO", {}), ("STRING", {"multiline": True}),
                      ("MODEL",), (), None, "COMBO",
                      # options a preset could not carry are refused whole
                      ("COMBO", {"options": [{"a": 1}]}),
                      ("COMBO", {"options": ["ok", True]})):
            self.assertIsNone(read(entry), entry)

    def test_pack_of_reads_module_names_comfyui_uses(self):
        p = presets._pack_of
        self.assertEqual(p("nodes"), ("ComfyUI core", 1, False, True))
        self.assertEqual(p("comfy_extras.nodes_hooks"), ("ComfyUI core", 1, False, True))
        self.assertEqual(p(r"C:\x\ComfyUI\comfy_extras\nodes_hooks"), ("ComfyUI core", 1, False, True))
        self.assertEqual(p("comfy_api_nodes.nodes_gemini")[0], "ComfyUI core")
        self.assertEqual(p("custom_nodes.comfyui-kjnodes.nodes.x"), ("comfyui-kjnodes", 2, False, False))
        self.assertEqual(p(r"c:\AI\ComfyUI\custom_nodes\rgthree-comfy"), ("rgthree-comfy", 2, False, False))
        mine = presets._MY_FOLDER
        self.assertEqual(p("custom_nodes.%s.presets" % mine), (mine, 0, True, False))
        self.assertEqual(p("c:/AI/ComfyUI/custom_nodes/%s/presets.py" % mine.upper())[1], 0)
        self.assertEqual(p("")[0], "ComfyUI core")

    def test_catalogue_is_grouped_by_rank_then_pack(self):
        class Pick:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"choice": (["a", "b"],)}}
        mine = type("Mine", (Pick,), {"__module__": "custom_nodes.%s.values" % presets._MY_FOLDER})
        core = type("KSampler", (Pick,), {"__module__": "nodes"})
        other = type("Other", (Pick,), {"__module__": "custom_nodes.zz-pack.nodes"})
        other2 = type("Other2", (Pick,), {"__module__": "custom_nodes.aa-pack.nodes"})

        class Gate:
            @classmethod
            def INPUT_TYPES(cls):
                return {"required": {"on_empty": (["mute", "bypass"],)}}
        my_mod = "custom_nodes.%s.gates" % presets._MY_FOLDER
        any_gate = type("AnyGate", (Gate,), {"__module__": my_mod})
        image_gate = type("ImageGate", (Gate,), {"__module__": my_mod})
        registry.NODE_CLASS_MAPPINGS = {
            "Other": other, "KSampler": core, "Mine": mine, "Other2": other2,
            # only the Any gate's on_empty is offered; the others repeat it
            "ImageOptionalGate (obvpm)": image_gate, "AnyOptionalGate (obvpm)": any_gate}
        try:
            got = [(t["pack"], t["node"], t["rank"], t["core"]) for t in presets.catalogue()]
        finally:
            registry.NODE_CLASS_MAPPINGS = {}
        self.assertEqual(got, [
            (presets._MY_FOLDER, "AnyOptionalGate (obvpm)", 0, False),
            (presets._MY_FOLDER, "Mine", 0, False),
            ("ComfyUI core", "KSampler", 1, True),
            ("aa-pack", "Other2", 2, False),
            ("zz-pack", "Other", 2, False),
        ])
