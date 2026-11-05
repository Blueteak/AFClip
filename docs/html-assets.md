# HTML transitions and effects

HTML assets share packaging, snapshots, parameters and a rendering API. Their
roles remain distinct: content generates an image, an effect transforms one
image, and a transition combines two. Transitions still attach to timeline cuts.
Legacy transition records without an asset reference are deliberately unsupported.

New projects include editable dissolve, diagonal wipe, blur dissolve and spin
transitions, plus a blur effect. Ctrl+D adds a dissolve. Select a transition to
change its asset, duration, alignment, audio policy or parameters in the inspector.
Select a visual clip to add or reorder effects. Assets also appear in the bin;
double-click a transition/effect asset to apply it to the selection.

## Authoring

A package contains `index.html`, `asset.json`, and optional local libraries,
fonts, images and data. Import it through **Import HTML asset folder** or:

```powershell
af-clip import my-project ./my-transition --kind graphic
af-clip asset-builtin my-project wipe
af-clip asset-duplicate my-project graphic_ID
```

`metadata.authoringPath` identifies the editable project copy. Changes become
immutable accepted snapshots after the existing save debounce; exports lock the
snapshot. Undo restores the accepted code as well as project data. Referencing
instances share code, but keep separate parameter overrides. **Make unique**
duplicates the asset and switches the selected instance. Old projects need no
automatic migration; the Sample update script is an explicit example edit.

Example `asset.json`:

```json
{
  "apiVersion": 1,
  "role": "transition",
  "name": "My dissolve",
  "parameters": {
    "smooth": { "type": "boolean", "default": true }
  }
}
```

## Parameters

Content clips, effects and transitions share one parameter model. Types are
`number`, `boolean`, `color`, `text` and `choice`. Declaration order is
inspector order; optional `label` names the row.

```json
"parameters": {
  "title": { "type": "text", "label": "Headline" },
  "size": { "type": "number", "default": 64, "min": 8, "max": 400, "softMin": 24,
            "softMax": 200, "step": 1, "integer": true, "unit": "px", "slider": true },
  "tint": { "type": "color", "default": "#ffffffcc" },
  "lift": { "type": "number", "default": { "curve": [
    { "at": "0%", "v": 0 }, { "at": "40%", "v": 1, "ease": "back-out" }, { "at": "100%", "v": 1 } ] } }
}
```

- `min`/`max` are hard limits, also applied to evaluated curves and overshoot.
  `softMin`/`softMax` only suggest the slider/graph range. `integer` rounds
  evaluated values. `slider` needs a finite soft or hard range.
- Colors are `#rrggbb` or `#rrggbbaa`. Choices need a string `choices` array.
- Every parameter needs a default except `text`, which can come from HTML.
- Every `data-text` (or `data-afclip-text`) element is a text parameter with its
  HTML content as default, and keeps direct preview editing. Declare the same ID
  as `text` only to set its label or order; a declared non-text parameter with
  that ID is an error.

Number and color parameters can be animated per instance. Curves hold the
first/last value outside their points. Each point's `ease` shapes the following
segment: linear (default), `hold`, `ease`, `ease-in`, `ease-out`,
`ease-in-out`, `back-in`, `back-out`, `back-in-out`, or `[x1,y1,x2,y2]`
cubic-bezier handles; y outside 0..1 overshoots. Named easings are stored as
handles. Colors blend in OKLab with independent alpha. Expressions and other
drivers are not supported.

A default curve uses percentages. It binds once to the visible source range when
the instance is applied, including an effect added to a trimmed clip.

Instances store only overrides in `params`: a constant, `{curve:[...]}`, or
`{curve:[...],value}` when animation is off but the curve is kept for turning it
back on. Stored points are `{t:{num,den},v,ease?}`. For clips and effects `t` is
source time, so moving keeps timing, trims hide points, splits continue the
curve and stretching or speed changes scale it. `paramSpan` records the bound
default range. Transition points use progress 0..1 and scale with duration.
Removed or incompatible declarations silently drop matching instance values when
the asset reloads. Older `clip.text` overrides load as text parameters.

The inspector shows each row's value at the playhead. The keyframe button toggles
animation; while animated, edits set a point at the playhead. The curve button
opens an editor: drag points, handles or the playhead, Ctrl+click adds, Delete
removes, arrows step frames, Alt+arrows nudge a point, Up/Down nudge its value,
and the fields below set exact time, value and ease. Right-click a row to reset.
Parameter inputs and curve drags preview immediately and commit once on release or blur.
Handles shape interpolation between endpoint values;
use an intermediate keyframe for a rise and fall between equal values.

