# Changelog: comfyui-obvpm node pack

Changes not yet in a release are listed under **Latest HEAD**; they become a numbered version when the pack is released.

## Latest HEAD

- Bundle and Unbundle settings: **Enter** is OK -- from a name field too (a name that is not allowed still keeps the dialog open with the reason). Not on a focused button (Enter presses that one) or a dropdown.
- Mute Group If inside a subgraph: with no group around it in there, it acts on the group around the subgraph's node in the graph that holds it (climbing on while that node is in no group either), once for each place the subgraph is used -- so the switch and its Get can be tidied into a subgraph. The subgraph's node is never muted (it holds the switch), nor what feeds it; a group inside the subgraph still wins. Before, such a switch was "not in a group" and muted nothing. Also right for a subgraph just made, before it is first drawn.
- Mute Group If: no status line ("running …" / "muting …" / "value not known before the run …") under its widgets any more -- the greyed group already says it, and the line made every switch a row taller. Its status is still kept for diagnostics (`node.__obvpmMuteStatus`). And a new one is exactly as tall as its two widgets: it has no outputs and its inputs are the widgets' own sockets, but litegraph sized it for one more slot row, which sat empty under them (classic renderer).
- New, for other packs: a node of another pack can **set a bundle constant itself**, always on: its class names the widget holding the name (`prototype.obvpmConstantWidget = "<widget>"`) and puts a bundle on its output 0. Such a node keeps its own title, takes part in the unique names, paste renames, **Add Unbundle (get)** and the KJNodes interop like a setting Bundle, and an empty name sets nothing. It can also name its bundle's fields for the Unbundles that take them apart (`node.obvpmBundleNames(slot)`) and say what a field holds before a run (`node.obvpmBundleValue(field)`), which the switches, Mute Group If and the presets' fades read through the Unbundle.

## 0.2.12 (2026-10-04)

- Value Presets: a node that reads a constant by name, with no Get node in between (a node offering `obvpmConstantRead()`), now counts as reading it. Before, a value whose only reader was such a node seemed to go nowhere, so the presets feeding it faded although they were used.

## 0.2.11 (2026-10-02)

