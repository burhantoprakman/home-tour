import { routeDeps } from '../../../../../server/deps';
import { roomUploaded } from '../../../../../server/rooms';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return roomUploaded(req, await ctx.params, routeDeps());
}