Agents use `af-clip params` and `af-clip param-set`; see `af-clip help param-set`.

Define `window.render(context)` in the HTML. It can be asynchronous. The host
handles messages and acknowledgement. For example:

```html
<canvas id="picture"></canvas>
<script>
const canvas = document.getElementById('picture');
window.render = ({ width, height, inputs: [outgoing, incoming], progress, params }) => {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  const p = params.smooth ? progress * progress * (3 - 2 * progress) : progress;
  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1 - p;
  ctx.drawImage(outgoing, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = p;
  ctx.drawImage(incoming, 0, 0);
  return canvas;
};
</script>
```

The context includes `apiVersion`, `width`, `height`, `time`, `duration`,
`progress`, `params` evaluated at this frame (including text fields), the instance `seed`, a seeded `random()` function,
and `inputs`, an array of ImageBitmaps. Transitions receive outgoing then incoming;
effects receive one image; content receives none. Transition time is elapsed time
within its window. Effect/content time is source time. Effect progress describes
the clip's local position, clamped to 0 to 1. Each render resets the random sequence.

Inputs already include clip fit, transforms, opacity and fades, and all preceding
effects. They have project dimensions and preserve transparency. They support
Canvas2D and WebGL texture upload. The host releases inputs when the render
finishes: draw them immediately, or make your own copy if necessary. Derive each
frame from the supplied values; playback may skip requests, and scrubbing may
request frames in any order. Do not depend on wall time, previous frames or
unseeded randomness. Endpoint matching is an authoring convention, not an enforced
crossfade over custom output.

Arbitrary HTML/CSS output is supported. A final transition's iframe is composed
directly by Chromium. Returning a canvas makes an effect's image available to the
next effect or transition through GPU-backed ImageBitmaps. An intermediate that
uses arbitrary DOM instead is rendered in a hidden isolated window and captured
as a transparent image. That fallback also lets existing HTML titles be inputs;
it is substantially slower than a returned canvas. The built-in blur transition
demonstrates CSS filtering and blending; the blur effect demonstrates canvas
output for efficient chaining.

Assets run in isolated browser documents without Node or parent DOM access.
Local dependencies and bundled data can load through the asset protocol. Live
network resources, nested frames and independent media playback are blocked.
Import dependencies during authoring rather than fetching them during rendering.

## Timeline and rendering rules

The composition order is clip fit/transforms/fades, ordered clip effects,
transition, then track composition. Other tracks remain independent. A future
nested scene can become an input without changing the image contract.

The host uses real footage beyond a trim while available, then holds the first
or last source frame. The cut and project duration stay fixed. A transition must
fit within the adjacent timeline clips and must not overlap another transition
window. Missing audio contributes silence. Audio can crossfade or cut at the
original edit, independently of the visual asset.

Transition records store `assetId`, `params`, `seed`, and `audio` alongside the
existing clip references, duration and alignment. Clip `effects` is an ordered
array of `{id, assetId, params, seed, paramSpan?}`; content clips keep their own
`params`. Use ordinary revision-checked `apply`
batches to edit them. Asset usage includes effect/transition references for
conflict detection, track locks and deletion validation.

Preview and exact export share `asset-runtime.js` and the asset's own code.
Native source video stays in Chromium; transitions copy only active input images
into browser-owned GPU surfaces. Export supplies the same runtime with decoded
source canvases. Scrubbing can use the existing source proxies, then refines to
originals when paused. Render errors stop affected playback/export with the asset
name; they never substitute a dissolve. Invalid manifest edits are saved as an
errored snapshot so export cannot silently render the previous code.

Preview retains the previously visible clip until the first transition frame is
ready, including entry by backward scrubbing. After a source seek, playback
allows time to recover and uses temporary rate correction instead of immediately
seeking again for the accumulated clock error.

Scrubbing through HTML content, effects or transitions finishes the current
render and keeps only the newest waiting position. Completed graphics and effect
frames remain visible between updates within a clip. Entering a clip or seeking
to its start still hides previous output until the requested frame is ready;
the unprocessed source of an effect stays hidden so transparent reveals do not
flash opaque. Release settles on the selected frame. Heavy effects can reduce
scrub update frequency without continually cancelling every frame.

Simple setups and a few lightweight effects target 1080p60. Arbitrary custom
JavaScript can exceed that budget. Playback bounds work by dropping superseded
requests; exact rendering waits for each requested frame. General effect-output
caching and adaptive reduced-resolution effects are not implemented. Code is
preloaded before use; this does not guarantee zero GPU/decoder startup stalls.

