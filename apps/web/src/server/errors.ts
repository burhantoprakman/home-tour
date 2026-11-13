import type { DbError } from './db';
import { apiError } from './http';

/** Maps the SQLSTATEs raised by the RPCs in supabase/migrations/*.sql to HTTP. */
export function dbErrorResponse(error: DbError): Response {
  switch (error.code) {
    case '42501': // not signed in / no execute grant (anon)
    case 'PGRST301': // JWT invalid or expired
    case 'PGRST302':
    case 'PGRST303':
      return apiError(401, 'Sign in again');
    case 'P0002':
      return apiError(404, 'Not found');
    case '55000':
      return apiError(409, error.message);
    case '22023':
    case '23514':
      return apiError(400, 'Invalid input');
    default:
      console.error('[api] database error', error.code, error.message);
      return apiError(500, 'Something went wrong');
  }
}