- New: **Mute Group If** mutes the group it sits in while its `mute` value is true (or false, with `invert`): every node in the frame is set to Never, so it is left out of the run -- nothing in it starts, loaders included -- and shows greyed, and it comes back when the value turns. The value is read before the run, as the switches read theirs (a widget, a Value Presets field, a primitive, the timeline's upscale toggle); one it cannot tell leaves the group on. Only nodes it muted are unmuted again, and a node covered by several stays muted while any of them wants it. Value Presets fades follow it at once: a preset read only by muted nodes fades too. See [Mute Group If](README.md#mute-group-if).
- Value Presets: a preset read only by a node that never runs -- one with no outputs that is not an output node, such as a display-only preview -- now fades like an unused one; before, wiring such a display node kept it lit.
- Value Presets: **headings** — a `## Title` line in the schema puts a heading over the fields below it, so long settings read in groups (in the config dialog it is the new **group** column). A heading hides while every field under it does.
- Value Presets: **fields switched off per node** — the config dialog's new **on** column. Nodes sharing one schema (and one set of presets) need not all use every field: a field switched off is hidden on that node and `None` on its bundle, and the fields it decides still see it at its default (a field shown `when` the switched-off one has its default value keeps showing). Override Bundle Values downstream keeps it off.

## 0.2.10-preview.2 (2026-09-28)

- Value Presets: works with the timeline's **load settings** ([comfyui-obvpm-timeline](https://github.com/chanon/comfyui-obvpm-timeline)): each changed value is its own row; a changed schema, and each workflow preset that differs, is one row, unticked by default, with what changed inside it behind a collapsed toggle.

## 0.2.10-preview.1 (2026-09-28)

- Value Presets: the **schema** button is now **config**, with three pages: Presets, Schema (as before) and Set.
- Value Presets: **user presets** — presets kept in your user folder under the node's **Preset Type Id**, shared by every workflow whose node has the same id, so your presets survive a new version of a workflow. The workflow's own presets can be hidden from the chooser. See [Value Presets](README.md#value-presets).
- Value Presets: nodes with the same Preset Type Id also **share their workflow presets** within a workflow.
- Value Presets: **export / import** presets as a small JSON file, to move them between workflows or share them.
- Value Presets: **set to constant**, like a Bundle's set — an Unbundle with get or a KJNodes Get reads the bundle by name, without a wire. Turned on in config; the name is the node's **set_constant** field.
- Value Presets: a borrowed dropdown whose default is not on this install keeps its dropdown (starting on the first entry) instead of turning into a text field.
- Value Presets: fields show **as the workflow opens**, not after it has finished loading — the node keeps the last description of its schema with the workflow (a few KB) and builds from it at once, while the server is still asked and wins if it answers differently. A borrowed dropdown's list, and anything taken from it, is never saved: it is read from the browser's own node definitions, so no model or LoRA file names travel in a shared workflow.
- Value Presets: a node **not used by the next run** fades — when every path from it ends at a switch that will pick another branch, or at nodes a Mute If gate will block, and that is known before the run (a switch's or gate's own setting, a preset value, or the timeline's upscale toggle: while generating, the upscale engine settings and upscale options fade; while upscaling, the generation engine settings). A new or unwired node, or one behind a switch or gate decided at run time, looks as usual. Only the look changes; the node still edits.
- New node: **Override Bundle Values** — override some of a bundle's values (typically a Value Presets node's) per run, with the preset's own ranges and choices, or by wiring in a value no widget can hold. The Value Presets node marks the fields that are overridden downstream. See [Override Bundle Values](README.md#override-bundle-values).
- Fixed: Load Images & Compose ignored an image list set from outside the node -- e.g. the timeline's "load settings" restoring a take -- and kept showing (and on the next edit wrote back) its old list. It now re-reads the list whenever it changes.

## 0.2.9 (2026-09-26)

- Value Presets: fixed the node staying blank ("still waiting for the schema from the server") in workflows where something keeps the canvas redrawing, such as a pack with animated links or live monitors (issue #12). Each redraw asked for the fields again while the answer was on its way, and the answer was then thrown away as out of date, over and over.
- Value Presets: fixed a false red "its graph holds ANOTHER node under id …" line over preset nodes after a workflow was loaded again (or undone, or its tab switched) while the nodes were still starting up. It came from the node the load replaced, not the one on screen, and showed whenever the node was not selected.

## 0.2.8 (2026-09-26)

- Compatibility Check: new **Message & Links** in the details, for workflow authors: a short text and a list of links the node shows when the install can run the workflow (for example a tutorial video, a Discord, a support page). Links open only on trusted sites (GitHub, GitLab, Hugging Face, Civitai, YouTube, Discord, Patreon and a few more), with the real site shown next to each. See [Message & Links](README.md#message--links).

## 0.2.7 (2026-09-25)

- Bundle / Unbundle: new **Set as a constant** / **Get from a constant** option in the ⚙ settings. Turned on, the node sets or gets a bundle by a constant name instead of a wire, like KJNodes Set/Get, and works together with them: a KJNodes Get can read a Bundle's set, and an Unbundle's get can read a KJNodes Set that carries a bundle. Collapsed, the node then shows "Set name" / "Get name". Off by default, so existing workflows are unchanged. See [Set / get by name](README.md#set--get-by-name).
- Unbundle: the ⚙ settings dialog now shows, for each field, whether the bundle on the wire (or the constant) has it: green yes, red no (that output gives None), grey when it can't be traced, with the reason.
- Bundle / Unbundle: the collapse (−) and settings (⚙) buttons are now drawn as icons instead of text characters, so they are the same size on every system (on some installs the ⚙ came out tiny). The Compatibility Check's settings button got the same icon.
- Bundle / Unbundle: fixed the node pack badge showing above the nodes again on ComfyUI frontend 1.53 in the classic (non Nodes 2.0) view.
- Value Presets: if the node can't build its fields, it now says why on the node instead of staying blank, and retries a failed build. Right-click the node → **Copy Value Presets diagnostics** copies a report for bug reports (what happened to the node, and errors other packs logged while the workflow loaded).

## 0.2.6 (2026-09-25)

- New node **Compatibility Check**: It allows workflow creators to configure the minimum ComfyUI version required, and also what custom node packs are required for the workflow to work. Then when a user opens the workflow, they can see from the node if they are missing any node packs or if they are on a too old version of anything. Created to reduce support load from my [timeline workflow](https://github.com/chanon/comfyui-obvpm-timeline). Also has a "copy report" button that lists the complete installation details for bug reports.

## 0.2.5 (2026-09-24)

- Value Presets and Switches: Fixed on ComfyUI frontend 1.53 (ComfyUI 0.37) the preset chooser and a switch's `selected` dropdown were renamed `preset#1` / `selected#1` when the node was created, after which choosing a preset changed nothing and the prompt sent the wrong input name (issue #12). 
- Bundle: Fixed issue where if ComfyUI is set to a non-English language input pin names could use the translated output pin names of the upstream nodes causing breaks in the downstream Unbundle(s). Workflows need no changes, they will automatically work in the new version.
- Fixed "Loading aborted due to error reloading workflow data — TypeError: Converting circular structure to JSON" when loading a workflow (for example by dropping a video or image saved from it) on ComfyUI frontend 1.52 (ComfyUI 0.36) with Nodes 2.0 enabled and a Bundle, Unbundle, Value Presets or switch node inside a subgraph (issue #13, comfyui-obvpm-timeline issue #6). The fresh slot objects handed to the Nodes 2.0 renderer are now real slots again instead of plain copies.

## 0.2.4 (2026-09-23)

- Value Presets: The schema editor now has an  **edit as text** button, which opens the schema as text to edit, paste into or copy from; *Use this schema* checks it and replaces the rows.
- Value Presets: fixed issue where couldn't save preset in ComfyUI Desktop (Electron)
- Value Presets: can now also rename presets
- Value Presets: the schema editor's *hint* column is now called *tooltip*, with a ✎ button that opens it in a bigger text box for editing
- Value Presets: fixed escape button closing the whole schema dialog instead of the popups
- Peek Bundle: fixed issue where it was not updating in Nodes 2.0
- Load Images & Compose + Load Image & Crop, Peek Bundle: fixed sizing issues in Nodes 2.0
- Bundle/Unbundle: fixed collapsed bundle/unbundle nodes showing nothing at all in Nodes 2.0 and having wrong wire position

## 0.2.3 (2026-09-22)

- Load Images & Compose: an empty node with no images now outputs `None` instead of raising an error. So you don't have to ctrl-b disable empty ones when eg. using one as a reference image input to MiniMax H3.
- Value Presets: a field can now depend on another one. Add `when turbo_loader != off` (or `when spectrum = true`, or `when mode = a, b` for any of several values) after a field's default, and the field is only shown while the choice or true/false field named holds one of those values. While hidden, its value on the bundle is `None` -- so a LoRA name sitting behind an "off" switch is never applied, and its widget no longer suggests that it is. The value is kept and comes back when the field does.
- Value Presets: a field can carry a hint. Put `# any text` at the end of its schema line and it shows when hovering over the widget.
- Value Presets: the schema editor has a `copy` button that copies the schema as text, and a `paste` button that replaces the fields with a pasted one (checked first; nothing changes on the node until Apply). The editor also has columns for the condition and the hint.
- The package published to the Comfy Registry no longer contains the tests and CI helpers, only the pack itself (`.comfyignore`).

## 0.2.2 (2026-09-16)

- Value Presets: fields that borrow another node's dropdown now work with nodes written for ComfyUI's newer node API (V3 Combos ), which declares its choices in a different place. On a current install more than half of all dropdowns are of that kind -- `KSamplerSelect`'s `sampler_name` and `BasicScheduler`'s `scheduler` among them -- and until now they were missing from the field type picker and could not be borrowed at all.
- Value Presets: a borrowed dropdown whose choices are numbers, such as `CreateVideo`'s `bit_depth`, now passes its value on as a number, which is what the node it came from expects.
- Value Presets: hovering a field whose value is cut off, such as a long file name in a narrow node, shows the full value.

## 0.2.1 (2026-09-15)

- Value Presets: the field type picker is now grouped by node pack, with nodes from this pack first, then ComfyUI core, then other packs, each under its own header.
- Value Presets: a number's range now sets how many decimals its widget shows and steps by. For example:
  - `0..1.0` will have steps at `0.0`, `0.1`, `0.2` ... to `0.9`, `1.0`
  - `0..1.00` will have steps at `0.00`, `0.01`, `0.02` ... to `0.99`, `1.00` 
  - The default or `0..1` is 2 decimal points
- Load Images & Compose: the divider between the layer strip and the main view can be dragged to widen the strip, and its entries no longer shrink as layers are added -- the strip scrolls instead.
- Load Images & Compose: while the pointer is over the node, Delete or Backspace removes the selected layer and Up / Down move the selection to the previous or next layer.
- The Mute node is now called Mute If. Same internal id, only the display name changed.
- Downscale Image to Megapixels: new `resolution_steps` widget rounds the output width and height down to a multiple, 32 by default. Set it to 1 for the old behaviour; note that existing graphs pick up the default.

## 0.2.0 (2026-09-13)

- In order to fix issue #4 which was caused by the `Bundle` node class id clashing with another node pack's Bundle node, the internal class ids for all nodes have been suffixed with ` (obvpm)`. This ensures there will be no future clashes.

- Workflows saved using previous versions should be migrated automatically upon open. If you find the `Bundle` node in a workflow still not working, please delete it and create a new one.
