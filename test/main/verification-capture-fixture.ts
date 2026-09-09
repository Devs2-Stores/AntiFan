/**
 * Test support for the canonical capture primitive.
 *
 * Every screenshot capability now fails closed unless the host exposes
 * `captureVerificationScreenshot` and returns a receipt-bearing envelope, so
 * host mocks that only produce a base64 string are projected through this
 * helper instead of duplicating the envelope shape at each call site.
 */

import type { VerificationCaptureEnvelope } from '../../src/main/verification/visual-capture';

/** Structurally valid 1x1 PNG (IHDR + zlib IDAT + IEND) for byte-exact assertions. */
export const TINY_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]).toString('base64');

export interface VerificationEnvelopeOptions {
  fullPage?: boolean;
  width?: number;
  height?: number;
  dpr?: number;
  zoom?: number;
}

export function verificationCaptureEnvelope(
  data: string,
  options: VerificationEnvelopeOptions = {}
): VerificationCaptureEnvelope {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  return {
    data,
    backend: 'cdp',
    dpr: options.dpr ?? 1,
    zoom: options.zoom ?? 1,
    cssViewport: { width, height },
    cssCaptureSize: { width, height },
    rasterSize: { width, height },
    captureMode: options.fullPage === true ? 'full-page' : 'viewport',
    timestamp: Date.now(),
  };
}

type PaneId = 'desktop' | 'mobile';
type LegacyCaptureOptions = { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean };
type CanonicalCaptureOptions = LegacyCaptureOptions & { timeoutMs?: number };
type LegacyCapture = (rect?: unknown, tabId?: string, paneId?: PaneId, options?: LegacyCaptureOptions) => string | Promise<string>;
type CanonicalCapture = (rect?: unknown, tabId?: string, paneId?: PaneId, options?: CanonicalCaptureOptions) => Promise<VerificationCaptureEnvelope>;

interface LegacyCaptureHost {
  captureScreenshot?: LegacyCapture;
  captureVerificationScreenshot?: unknown;
}

/**
 * Attach the canonical capture primitive to a legacy host mock. The legacy
 * `captureScreenshot` supplies the bytes; `onCapture` records the call for
 * suites that assert capture ordering.
 */
export function withCanonicalCapture<T extends LegacyCaptureHost>(
  host: T,
  options: {
    capture?: LegacyCapture;
    onCapture?: (tabId?: string, fullPage?: boolean) => void;
    envelope?: VerificationEnvelopeOptions;
  } = {}
): T & { captureVerificationScreenshot: CanonicalCapture } {
  if (typeof host.captureVerificationScreenshot === 'function') {
    return host as never;
  }
  const legacy = options.capture ?? host.captureScreenshot;
  const capture: LegacyCapture = legacy
    ? legacy.bind(host)
    : async () => TINY_PNG_BASE64;
  const canonical: CanonicalCapture = async (rect, tabId, paneId, opts) => {
    options.onCapture?.(tabId, opts?.fullPage);
    return verificationCaptureEnvelope(await capture(rect, tabId, paneId, opts), {
      ...options.envelope,
      fullPage: opts?.fullPage,
    });
  };
  (host as LegacyCaptureHost).captureVerificationScreenshot = canonical;
  return host as never;
}
