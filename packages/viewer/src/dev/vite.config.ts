import { defineConfig, loadEnv, type Plugin } from 'vite';
import { AvatarId, DisplayName, signJoinTicket } from '@home-tour/shared';

/**
 * Dev page multiplayer (?mp): GET /__dev/ticket?home=<uuid>&name=&avatar=&tint= signs a join
 * ticket with REALTIME_TICKET_SECRET from the repo's .env, standing in for apps/web. Dev server
 * only (configureServer); production builds never contain it.
 */
const repoRoot = decodeURIComponent(new URL('../../../../', import.meta.url).pathname);

export function isLoopback(addr: string | undefined): boolean {
  return addr === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(addr ?? '');
}

function devTickets(): Plugin {
  return {
    name: 'home-tour-dev-tickets',
    configureServer(server) {
      const secret = () =>
        loadEnv(server.config.mode, repoRoot, 'REALTIME_').REALTIME_TICKET_SECRET ?? '';
      server.middlewares.use('/__dev/ticket', (req, res) => {
        // Loopback only: with `--host` the dev server is reachable on the LAN, and this endpoint
        // signs real tickets for any home. `adb reverse` traffic from a phone arrives as loopback.
        if (!isLoopback(req.socket.remoteAddress)) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'dev tickets are only served to localhost' }));
          return;
        }
        void (async () => {
          const q = new URL(req.url ?? '', 'http://dev').searchParams;
          try {
            const ticket = await signJoinTicket(
              {
                homeId: q.get('home') ?? '',
                name: DisplayName.parse(q.get('name') ?? 'Dev'),
                avatarId: AvatarId.parse(q.get('avatar') ?? 'villager-m'),
                tint: `#${q.get('tint') ?? '4a7bd0'}`,
                role: 'owner',
                exp: Date.now() + 10 * 60_000,
              },
              secret(),
            );
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ticket }));
          } catch (err) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: String(err) }));
          }
        })();
      });
    },
  };
}

/**
 * VIEWER_FS_ALLOW (repo .env, comma-separated absolute dirs): extra folders the dev page may load
 * splats from via /@fs/..., e.g. test scenes kept outside the repo.
 */
export default defineConfig(({ mode }) => {
  const extra = (loadEnv(mode, repoRoot, 'VIEWER_').VIEWER_FS_ALLOW ?? '')
    .split(',')
    .map((dir) => dir.trim())
    .filter(Boolean);
  return { plugins: [devTickets()], server: { fs: { allow: [repoRoot, ...extra] } } };
});
