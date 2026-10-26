import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, LIST_TAB_FIELDS, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';

const target: BrowserTarget = {
  projectId: 'proj',
  workspaceId: 'ws',
  runtimeId: 'rt',
  tabId: 'tab-1',
  browserEpoch: 1,
  documentGeneration: 1,
};

const rows = [
  { id: 'tab-1', url: 'https://shop.example/', title: 'Home', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 },
  { id: 'tab-2', url: 'https://shop.example/products/a', title: 'A', isLoading: false, canGoBack: true, canGoForward: false, zoomFactor: 1 },
  { id: 'tab-3', url: 'https://docs.example/Products/B', title: 'B', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 },
];

function makePort(): BrowserControlPort {
  const host = {
    getTabList: () => rows,
    hasTab: (id: string) => rows.some((row) => row.id === id),
  } as unknown as BrowserHostPort;
  return new BrowserControlPort(host);
}

const ids = (list: unknown[]): string[] => list.flatMap((row) => (row && typeof row === 'object' && 'id' in row && typeof row.id === 'string' ? [row.id] : []));

describe('tabs.list filters', () => {
  it('returns every row with no filter', () => {
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global' })), ['tab-1', 'tab-2', 'tab-3']);
  });

  it('urlContains keeps rows whose URL contains the text, case-insensitively', () => {
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global', urlContains: 'products' })), ['tab-2', 'tab-3']);
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global', urlContains: 'docs.example' })), ['tab-3']);
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global', urlContains: 'nothing-matches' })), []);
  });

  it('limit caps the rows after the URL filter', () => {
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global', limit: 2 })), ['tab-1', 'tab-2']);
    assert.deepEqual(ids(makePort().listTabs({ target, scope: 'global', urlContains: 'products', limit: 1 })), ['tab-2']);
  });

  it('fields projects each row to the named columns and always keeps id', () => {
    const projected = makePort().listTabs({ target, scope: 'global', fields: ['url', 'isBoundTab'] }) as Array<Record<string, unknown>>;
    assert.deepEqual(projected[0], { id: 'tab-1', url: 'https://shop.example/', isBoundTab: true });
    assert.deepEqual(Object.keys(projected[1]!).sort(), ['id', 'isBoundTab', 'url']);
  });

  it('refuses an unknown field and names the valid ones', () => {
    assert.throws(
      () => makePort().listTabs({ target, scope: 'global', fields: ['url', 'urll'] }),
      (err: unknown) => err instanceof CapabilityError
        && err.code === 'INVALID_ARGUMENT'
        && Array.isArray(err.details?.unknownFields) && err.details.unknownFields[0] === 'urll'
        && Array.isArray(err.details?.validFields) && err.details.validFields.includes('url')
    );
    assert.ok(LIST_TAB_FIELDS.includes('isBoundTab'));
  });

  it('refuses a non-positive or fractional limit', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => makePort().listTabs({ target, scope: 'global', limit }),
        (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT',
        `limit ${limit}`
      );
    }
  });
});
