import { routeDeps } from '../../../../../server/deps';
import { homeStatusStream } from '../../../../../server/status';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Each stream polls for ~5 minutes (STATUS_STREAM_DEFAULTS), then the client reconnects.
export const maxDuration = 300;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return homeStatusStream(req, await ctx.params, routeDeps());
}
