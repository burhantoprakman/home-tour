# Home Tour

Turn one phone video per room into a walkable 3D home you can share with friends and family.

A homeowner records each room. A GPU pipeline turns every video into a Gaussian splat plus a hidden
collision mesh and seat positions. Guests then join in the browser as avatars who can walk, sit,
chat and emote, up to 8 per home. Rendering runs entirely in the browser (WebGPU with WebGL2
fallback); GPUs are used only to build homes.

## Repo layout

```
apps/
  web/          Next.js owner app, guest join page, API routes
  realtime/     Colyseus multiplayer server
  capture-ios/  Native iOS (ARKit) capture app
packages/
  viewer/       PlayCanvas client: splats, collision, avatars, input
  shared/       Types and message schemas shared by everything else
worker/         Python GPU pipeline (video -> COLMAP/GLOMAP -> gsplat -> collision/seats), runs on Modal
supabase/
  migrations/   Postgres schema + row-level security
```

## Stack

pnpm workspaces · TypeScript · Next.js · Supabase (Postgres, Auth, Storage) · PlayCanvas Engine ·
Colyseus · Python 3.12 (ffmpeg, COLMAP/GLOMAP, gsplat, splat-transform) · Modal · Vitest / pytest

## Getting started

Requirements: Node 22+, pnpm, Python 3.12 with [uv](https://docs.astral.sh/uv/), ffmpeg, COLMAP/GLOMAP
(for local solves), a Supabase project and a Modal account.

```sh
cp .env.example .env        # fill in Supabase, Modal and realtime values
pnpm install
pnpm dev                    # web (localhost:3000) + realtime + viewer dev page (localhost:5173)
pnpm test                   # all TypeScript tests
pnpm lint

cd worker
uv sync
uv run pytest               # pipeline tests
uv run python run_local.py <room-video>   # process one room locally (training runs on Modal)
modal deploy app.py         # deploy the pipeline
```

Database: `supabase link --project-ref <ref>` then `supabase db push` to apply `supabase/migrations`.

The iOS capture app is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from
`apps/capture-ios/project.yml`; set your own `DEVELOPMENT_TEAM` and bundle id prefix before building.

## Credits

Avatar models and animations are derived from CC0 packs by [Quaternius](https://quaternius.com);
see `packages/viewer/public/avatars/SOURCES.md`.
