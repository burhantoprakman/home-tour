# Avatar sources

Downloaded 2026-10-31 from Quaternius' itch.io pages, free "Standard" tier (name-your-own-price,
paid $0, no login); the first two re-downloaded 2026-11-02 (same SHA-256). All packs are CC0 1.0
(see `LICENSE`; still listed as CC0 on both pages on 2026-11-02) and use the same 65-joint
humanoid rig (identical joint names and order; checked in each file).

Since 2026-11-02 the three people (`villager-*` ids, kept for compatibility) wear modern home
clothes built by `scripts/build-avatars.ts` on the base bodies; the fantasy outfits pack is no
longer used.

| Pack                                           | Page                                                         | File downloaded                                              | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Universal Animation Library [Standard]         | https://quaternius.itch.io/universal-animation-library       | `Universal Animation Library[Standard].zip` (15 MB)          | `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724` |
| Universal Base Characters [Standard]           | https://quaternius.itch.io/universal-base-characters         | `Universal Base Characters[Standard].zip` (123 MB)           | `fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40` |
| Modular Character Outfits - Fantasy [Standard] | https://quaternius.itch.io/modular-character-outfits-fantasy | `Modular Character Outfits - Fantasy[Standard].zip` (281 MB) | `c3468b18871cc8c8f05ab14df7712baf22cb9f389cbd870babf130e595187f70` |

Only the derived GLBs below are kept in the repo; the packs themselves are not.

## Files used

From the animation library: `Unreal-Godot/UAL1_Standard.glb` (no root motion) - the `Mannequin`
mesh and the clips `Idle_Loop`, `Walk_Loop`, `Sitting_Enter`, `Sitting_Idle_Loop`,
`Sitting_Exit` (renamed `idle`, `walk`, `sitDown`, `sit`, `standUp`).

From the base characters (`Base Characters/Godot - UE/`, `Base Characters/Textures/`,
`Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/`): the full bodies, `Eyes` and `Eyebrows`
of `Superhero_Male_FullBody.gltf` and `Superhero_Female_FullBody.gltf` (also the skeletons),
skin textures `T_Superhero_Male_Ligh.png`, `T_Superhero_Male_Dark.png`,
`T_Superhero_Female_Light_BaseColor.png`, `T_Eye_Brown.png`, hairstyles `Hair_SimpleParted`,
`Hair_Long`, `Hair_Buzzed`, `Hair_Beard` with `T_Hair_1_BaseColor.png` / `T_Hair_2_BaseColor.png`.

## Output (built by `scripts/build-avatars.ts`)

| File                   | Body                                                                               | Triangles (source) | Size   |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------ | ------ |
| `villager-m.glb`       | short-sleeved shirt (player colour), navy trousers, brown shoes; parted hair       | 9,893 (15,619)     | 652 KB |
| `villager-f.glb`       | sleeveless knee-length A-line dress (player colour), burgundy flats; long hair     | 9,835 (17,336)     | 728 KB |
| `villager-m-beard.glb` | short-sleeved shirt (player colour), beige chinos, dark trainers; buzz cut + beard | 9,892 (16,182)     | 653 KB |
| `mannequin.glb`        | the animation library's mannequin                                                  | 9,898 (13,744)     | 605 KB |

Processing: parts re-bound to one skeleton per body, unused attributes dropped; clothes made
from the base body itself (each triangle assigned skin/shirt/dress/trousers/shoes by the bone it
follows, with straight hems cut by planes on the T-pose rig: waist, mid upper arm, ankle, neck),
cloth smoothed (Taubin) and pushed out a little, trouser shins straightened, and a generated
A-line skirt (skinned to pelvis, thighs and, below the knee, shins) for the dress, with the body
inside it removed (source counts above are after this); simplified to <= 9,900
triangles (quadric edge collapse, seams locked) with vertex normals recomputed from the
simplified surface, textures downscaled to 512 px JPEG
(hair 256, eyes 64), grey hair textures given a colour, only the five clips kept (bone
rotations; root/pelvis translation, pelvis height scaled to each body). The material named
`Tint` (shirt / dress / mannequin body) takes the per-person colour at runtime.

Rebuild: extract the animation library and base characters zips into one folder, then
`node scripts/build-avatars.ts <that folder> <scratch folder>` (macOS: uses `sips`).
