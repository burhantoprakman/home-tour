import { routeDeps } from '../../../../../server/deps';
import { saveFloorPlan } from '../../../../../server/homes';

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return saveFloorPlan(req, await ctx.params, routeDeps());
}
