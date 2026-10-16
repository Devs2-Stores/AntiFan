/**
 * The renderer's terminal file-link provider, run against the shipped link module: link ranges are
 * buffer cells, so a wide glyph before a path and a path the terminal wrapped onto the next row both
 * underline exactly the printed path.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { FakeTerminal, loadStandalone } from './standalone-harness';

interface ProvidedLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
}

function provide(term: FakeTerminal, y: number): Promise<ProvidedLink[]> {
  const provider = term.linkProviders[0];
  assert.ok(provider, 'the renderer registered a file link provider');
  // JSON round-trip: the links are objects from the renderer's own realm.
  return new Promise((resolve) => provider.provideLinks(y, (links) => resolve(JSON.parse(JSON.stringify(links ?? [])) as ProvidedLink[])));
}

describe('terminal file link provider', () => {
  const attach = (term: FakeTerminal): void => {
    const harness = loadStandalone();
    harness.read<(t: unknown, id: string) => unknown>('attachFileLinksProvider')(term, 's1');
  };

  it('places a link after wide glyphs on the cells it was printed in', async () => {
    const term = new FakeTerminal();
    term.setBufferRows([{ text: '漢字 E:/Work/x.md done' }]);
    attach(term);
    const links = await provide(term, 1);
    assert.deepStrictEqual(links.map((l) => [l.text, l.range]), [
      ['E:/Work/x.md', { start: { x: 6, y: 1 }, end: { x: 17, y: 1 } }],
    ]);
  });

  it('keeps a spaced path the terminal wrapped onto the next row as one link', async () => {
    const term = new FakeTerminal();
    term.setBufferRows([{ text: 'see E:/Work/S2 Sky' }, { text: ' Fashion/a.md now', wrapped: true }]);
    attach(term);
    const expected = [['E:/Work/S2 Sky Fashion/a.md', { start: { x: 5, y: 1 }, end: { x: 13, y: 2 } }]];
    assert.deepStrictEqual((await provide(term, 1)).map((l) => [l.text, l.range]), expected);
    assert.deepStrictEqual((await provide(term, 2)).map((l) => [l.text, l.range]), expected);
  });

  it('links a numbered spaced folder whole instead of its tail', async () => {
    const term = new FakeTerminal();
    term.setBufferRows([{ text: '- E:/Work/1. Intro/a.md' }]);
    attach(term);
    assert.deepStrictEqual((await provide(term, 1)).map((l) => l.text), ['E:/Work/1. Intro/a.md']);
  });
});
