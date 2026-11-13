import { describe, expect, it } from 'vitest';
import { SPLAT_BUDGETS, deviceTier, isMobileDevice, splatBudget } from './budget.ts';

describe('splat budget', () => {
  it.each([
    { backend: 'webgpu', mobile: false, tier: 'desktop', budget: 3_000_000 },
    { backend: 'webgpu', mobile: true, tier: 'mobile', budget: 1_000_000 },
    { backend: 'webgl2', mobile: false, tier: 'webgl2', budget: 500_000 },
    { backend: 'webgl2', mobile: true, tier: 'webgl2', budget: 500_000 },
  ] as const)('$backend mobile=$mobile -> $tier ($budget)', ({ backend, mobile, tier, budget }) => {
    expect(deviceTier({ backend, mobile })).toBe(tier);
    expect(splatBudget({ backend, mobile })).toBe(budget);
  });

  it('matches CLAUDE.md budgets', () => {
    expect(SPLAT_BUDGETS).toEqual({ desktop: 3_000_000, mobile: 1_000_000, webgl2: 500_000 });
  });
});

describe('isMobileDevice', () => {
  const android =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const mac =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const windows =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  it('detects phones', () => {
    expect(isMobileDevice({ userAgent: android, maxTouchPoints: 5 })).toBe(true);
    expect(isMobileDevice({ userAgent: iphone, maxTouchPoints: 5 })).toBe(true);
  });

  it('treats iPadOS (desktop Mac UA with touch) as mobile', () => {
    expect(isMobileDevice({ userAgent: mac, maxTouchPoints: 5 })).toBe(true);
  });

  it('treats desktops as desktop', () => {
    expect(isMobileDevice({ userAgent: mac, maxTouchPoints: 0 })).toBe(false);
    expect(isMobileDevice({ userAgent: windows, maxTouchPoints: 0, uaDataMobile: false })).toBe(
      false,
    );
  });
});
