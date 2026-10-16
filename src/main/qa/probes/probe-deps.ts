/**
 * Narrow browser surface the storefront probes run against. Probes never see
 * `BrowserControlPort`: tests hand them a jsdom-backed implementation, the
 * capability layer hands them one bound to a live tab.
 */
import type { BrowserTarget } from '../../../shared/control-plane-contracts';
import type { BrowserControlPort } from '../../tools/browser-control-port';

export interface ProbeDeps {
  evalJs(expression: string): Promise<unknown>;
  click(selector: string): Promise<{ ok: boolean; error?: string }>;
  hover(selector: string): Promise<{ ok: boolean; error?: string }>;
  wait(ms: number): Promise<void>;
  navigate?(url: string): Promise<boolean>;
}

export interface ProbeFinding {
  ruleId: string;
  severity: 'critical' | 'warning' | 'info';
  selector?: string;
  message: string;
  measured?: Record<string, unknown>;
}

export interface ProbeResult<T> {
  measured: boolean;
  passed: boolean | null;
  findings: ProbeFinding[];
  data: T;
  error?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeProbeDeps(
  browser: BrowserControlPort,
  target: BrowserTarget,
  tabId: string,
  paneId: 'desktop' | 'mobile',
  signal?: AbortSignal
): ProbeDeps {
  return {
    evalJs: (expression) => browser.eval(target, expression, tabId, paneId),
    async click(selector) {
      try {
        const res = await browser.agentClick({ selector, tabId, paneId }, target, signal);
        return res.clicked ? { ok: true } : { ok: false, error: `click on '${selector}' was not delivered` };
      } catch (err) {
        return { ok: false, error: errorText(err) };
      }
    },
    async hover(selector) {
      try {
        const res = await browser.agentHover({ selector, tabId, paneId }, target, signal);
        return res.hovered ? { ok: true } : { ok: false, error: res.hint ?? `hover on '${selector}' did not activate :hover` };
      } catch (err) {
        return { ok: false, error: errorText(err) };
      }
    },
    wait: (ms) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, Math.max(0, Math.min(ms, 10_000)));
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    async navigate(url) {
      const res = await browser.navigate(target, url, tabId);
      return res.navigated === true;
    },
  };
}
