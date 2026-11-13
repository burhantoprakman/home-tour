import { routeDeps } from '../../../server/deps';
import { createHome, listHomes } from '../../../server/homes';

export async function GET(req: Request): Promise<Response> {
  return listHomes(req, routeDeps());
}

export async function POST(req: Request): Promise<Response> {
  return createHome(req, routeDeps());
}
