import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'node:vm';
import {
  buildInspectStylesIsolatedScript,
  buildInspectRegionIsolatedScript,
} from '../../src/main/browser/scripts/advanced-inspection-scripts';

describe('Advanced Inspection Scripts Unit Tests', () => {
  it('buildInspectStylesIsolatedScript extracts box model, typography, layout, and custom properties on valid selector', async () => {
    const scriptStr = buildInspectStylesIsolatedScript({ selector: '#hero-title', properties: ['color', 'font-size'] });
    const script = new vm.Script(scriptStr);

    const mockElement = {
      tagName: 'H1',
      id: 'hero-title',
      className: 'heading main',
      isConnected: true,
      getBoundingClientRect: () => ({ top: 10, left: 20, right: 320, bottom: 60, width: 300, height: 50 }),
    };

    const mockComputedStyle = {
      length: 2,
      0: '--primary-color',
      1: '--font-base',
      getPropertyValue: (prop: string) => (prop === '--primary-color' ? '#3b82f6' : prop === '--font-base' ? 'Inter' : prop === 'color' ? 'rgb(15, 23, 42)' : prop === 'font-size' ? '24px' : ''),
      marginTop: '16px',
      marginRight: '0px',
      marginBottom: '16px',
      marginLeft: '0px',
      paddingTop: '8px',
      paddingRight: '8px',
      paddingBottom: '8px',
      paddingLeft: '8px',
      borderTopWidth: '1px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      borderLeftWidth: '1px',
      fontFamily: 'Inter, sans-serif',
      fontSize: '24px',
      fontWeight: '700',
      lineHeight: '32px',
      letterSpacing: '-0.02em',
      color: 'rgb(15, 23, 42)',
      textAlign: 'left',
      textDecoration: 'none',
      display: 'block',
      position: 'relative',
      zIndex: '1',
      opacity: '1',
      visibility: 'visible',
      overflow: 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      boxShadow: 'none',
      borderRadius: '4px',
      transform: 'none',
    };

    function MockElementClass() {}
    MockElementClass.prototype = {};
    Object.setPrototypeOf(mockElement, MockElementClass.prototype);

    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/test' },
        innerWidth: 1024,
        innerHeight: 768,
        getComputedStyle: () => mockComputedStyle,
      },
      document: {
        querySelector: (sel: string) => (sel === '#hero-title' ? mockElement : null),
        body: mockElement,
        documentElement: mockElement,
      },
      Element: MockElementClass,
    };

    const context = vm.createContext(sandbox);
    const result = (await script.runInContext(context)) as {
      ok: boolean;
      data: {
        target: { tag: string; id?: string };
        boxModel: { width: number; margin: { top: number } };
        typography: { fontSize: string; fontWeight: string };
        cssVariables: Record<string, string>;
        styles: Record<string, string>;
      };
    };

    assert.ok(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.target.tag, 'h1');
    assert.strictEqual(result.data.target.id, 'hero-title');
    assert.strictEqual(result.data.boxModel.width, 300);
    assert.strictEqual(result.data.boxModel.margin.top, 16);
    assert.strictEqual(result.data.typography.fontSize, '24px');
    assert.strictEqual(result.data.typography.fontWeight, '700');
    assert.strictEqual(result.data.cssVariables['--primary-color'], '#3b82f6');
    assert.strictEqual(result.data.styles['color'], 'rgb(15, 23, 42)');
    assert.strictEqual(result.data.styles['font-size'], '24px');
  });

  it('buildInspectStylesIsolatedScript fails closed with ELEMENT_NOT_FOUND when selector does not match', async () => {
    const scriptStr = buildInspectStylesIsolatedScript({ selector: '#non-existent' });
    const script = new vm.Script(scriptStr);

    function MockElementClass() {}
    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/test' },
      },
      document: {
        querySelector: () => null,
        body: null,
        documentElement: null,
      },
      Element: MockElementClass,
    };

    const context = vm.createContext(sandbox);
    const result = (await script.runInContext(context)) as { ok: boolean; error: string; code: string };

    assert.ok(result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ELEMENT_NOT_FOUND');
    assert.match(result.error, /not found/i);
  });

  it('buildInspectRegionIsolatedScript finds intersecting elements in coordinate rectangle', async () => {
    const scriptStr = buildInspectRegionIsolatedScript({ x: 0, y: 0, width: 500, height: 400 });
    const script = new vm.Script(scriptStr);

    function MockElementClass() {}

    const elIn = {
      tagName: 'BUTTON',
      id: 'submit-btn',
      className: 'btn primary',
      textContent: 'Submit Form',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 50, top: 100, right: 150, bottom: 140, width: 100, height: 40 }),
    };

    const elOut = {
      tagName: 'DIV',
      id: 'footer',
      className: '',
      textContent: 'Footer Content',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 600, top: 800, right: 1000, bottom: 900, width: 400, height: 100 }),
    };

    Object.setPrototypeOf(elIn, MockElementClass.prototype);
    Object.setPrototypeOf(elOut, MockElementClass.prototype);

    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/test' },
        innerWidth: 1024,
        innerHeight: 768,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', zIndex: '10' }),
      },
      document: {
        documentElement: {},
        body: {},
        querySelectorAll: () => [elIn, elOut],
      },
      Element: MockElementClass,
    };

    const context = vm.createContext(sandbox);
    const result = (await script.runInContext(context)) as {
      ok: boolean;
      data: {
        elementCount: number;
        elements: Array<{ id?: string; rect: { width: number }; textSnippet?: string }>;
      };
    };

    assert.ok(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.elementCount, 1);
    assert.ok(result.data.elements.length > 0);
    assert.strictEqual(result.data.elements[0]!.id, 'submit-btn');
    assert.strictEqual(result.data.elements[0]!.rect.width, 100);
    assert.strictEqual(result.data.elements[0]!.textSnippet, 'Submit Form');
  });

  it('buildInspectRegionIsolatedScript fails closed with ELEMENT_NOT_FOUND when anchor selector does not match', async () => {
    const scriptStr = buildInspectRegionIsolatedScript({ selector: '#missing-anchor' });
    const script = new vm.Script(scriptStr);

    function MockElementClass() {}
    const sandbox: Record<string, unknown> = {
      window: {
        location: { href: 'http://localhost/test' },
      },
      document: {
        querySelector: () => null,
      },
      Element: MockElementClass,
    };

    const context = vm.createContext(sandbox);
    const result = (await script.runInContext(context)) as { ok: boolean; error: string; code: string };

    assert.ok(result);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ELEMENT_NOT_FOUND');
    assert.match(result.error, /#missing-anchor/);
  });
});
