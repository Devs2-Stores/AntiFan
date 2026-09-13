import { CapabilityError } from '../../shared/control-plane-contracts';
import { DEVICE_ERROR_REMEDIATION } from '../../shared/device-control-contracts';
import type {
  WdaResponse,
  WdaScreenInfo,
  WdaStatusPayload,
  WdaTransport,
} from './device-control-port';

/**
 * =========================================================================================
 * NON-OBVIOUS WEBDRIVERAGENT (WDA) REST SEMANTICS & RULES
 * =========================================================================================
 *
 * RULE 1: WDA self-kills the previous session on POST /session.
 * Inside WebDriverAgent's session manager, creating a new session automatically terminates
 * any active session running on the device before instantiating the new one. Callers do not
 * need to manually DELETE an existing session prior to createSafariSession, but any existing
 * session handle or target with an older generation becomes immediately invalid on the device.
 *
 * RULE 2: POST /session/:id/url never waits for load.
 * Under the hood, WDA implements POST /session/:id/url via `XCUIDevice.shared.fb_openUrl`.
 * This invokes iOS `openURL:` as a system deep-link, returning immediately once the URL is
 * dispatched to MobileSafari. It does NOT wait for network quiescence, DOM ready, or page load,
 * and WDA provides NO `GET /url` readback endpoint. Callers must never treat a successful return
 * from POST /url as navigation-complete; downstream wait/settle gates are strictly required.
 * =========================================================================================
 */

/**
 * Extracts a normalized transport error code from an unknown fetch/network error.
 */
function extractErrorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (
      e['name'] === 'TimeoutError' ||
      (e['cause'] as Record<string, unknown> | undefined)?.['name'] === 'TimeoutError' ||
      e['name'] === 'AbortError'
    ) {
      return 'TIMEOUT';
    }
    if (typeof e['code'] === 'string' && e['code']) {
      return e['code'];
    }
    const cause = e['cause'];
    if (cause && typeof cause === 'object') {
      const causeObj = cause as Record<string, unknown>;
      if (typeof causeObj['code'] === 'string' && causeObj['code']) {
        return causeObj['code'];
      }
      if (causeObj['name'] === 'TimeoutError') {
        return 'TIMEOUT';
      }
    }
    const msg = typeof e['message'] === 'string' ? e['message'] : '';
    if (/timed?\s*out|timeout/i.test(msg)) return 'TIMEOUT';
    if (/econnrefused/i.test(msg)) return 'ECONNREFUSED';
    if (/econnreset/i.test(msg)) return 'ECONNRESET';
    if (/enotfound/i.test(msg)) return 'ENOTFOUND';
    if (/ehostunreach/i.test(msg)) return 'EHOSTUNREACH';
  }
  return 'ECONNREFUSED';
}

/**
 * Parses iOS major and minor versions and determines if it is older than 16.4.
 * In WebDriverAgent source, initialUrl for MobileSafari is only supported on iOS >= 16.4.
 */
function isIosVersionBelow164(osVersion?: string): boolean {
  if (!osVersion) return false;
  const match = osVersion.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = parseInt(match[1]!, 10);
  const minor = match[2] ? parseInt(match[2]!, 10) : 0;
  if (major < 16) return true;
  if (major === 16 && minor < 4) return true;
  return false;
}

/**
 * Determines whether a given JSON object has the expected shape of a WDA /status response.
 */
function isWdaStatusShaped(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const root = json as Record<string, unknown>;
  const val =
    root['value'] && typeof root['value'] === 'object'
      ? (root['value'] as Record<string, unknown>)
      : root;

  if (typeof val['ready'] === 'boolean') return true;
  if (typeof root['ready'] === 'boolean') return true;
  if (typeof val['state'] === 'string' && val['state'] === 'success') return true;
  if (typeof val['message'] === 'string' && /webdriveragent|wda/i.test(val['message'])) return true;
  if (typeof root['message'] === 'string' && /webdriveragent|wda/i.test(root['message'])) return true;
  if (val['os'] && typeof val['os'] === 'object') return true;
  if (val['build'] && typeof val['build'] === 'object') return true;
  if (val['ios'] && typeof val['ios'] === 'object') return true;
  return false;
}

