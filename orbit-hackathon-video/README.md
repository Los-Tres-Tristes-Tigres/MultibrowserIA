# Orbit product-demo video

This folder contains the HyperFrames project that produces the demo embedded in the [root README](../README.md#product-demo).

## Current render

- File: [`renders/orbit-hackathon-demo.mp4`](./renders/orbit-hackathon-demo.mp4)
- Intended duration: 30 seconds
- Format: 1920 × 1080, 16:9, no narration or music
- Message: Orbit coordinates independent browser agents while reserving consequential actions for human approval.

## Files

| File | Purpose |
| --- | --- |
| `BRIEF.md` | Intent, message, format, and constraints. |
| `STORYBOARD.md` | Timing and the five-scene narrative. |
| `DESIGN.md` | Palette, typography, and visual direction. |
| `index.html` | Main HyperFrames composition. |
| `renders/` | Rendered MP4 artifacts. |

## Work with the composition

```sh
npm run check    # validates structure, timing, design, and contrast
npm run render   # renders the MP4
```

`npm run dev` opens a preview and `npm run publish` publishes a shareable version. Read [`AGENTS.md`](./AGENTS.md) completely before editing any composition: it contains HyperFrames-specific rules required for a correct render.

## Content boundary

The demo must not claim unsupervised autonomy. It should show the Gmail-to-Calendar context handoff and make the human approval boundary explicit before an external action occurs.
