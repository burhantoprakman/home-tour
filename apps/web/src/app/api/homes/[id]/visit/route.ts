import { routeDeps } from '../../../../../server/deps';
import { ownerVisit } from '../../../../../server/visits';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return ownerVisit(req, await ctx.params, routeDeps());
}
