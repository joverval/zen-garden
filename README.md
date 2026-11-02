# The Quiet Garden — Beta 1.10

Run `python3 -m http.server 8000` inside this folder. Open `http://localhost:8000`.

## Ground object orientation

Loose leaves, branches, and nuts now retain their original camera-facing orientation.
The renderer no longer rotates these sprites randomly. It applies small, stable affine adjustments.
Existing save files keep their positions, object IDs, and collected items. The migration discards old `rotation` values.

Edit `assets.groundSpritePlacement` in `garden.json` to control visual variation.
- `mode: "affine-upright"` uses subtle scale and shear.
- `mode: "original"` draws each PNG without geometric variation.
- Each object category has `scaleX`, `scaleY`, and `shearX` ranges.
- `mirrorX` defaults to false. Horizontal mirroring can reverse the light direction in painted sprites.

The game retains the nine audio files, all 38 user sprites, and the Beta 1.9 mechanics.