/**
 * Normalizes a raw WDA /status JSON response into the typed WdaStatusPayload interface.
 */
function parseWdaStatusPayload(json: unknown): WdaStatusPayload {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  const val =
    root['value'] && typeof root['value'] === 'object'
      ? (root['value'] as Record<string, unknown>)
      : root;

  const ready =
    typeof val['ready'] === 'boolean'
      ? val['ready']
      : typeof root['ready'] === 'boolean'
        ? root['ready']
        : val['state'] === 'success';

  const message =
    typeof val['message'] === 'string'
      ? val['message']
      : typeof root['message'] === 'string'
        ? root['message']
        : undefined;

  let device: string | undefined = undefined;
  if (typeof val['device'] === 'string') {
    device = val['device'];
  } else if (
    val['device'] &&
    typeof val['device'] === 'object' &&
    typeof (val['device'] as Record<string, unknown>)['name'] === 'string'
  ) {
    device = (val['device'] as Record<string, unknown>)['name'] as string;
  } else if (
    val['os'] &&
    typeof val['os'] === 'object' &&
    typeof (val['os'] as Record<string, unknown>)['name'] === 'string'
  ) {
    device = (val['os'] as Record<string, unknown>)['name'] as string;
  }

  let osVersion: string | undefined = undefined;
  if (
    val['os'] &&
    typeof val['os'] === 'object' &&
    typeof (val['os'] as Record<string, unknown>)['version'] === 'string'
  ) {
    osVersion = (val['os'] as Record<string, unknown>)['version'] as string;
  } else if (typeof val['osVersion'] === 'string') {
    osVersion = val['osVersion'];
  }

  let wifiIp: string | undefined = undefined;
  if (
    val['ios'] &&
    typeof val['ios'] === 'object' &&
    typeof (val['ios'] as Record<string, unknown>)['ip'] === 'string'
  ) {
    wifiIp = (val['ios'] as Record<string, unknown>)['ip'] as string;
  } else if (typeof val['wifiIp'] === 'string') {
    wifiIp = val['wifiIp'];
  }

  let wdaVersion: string | undefined = undefined;
  if (
    val['build'] &&
    typeof val['build'] === 'object' &&
    typeof (val['build'] as Record<string, unknown>)['version'] === 'string'
  ) {
    wdaVersion = (val['build'] as Record<string, unknown>)['version'] as string;
  } else if (typeof val['wdaVersion'] === 'string') {
    wdaVersion = val['wdaVersion'];
  }

  return {
    ready: Boolean(ready),
    message,
    device,
    osVersion,
    wifiIp,
    wdaVersion,
    raw: json,
  };
}

/**
 * Extracts a session ID and detects its response shape from a WDA POST /session response.
 */
function extractSessionId(
  json: unknown
): { sessionId: string; sessionIdShape: 'value.sessionId' | 'sessionId' } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const obj = json as Record<string, unknown>;

  // W3C standard: { value: { sessionId: "...", ... } }
  if (obj['value'] && typeof obj['value'] === 'object') {
    const val = obj['value'] as Record<string, unknown>;
    if (typeof val['sessionId'] === 'string' && val['sessionId'].trim()) {
      return { sessionId: val['sessionId'].trim(), sessionIdShape: 'value.sessionId' };
    }
  }

  // Legacy JSONWP: { sessionId: "...", ... }
  if (typeof obj['sessionId'] === 'string' && obj['sessionId'].trim()) {
    return { sessionId: obj['sessionId'].trim(), sessionIdShape: 'sessionId' };
  }

  return undefined;
}

/**
 * Creates a fetch-based WdaTransport bound to the given base URL.
 * Never throws on transport failure (returns {ok: false, error: 'ECONNREFUSED'|'TIMEOUT'|...}).
 * Truncates text output to 4000 characters and parses JSON defensively.
 */
