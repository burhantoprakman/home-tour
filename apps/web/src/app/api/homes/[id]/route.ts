import { routeDeps } from '../../../../server/deps';
import { getHome } from '../../../../server/homes';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return getHome(req, await ctx.params, routeDeps());
}
