import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { ProbeDeps } from '../../src/main/qa/probes/probe-deps';

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => JsdomInstance;

export interface JsdomInstance {
  window: Window & typeof globalThis & { eval: (src: string) => unknown; fetch: unknown };
}

export interface FetchRoute {
  ok?: boolean;
  html?: string;
  json?: unknown;
}

export const STOREFRONT_ORIGIN = 'https://shop.example';

function loadJsdom(): JsdomCtor {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)] : [path.dirname(__filename)];
  const resolved = req.resolve('jsdom', { paths: searchPaths });
  // jsdom ships no bundled types; the module is asserted to its documented export shape.
  return (req(resolved) as { JSDOM: JsdomCtor }).JSDOM;
}

export function readProbeFixture(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'test/fixtures/probes', name), 'utf8');
}

export function openPage(html: string, opts: { url?: string; routes?: Record<string, FetchRoute> } = {}): JsdomInstance {
  const JSDOM = loadJsdom();
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: opts.url ?? `${STOREFRONT_ORIGIN}/products/ao-so-mi` });
  const routes = opts.routes;
  if (routes) {
    const stub = async (input: string) => {
      const route = routes[String(input)];
      if (!route || route.ok === false) return { ok: false, status: 404, text: async () => '', json: async () => null };
      return { ok: true, status: 200, text: async () => route.html ?? '', json: async () => route.json };
    };
    dom.window.fetch = stub as unknown as typeof fetch;
  }
  return dom;
}

export interface DomDeps {
  deps: ProbeDeps;
  clicks: string[];
  navigations: string[];
  submitted: () => boolean;
}

/** Page results cross the realm boundary as JSON, the same way CDP returnByValue delivers them. */
export function makeDomDeps(dom: JsdomInstance, opts: { navigate?: boolean } = {}): DomDeps {
  const clicks: string[] = [];
  const navigations: string[] = [];
  let formSubmitted = false;
  dom.window.document.addEventListener('submit', () => {
    formSubmitted = true;
  });
  const deps: ProbeDeps = {
    async evalJs(expression: string): Promise<unknown> {
      const raw = await dom.window.eval(expression);
      return raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
    },
    async click(selector: string) {
      clicks.push(selector);
      const el = dom.window.document.querySelector(selector) as HTMLElement | null;
      if (!el) return { ok: false, error: `no element for ${selector}` };
      el.click();
      return { ok: true };
    },
    async hover(selector: string) {
      return dom.window.document.querySelector(selector) ? { ok: true } : { ok: false, error: `no element for ${selector}` };
    },
    async wait() {},
  };
  if (opts.navigate) {
    deps.navigate = async (url: string) => {
      navigations.push(url);
      return true;
    };
  }
  return { deps, clicks, navigations, submitted: () => formSubmitted };
}
