import { routeDeps } from '../../../../../server/deps';
import { createRoom } from '../../../../../server/rooms';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createRoom(req, await ctx.params, routeDeps());
}
