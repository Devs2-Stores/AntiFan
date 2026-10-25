import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { markdownAssetUrl, renderMarkdown, resolveMarkdownPath, sanitizeMarkdownUrl } from '../../src/shared/markdown-render';

const render = (source: string): string => renderMarkdown(source);

describe('Markdown renderer', () => {
  it('escapes raw HTML and never emits an element the source wrote', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nplain <b>bold</b> text');
    assert.ok(!/<script/i.test(html), html);
    assert.ok(!/<img/i.test(html), html);
    assert.ok(!/<b>/i.test(html), html);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('drops javascript:, data: and UNC targets from links and images', () => {
    const html = render('[x](javascript:alert(1)) [y](JaVa\tScRiPt:alert(1)) [z](data:text/html;base64,AAAA) ![i](\\\\\\\\server\\\\share\\\\a.png) ![j](//evil/x.png)');
    assert.ok(!/href="javascript/i.test(html), html);
    assert.ok(!/<a /.test(html), html);
    assert.ok(!/<img/.test(html), html);
    assert.ok(!/src=/.test(html), html);
  });

  it('keeps attribute-breaking characters in titles and alt text inert', () => {
    const html = render('[a](https://example.com "x\\" onmouseover=\\"alert(1)") ![alt " onerror="x](https://example.com/a.png)');
    assert.match(html, /title="x&quot; onmouseover=&quot;alert\(1\)">a<\/a>/);
    assert.match(html, /alt="alt &quot; onerror=&quot;x" data-md-alt=/);
    assert.ok(!/<[^>]* onerror="/.test(html) && !/ onmouseover="/.test(html), html);
  });

  it('renders headings with stable anchors, repeated titles get a suffix', () => {
    const html = render('# Cách tính\n\ntext\n\n## Cách tính\n\nSetext\n======\n');
    assert.match(html, /<h1 data-md-id="cách-tính">Cách tính<\/h1>/);
    assert.match(html, /<h2 data-md-id="cách-tính-1">Cách tính<\/h2>/);
    assert.match(html, /<h1 data-md-id="setext">Setext<\/h1>/);
  });

  it('renders the pricing-report shape: a table whose cells carry code, bold and pipes in code', () => {
    const source = [
      '| Mẫu | Giá `model_price` | Ghi chú |',
      '|---|:---:|---:|',
      '| Studio **480P** | `0,0042` | tính theo `a \\| b` |',
      '| Cinema | 1 |',
    ].join('\n');
    const html = render(source);
    assert.match(html, /<th>Mẫu<\/th><th style="text-align:center">Giá <code class="md-inline-code">model_price<\/code><\/th><th style="text-align:right">Ghi chú<\/th>/);
    assert.match(html, /<td>Studio <strong>480P<\/strong><\/td>/);
    assert.match(html, /<code class="md-inline-code">a \| b<\/code>/);
    // a short row is padded to the header's width
    assert.equal((html.match(/<tr>/g) ?? []).length, 3);
    assert.match(html, /<td style="text-align:center">1<\/td><td style="text-align:right"><\/td>/);
  });

  it('nests lists, honours ordered start numbers and task items', () => {
    const html = render('1. one\n   - inner a\n   - inner b\n2. two\n\n- [x] done\n- [ ] open\n\n3. late');
    assert.match(html, /<ol><li>one\n<ul><li>inner a<\/li><li>inner b<\/li><\/ul><\/li><li>two<\/li><\/ol>/);
    assert.match(html, /<ul class="md-task-list"><li class="md-task-item"><input type="checkbox" class="md-task" disabled checked> done<\/li><li class="md-task-item"><input type="checkbox" class="md-task" disabled> open<\/li><\/ul>/);
    assert.match(html, /<ol start="3"><li>late<\/li><\/ol>/);
  });

  it('wraps loose list items in paragraphs and leaves tight ones bare', () => {
    assert.match(render('- a\n- b'), /<li>a<\/li><li>b<\/li>/);
    assert.match(render('- a\n\n- b'), /<li><p>a<\/p><\/li><li><p>b<\/p><\/li>/);
  });

  it('shows fenced code verbatim, including markup and Markdown syntax, and uses the highlighter only when it answers', () => {
    const source = '```html\n<div class="a">**not bold**</div>\n```\n\n```text\n# not a heading\n```';
    const plain = render(source);
    assert.match(plain, /<pre class="md-code" data-lang="html"><code>&lt;div class=&quot;a&quot;&gt;\*\*not bold\*\*&lt;\/div&gt;<\/code><\/pre>/);
    assert.match(plain, /<code># not a heading<\/code>/);
    const seen: string[] = [];
    const highlighted = renderMarkdown(source, {
      highlight: (code, lang) => {
        seen.push(lang);
        return lang === 'html' ? '<span class="tok-tag">X</span>' : null;
      },
    });
    assert.deepEqual(seen, ['html', 'text']);
    assert.match(highlighted, /<code><span class="tok-tag">X<\/span><\/code>/);
    assert.match(highlighted, /<code># not a heading<\/code>/);
  });

  it('keeps a code fence open to the end of input rather than swallowing nothing', () => {
    assert.match(render('```js\nconst a = 1;\nstill code'), /<code>const a = 1;\nstill code<\/code>/);
  });

  it('applies emphasis without touching code spans, escapes or intra-word underscores', () => {
    const html = render('**bold** *em* ~~gone~~ `**raw**` \\*lit\\* snake_case_name and 2*3*4');
    assert.match(html, /<strong>bold<\/strong> <em>em<\/em> <del>gone<\/del>/);
    assert.match(html, /<code class="md-inline-code">\*\*raw\*\*<\/code>/);
    assert.match(html, /\*lit\*/);
    assert.match(html, /snake_case_name/);
    assert.match(html, /2\*3\*4/);
  });

  it('resolves links: inline, reference, autolink and bare URLs', () => {
    const html = render('[doc](./a.md "T") and [ref][r] and <https://example.com/x> and see https://example.com/y.\n\n[r]: https://example.com/r');
    assert.match(html, /<a class="md-link" href="\.\/a\.md" data-md-href="\.\/a\.md" title="T">doc<\/a>/);
    assert.match(html, /<a class="md-link" href="https:\/\/example\.com\/r"[^>]*>ref<\/a>/);
    assert.match(html, /<a class="md-link" href="https:\/\/example\.com\/x"[^>]*>https:\/\/example\.com\/x<\/a>/);
    assert.match(html, /href="https:\/\/example\.com\/y"[^>]*>https:\/\/example\.com\/y<\/a>\./);
    assert.ok(!html.includes('[r]:'), 'the definition line is not shown');
  });

  it('routes an image through resolveImage and drops it when that returns null', () => {
    const kept = renderMarkdown('![logo](<img/a b.png>)', { resolveImage: (href) => `file:///X/${href}` });
    assert.match(kept, /<img class="md-img" src="file:\/\/\/X\/img\/a b\.png" alt="logo"/);
    const dropped = renderMarkdown('![logo](img/a.png)', { resolveImage: () => null });
    assert.match(dropped, /<span class="md-img-missing">logo<\/span>/);
  });

  it('renders quotes, rules, hard breaks and hides HTML comments', () => {
    const html = render('> quoted\n> more\n\n---\n\nline one  \nline two\\\nline three\n\n<!-- hidden\nstill hidden -->\n\nafter');
    assert.match(html, /<blockquote><p>quoted\nmore<\/p><\/blockquote>/);
    assert.match(html, /<hr>/);
    assert.match(html, /line one<br>line two<br>line three/);
    assert.ok(!html.includes('hidden'), html);
    assert.match(html, /<p>after<\/p>/);
  });

  it('survives hostile nesting and unterminated constructs without throwing', () => {
    assert.doesNotThrow(() => render('>'.repeat(5000) + ' deep'));
    assert.doesNotThrow(() => render('- a\n'.repeat(1) + ' '.repeat(2) + '- b\n'.repeat(2000)));
    assert.doesNotThrow(() => render('[unterminated](http://x ![a](b `code **bold'));
    assert.doesNotThrow(() => render('\u0001\u0002 \u00010\u0002 placeholder lookalike'));
    assert.ok(!render('\u00010\u0002').includes('\u0001'));
  });
});

describe('Markdown link and asset resolution', () => {
  it('sanitizeMarkdownUrl allows http(s), mailto, file:///, drive and relative paths only', () => {
    for (const ok of ['https://a.b/c', 'http://a.b', './x.md', '../x.md', '#section', 'E:/Work/a.png', 'E:\\Work\\a.png', 'file:///E:/a.png']) {
      assert.equal(sanitizeMarkdownUrl(ok), ok, ok);
    }
    assert.equal(sanitizeMarkdownUrl('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(sanitizeMarkdownUrl('mailto:a@b.c', 'image'), null);
    for (const bad of ['javascript:alert(1)', ' java\nscript:alert(1)', 'vbscript:x', 'data:text/html,x', 'file://server/share/a.png', '//cdn/x.png', '\\\\server\\share\\x.png', '/\\server/share/a.png', '\\/server/share/a.png', 'file:////server/share/a.png', 'file://///server/share/a.png', '']) {
      assert.equal(sanitizeMarkdownUrl(bad), null, JSON.stringify(bad));
    }
    assert.equal(sanitizeMarkdownUrl('data:image/png;base64,AAAA', 'image'), 'data:image/png;base64,AAAA');
    assert.equal(sanitizeMarkdownUrl('data:image/png;base64,AAAA', 'link'), null);
  });

  it('resolveMarkdownPath resolves against the file, drops query/hash, decodes %20 and handles .. and drive roots', () => {
    const base = 'E:\\Work\\Gác\\plans\\reports\\research.md';
    assert.equal(resolveMarkdownPath(base, 'other.md'), 'E:/Work/Gác/plans/reports/other.md');
    assert.equal(resolveMarkdownPath(base, './sub/a%20b.md#part'), 'E:/Work/Gác/plans/reports/sub/a b.md');
    assert.equal(resolveMarkdownPath(base, '../../x.md?raw=1'), 'E:/Work/Gác/x.md');
    assert.equal(resolveMarkdownPath(base, '../../../../../../x.md'), 'E:/x.md');
    assert.equal(resolveMarkdownPath(base, 'D:\\Other\\y.md'), 'D:/Other/y.md');
    assert.equal(resolveMarkdownPath(base, '/Work/z.md'), 'E:/Work/z.md');
    assert.equal(resolveMarkdownPath(base, 'file:///D:/Other/y%20z.md'), 'D:/Other/y z.md');
    assert.equal(resolveMarkdownPath(base, '#anchor'), null);
    assert.equal(resolveMarkdownPath(base, 'https://example.com/a.md'), null);
    assert.equal(resolveMarkdownPath('/home/u/doc.md', 'img/a.png'), '/home/u/img/a.png');
  });

  it('markdownAssetUrl yields a file URL for local targets and passes http(s)/data through', () => {
    const base = 'E:\\Work\\Gác\\plans\\r.md';
    assert.equal(markdownAssetUrl(base, 'img/a b.png#frag'), `file:///E:/Work/${encodeURI('Gác')}/plans/img/a%20b.png`);
    assert.equal(markdownAssetUrl(base, 'https://x.y/z.png'), 'https://x.y/z.png');
    // Whatever a target looks like, a resolved local URL never names a host (that would be a UNC share).
    for (const sneaky of ['//server/share/a.png', '/\\server/share/a.png', '\\/server/share/a.png', 'file:////server/share/a.png', '..\\..\\..\\..\\..\\..\\\\server\\a.png']) {
      const url = markdownAssetUrl(base, sneaky);
      assert.ok(url === null || /^file:\/\/\/[A-Za-z]:\//.test(url), `${sneaky} -> ${url}`);
    }
    assert.equal(markdownAssetUrl(base, 'data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    assert.equal(markdownAssetUrl(base, '#x'), null);
  });
});
