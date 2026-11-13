import type { ApiError } from '@home-tour/shared';

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

export function apiError(status: number, error: string): Response {
  return json<ApiError>({ error }, status);
}

/** The Supabase access token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

/** Request body as JSON, or undefined if it isn't JSON (zod then rejects it). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