export function createWdaTransport(baseUrl: string, defaultTimeoutMs = 15000): WdaTransport {
  const cleanBase = baseUrl.replace(/\/+$/, '');

  return {
    baseUrl: cleanBase,
    async request(
      method: 'GET' | 'POST' | 'DELETE',
      route: string,
      body?: unknown,
      timeoutMs?: number
    ): Promise<WdaResponse> {
      const cleanRoute = route.startsWith('/') ? route : `/${route}`;
      const url = `${cleanBase}${cleanRoute}`;
      const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
      const start = performance.now();

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeout),
        });

        const ms = Math.round(performance.now() - start);
        const textRaw = await res.text();
        const text = textRaw.length > 4000 ? textRaw.slice(0, 4000) : textRaw;

        let json: unknown = undefined;
        try {
          json = JSON.parse(textRaw);
        } catch {
          // Defensively ignore non-JSON response body
        }

        return {
          ok: res.ok,
          httpStatus: res.status,
          json,
          text,
          ms,
        };
      } catch (err: unknown) {
        const ms = Math.round(performance.now() - start);
        const errorCode = extractErrorCode(err);
        const msg = err instanceof Error ? err.message : String(err);

        return {
          ok: false,
          json: undefined,
          text: msg.length > 4000 ? msg.slice(0, 4000) : msg,
          ms,
          error: errorCode,
        };
      }
    },
  };
}

/**
 * Tries each candidate URL, accepts only a WDA-shaped /status body, returns undefined when
 * none qualify, and always returns the per-candidate attempts so an unreachable transport
 * is reported as a transport problem rather than "hardware unusable".
 */
export async function probeWdaCandidates(
  candidates: string[],
  timeoutMs = 4000
): Promise<
  | {
      baseUrl: string;
      status: WdaStatusPayload;
      attempts: Array<{
        baseUrl: string;
        ok: boolean;
        httpStatus?: number;
        error?: string;
        wdaShaped: boolean;
      }>;
    }
  | undefined
> {
  const attempts: Array<{
    baseUrl: string;
    ok: boolean;
    httpStatus?: number;
    error?: string;
    wdaShaped: boolean;
  }> = [];

  for (const candidate of candidates) {
    console.log(`[antifan:device] Probing WDA candidate at ${candidate}...`);
    const transport = createWdaTransport(candidate, timeoutMs);
    const res = await transport.request('GET', '/status', undefined, timeoutMs);
    const wdaShaped = isWdaStatusShaped(res.json);

    attempts.push({
      baseUrl: candidate,
      ok: res.ok,
      httpStatus: res.httpStatus,
      error: res.error,
      wdaShaped,
    });

    if (res.ok && wdaShaped) {
      const status = parseWdaStatusPayload(res.json);
      console.log(`[antifan:device] WDA candidate verified at ${candidate} (ready: ${status.ready})`);
      return {
        baseUrl: candidate,
        status,
        attempts,
      };
    }
  }

  console.log(`[antifan:device] No qualified WDA candidates found out of ${candidates.length} candidate(s)`);
  return undefined;
}

/**
 * Reads WDA /status and returns the normalized status payload.
 * Throws CapabilityError('DEVICE_WDA_NOT_READY', ...) when /status is unreachable or ready !== true.
 */
export async function readWdaStatus(
  transport: WdaTransport,
  timeoutMs?: number
): Promise<WdaStatusPayload> {
  const res = await transport.request('GET', '/status', undefined, timeoutMs);
  if (!res.ok || !isWdaStatusShaped(res.json)) {
    const failure = describeWdaFailure(res);
    console.log(`[antifan:device] readWdaStatus unreachable or invalid: ${failure}`);
    throw new CapabilityError(
      'DEVICE_WDA_NOT_READY',
      `WebDriverAgent is not ready: ${failure}. ${DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY}`,
      {
        failure,
        httpStatus: res.httpStatus,
        error: res.error,
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY,
      }
    );
  }

  const status = parseWdaStatusPayload(res.json);
  if (status.ready !== true) {
    console.log(`[antifan:device] readWdaStatus returned ready=false: ${status.message ?? 'ready is false'}`);
    throw new CapabilityError(
      'DEVICE_WDA_NOT_READY',
      `WebDriverAgent reported not ready: ${status.message ?? 'ready is false'}. ${DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY}`,
      {
        status,
        remediation: DEVICE_ERROR_REMEDIATION.DEVICE_WDA_NOT_READY,
      }
    );
  }

  return status;
}

