import type { NextConfig } from 'next';

// Secrets live in the repo-root .env (shared by all apps); Next only reads apps/web/.env*.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No root .env (CI, production): use the real environment.
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The viewer ships TypeScript source (packages/viewer/src); Next compiles it.
  transpilePackages: ['@home-tour/viewer'],
};

export default nextConfig;
