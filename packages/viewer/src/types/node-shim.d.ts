// The repo has no @types/node (not an approved dependency). These are the few Node APIs the
// fixture script and tests use, typed just enough for them.
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
  export function writeFileSync(path: string | URL, data: Uint8Array | string): void;
  export function existsSync(path: string | URL): boolean;
  export function rmSync(
    path: string | URL,
    options?: { force?: boolean; recursive?: boolean },
  ): void;
  export function statSync(path: string | URL): { size: number };
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options?: { stdio?: 'inherit' | 'pipe'; encoding?: 'utf8' },
  ): string | Uint8Array;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
  export const argv: string[];
  export function exit(code?: number): never;
}