/**
 * Queries WDA for screen dimensions, scale, and status bar size via /wda/screen.
 * Returns undefined when /wda/screen is unsupported on older WDA builds (never throws).
 */
export async function readWdaScreenInfo(
  transport: WdaTransport,
  timeoutMs?: number
): Promise<WdaScreenInfo | undefined> {
  try {
    const res = await transport.request('GET', '/wda/screen', undefined, timeoutMs);
    if (!res.ok || !res.json || typeof res.json !== 'object') {
      return undefined;
    }
    const raw = res.json as Record<string, unknown>;
    const val =
      raw['value'] && typeof raw['value'] === 'object'
        ? (raw['value'] as Record<string, unknown>)
        : raw;

    const width =
      typeof val['width'] === 'number'
        ? val['width']
        : typeof (val['screenSize'] as Record<string, unknown> | undefined)?.['width'] === 'number'
          ? ((val['screenSize'] as Record<string, unknown>)['width'] as number)
          : undefined;

    const height =
      typeof val['height'] === 'number'
        ? val['height']
        : typeof (val['screenSize'] as Record<string, unknown> | undefined)?.['height'] === 'number'
          ? ((val['screenSize'] as Record<string, unknown>)['height'] as number)
          : undefined;

    if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
      return undefined;
    }

    const scale = typeof val['scale'] === 'number' && val['scale'] > 0 ? val['scale'] : 1;

    let statusBarHeight = 0;
    if (
      val['statusBarSize'] &&
      typeof val['statusBarSize'] === 'object' &&
      typeof (val['statusBarSize'] as Record<string, unknown>)['height'] === 'number'
    ) {
      statusBarHeight = (val['statusBarSize'] as Record<string, unknown>)['height'] as number;
    } else if (typeof val['statusBarHeight'] === 'number') {
      statusBarHeight = val['statusBarHeight'];
    }

    return {
      width,
      height,
      scale,
      statusBarHeight,
    };
  } catch (err) {
    console.log('[antifan:device] readWdaScreenInfo failed gracefully:', err);
    return undefined;
  }
}

/**
 * Summarizes a WDA failure into a concise, single-line explanation.
 * Prefers value.message, else transport error, else HTTP <status>, first line only, <= 300 chars.
 */
export function describeWdaFailure(response: WdaResponse): string {
  let candidate: string | undefined = undefined;

  // 1. Prefer value.message or message in JSON response
  if (response.json && typeof response.json === 'object') {
    const raw = response.json as Record<string, unknown>;
    const val =
      raw['value'] && typeof raw['value'] === 'object'
        ? (raw['value'] as Record<string, unknown>)
        : undefined;

    if (val && typeof val['message'] === 'string' && val['message'].trim()) {
      candidate = val['message'].trim();
    } else if (typeof raw['message'] === 'string' && raw['message'].trim()) {
      candidate = raw['message'].trim();
    } else if (val && typeof val['error'] === 'string' && val['error'].trim()) {
      candidate = val['error'].trim();
    } else if (typeof raw['value'] === 'string' && raw['value'].trim()) {
      candidate = raw['value'].trim();
    }
  }

  // 2. Else the transport error
  if (!candidate && response.error) {
    candidate = response.error;
  }

  // 3. Else HTTP <status>
  if (!candidate && typeof response.httpStatus === 'number') {
    candidate = `HTTP ${response.httpStatus}`;
  }

  // 4. Fallback to response.text if available
  if (!candidate && response.text && response.text.trim()) {
    candidate = response.text.trim();
  }

  if (!candidate) {
    candidate = 'Unknown WDA failure';
  }

  // First line only, <= 300 chars
  const firstLine = candidate.split(/\r?\n/)[0] ?? '';
  return firstLine.slice(0, 300).trim();
}

