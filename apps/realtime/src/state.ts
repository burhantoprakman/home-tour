import { schema, t, type SchemaType } from '@colyseus/schema';

/** One avatar. Kept minimal: what other clients need to draw it (CLAUDE.md realtime rules). */
export const Player = schema(
  {
    name: t.string(),
    avatarId: t.string(),
    tint: t.string(),
    /** False until the first transform arrives; clients don't draw unplaced players. */
    placed: t.boolean(),
    x: t.number(),
    y: t.number(),
    z: t.number(),
    yaw: t.number(),
    anim: t.string(),
    /** '' when standing. Server-owned: at most one player per seat. */
    seatId: t.string(),
  },
  'Player',
);
export type Player = SchemaType<typeof Player>;

export const HomeState = schema({ players: t.map(Player) }, 'HomeState');
export type HomeState = SchemaType<typeof HomeState>;
