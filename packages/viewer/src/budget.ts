/**
 * Splat budget per device tier (CLAUDE.md "Budgets"): 3M desktop, 1M mobile, 500k on the WebGL2
 * fallback. Pure functions; the dev page feeds them the real device.
 */

export type GraphicsBackend = 'webgpu' | 'webgl2';
export type DeviceTier = 'desktop' | 'mobile' | 'webgl2';

export const SPLAT_BUDGETS: Readonly<Record<DeviceTier, number>> = {
  desktop: 3_000_000,
  mobile: 1_000_000,
  webgl2: 500_000,
};

export interface DeviceInfo {
  backend: GraphicsBackend;
  mobile: boolean;
}

/** WebGL2 is the lowest tier on any device; otherwise mobile vs desktop. */
export function deviceTier({ backend, mobile }: DeviceInfo): DeviceTier {
  if (backend === 'webgl2') return 'webgl2';
  return mobile ? 'mobile' : 'desktop';
}

export function splatBudget(device: DeviceInfo): number {
  return SPLAT_BUDGETS[deviceTier(device)];
}

export interface MobileHints {
  userAgent: string;
  /** navigator.maxTouchPoints */
  maxTouchPoints: number;
  /** navigator.userAgentData?.mobile, where supported (Chromium). */
  uaDataMobile?: boolean | undefined;
}

/** Phone/tablet detection. iPadOS reports a desktop Mac user agent, so touch points decide. */
export function isMobileDevice({ userAgent, maxTouchPoints, uaDataMobile }: MobileHints): boolean {
  // Android tablets report userAgentData.mobile = false but have phone-class GPUs, so the UA
  // check comes first.
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return true;
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return uaDataMobile === true;
}