/**
 * Creates a Safari automation session on the device.
 *
 * Tries the payload variants in strict order:
 * 1. 'w3c-alwaysMatch'
 * 2. 'flat-capabilities'
 * 3. 'legacy-desiredCapabilities'
 *
 * Omits initialUrl when osVersion is present and < 16.4 (WDA MobileSafari initialUrl limitation).
 * Throws CapabilityError('DEVICE_SESSION_FAILED', ...) listing each variant's failure message when all fail.
 *
 * Note: WDA automatically terminates any active session before creating a new one (Rule 1).
 */
export async function createSafariSession(
  transport: WdaTransport,
  options: { initialUrl?: string; osVersion?: string; timeoutMs?: number }
): Promise<{
  sessionId: string;
  sessionIdShape: 'value.sessionId' | 'sessionId';
  payloadVariant: 'w3c-alwaysMatch' | 'flat-capabilities' | 'legacy-desiredCapabilities';
}> {
  const caps: Record<string, unknown> = {
    bundleId: 'com.apple.mobilesafari',
    shouldWaitForQuiescence: false,
    waitForIdleTimeout: 0,
    animationCoolOffTimeout: 0,
    shouldUseCompactResponses: true,
    snapshotMaxDepth: 1,
    mjpegServerFramerate: 60,
    mjpegScalingFactor: 33,
    mjpegServerScreenshotQuality: 22,
    appLaunchStateTimeoutSec: 60,
    forceAppLaunch: true,
  };

  if (options.initialUrl && options.initialUrl.trim()) {
    if (isIosVersionBelow164(options.osVersion)) {
      console.log(
        `[antifan:device] Omitting initialUrl "${options.initialUrl}" because iOS ${options.osVersion} < 16.4`
      );
    } else {
      caps['initialUrl'] = options.initialUrl.trim();
    }
  }

  const variants: Array<{
    variant: 'w3c-alwaysMatch' | 'flat-capabilities' | 'legacy-desiredCapabilities';
    body: unknown;
  }> = [
    {
      variant: 'w3c-alwaysMatch',
      body: {
        capabilities: {
          alwaysMatch: caps,
        },
      },
    },
    {
      variant: 'flat-capabilities',
      body: {
        capabilities: caps,
      },
    },
    {
      variant: 'legacy-desiredCapabilities',
      body: {
        desiredCapabilities: caps,
      },
    },
  ];

  const timeoutMs = options.timeoutMs ?? 60000;
  const variantErrors: Array<{ variant: string; error: string }> = [];

  for (const { variant, body } of variants) {
    console.log(`[antifan:device] Attempting Safari session creation with variant "${variant}"...`);
    const res = await transport.request('POST', '/session', body, timeoutMs);
    if (res.ok) {
      const extracted = extractSessionId(res.json);
      if (extracted) {
        console.log(
          `[antifan:device] Safari session established: ${extracted.sessionId} (variant: ${variant}, shape: ${extracted.sessionIdShape})`
        );
        return {
          sessionId: extracted.sessionId,
          sessionIdShape: extracted.sessionIdShape,
          payloadVariant: variant,
        };
      }
    }

    const failure = describeWdaFailure(res);
    console.log(`[antifan:device] Session variant "${variant}" failed: ${failure}`);
    variantErrors.push({ variant, error: failure });
  }

  const failureSummary = variantErrors.map((v) => `${v.variant} (${v.error})`).join('; ');
  throw new CapabilityError(
    'DEVICE_SESSION_FAILED',
    `Failed to create Safari session on device: all payload variants failed: ${failureSummary}. ${DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED}`,
    {
      variantErrors,
      remediation: DEVICE_ERROR_REMEDIATION.DEVICE_SESSION_FAILED,
    }
  );
}
