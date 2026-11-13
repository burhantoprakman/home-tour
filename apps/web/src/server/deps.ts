import { userDb } from './db';
import { modalEnqueuer } from './enqueue';
import { serverEnv } from './env';
import type { RouteDeps } from './rooms';

/** Real dependencies for route handlers (tests pass fakes to the handlers instead). */
export function routeDeps(): RouteDeps {
  const env = serverEnv();
  return { env, db: (token) => userDb(env, token), enqueuer: modalEnqueuer };
}
