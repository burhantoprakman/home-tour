import { routeDeps } from '../../../../server/deps';
import { joinWithInvite, previewInvite } from '../../../../server/visits';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  return previewInvite(await ctx.params, routeDeps());
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  return joinWithInvite(req, await ctx.params, routeDeps());
}
