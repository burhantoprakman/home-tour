import { routeDeps } from '../../../../../server/deps';
import { createInvite } from '../../../../../server/visits';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return createInvite(req, await ctx.params, routeDeps());
}
