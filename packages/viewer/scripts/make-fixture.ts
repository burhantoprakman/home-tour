/**
 * Writes the synthetic dev-page fixtures to src/dev/public/fixtures/ (served at /fixtures/):
 *   collision.glb            box room with a 20 cm and a 40 cm step (our GLB writer)
 *   room.sog                 splats on the same surfaces (PLY -> SOG via splat-transform)
 *   lod/lod-meta.json        the same splats as a streamed 2-level LOD SOG (budget applies)
 *   voxel.collision.glb      splat-transform's own collision mesh of room.sog, so tests check
 *                            our GLB reader against the pipeline tool's output format
 *
 * Run: pnpm --filter viewer fixture   (needs splat-transform on PATH, or SPLAT_TRANSFORM=<path>)
 */
import { execFileSync } from 'node:child_process';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildFixturePly, buildFixtureRoom } from '../src/fixture.ts';
import { writeGlb } from '../src/glb.ts';

const dir = new URL('../src/dev/public/fixtures/', import.meta.url);
const path = (name: string) => fileURLToPath(new URL(name, dir));
const tool = env['SPLAT_TRANSFORM'] ?? 'splat-transform';
const run = (...args: string[]) => execFileSync(tool, ['-q', '-w', ...args], { stdio: 'inherit' });

const room = buildFixtureRoom();
writeFileSync(path('collision.glb'), writeGlb(room.positions, room.indices));

const temp = ['room.ply', 'lod1.ply', 'voxel.voxel.json', 'voxel.voxel.bin'];
writeFileSync(path('room.ply'), buildFixturePly());
try {
  run(path('room.ply'), path('room.sog'));
  run(path('room.ply'), '-d', '50%', path('lod1.ply'));
  rmSync(path('lod'), { force: true, recursive: true });
  run(path('room.ply'), '-l', '0', path('lod1.ply'), '-l', '1', path('lod/lod-meta.json'));
  run(
    path('room.sog'),
    '--seed-pos',
    '0,1,0',
    '--collision-mesh',
    'faces',
    path('voxel.voxel.json'),
  );
} finally {
  for (const name of temp) rmSync(path(name), { force: true });
}

for (const name of ['collision.glb', 'room.sog', 'lod/lod-meta.json', 'voxel.collision.glb']) {
  console.log(`${name}: ${statSync(path(name)).size} bytes`);
}
