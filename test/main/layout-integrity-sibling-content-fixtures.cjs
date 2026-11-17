// Fixture pages for the sibling-content-overlap rule. Boxes are fixed-size so the overlap share is
// known: a negative margin pulls the second box over the first while keeping the text lines apart,
// so only the box rule (not text-over-text) can see the pair.
const page = (css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:20px;font:16px/20px Arial,sans-serif;background:#fff;color:#111}
.box{box-sizing:border-box;width:200px;height:40px;flex-shrink:0;background:#eef}
${css}
</style></head><body>${body}</body></html>`;

module.exports = [
  {
    id: 'grid-text-siblings-overlap',
    html: page(
      '.row{display:grid;grid-template-columns:200px 200px;width:400px}.b{margin-left:-60px}',
      '<div class="row"><div class="box a" id="alpha">Alpha</div><div class="box b" id="bravo">Bravo</div></div>'
    ),
  },
  {
    id: 'flex-button-over-text-block',
    html: page(
      '.row{display:flex;width:400px}button{box-sizing:border-box;width:120px;height:40px;margin-left:-40px;flex-shrink:0}',
      '<div class="row"><div class="box">Some text block</div><button type="button">Buy</button></div>'
    ),
  },
  {
    id: 'absolute-badge-inside-card',
    html: page(
      '.card{position:relative;width:200px;height:100px}.badge{position:absolute;top:0;right:0;width:40px;height:20px;background:#fcc}',
      '<div class="card"><p style="margin:0">Card title</p><span class="badge">New</span></div>'
    ),
  },
  {
    id: 'parent-child-pair',
    html: page(
      '.outer{width:240px;height:90px;background:#eef}.inner{width:100px;height:30px;margin-top:10px;background:#dfd}',
      '<div><div class="outer">Outer text<div class="inner">Inner</div></div></div>'
    ),
  },
  {
    id: 'carousel-slides',
    html: page(
      '.swiper-wrapper{display:flex;width:400px}.swiper-slide{margin-left:-60px}.swiper-slide:first-child{margin-left:0}',
      '<div class="swiper-wrapper"><div class="swiper-slide box">Slide one</div><div class="swiper-slide box">Slide two</div></div>'
    ),
  },
  {
    id: 'sticky-header-over-content',
    html: page(
      '.wrap{width:400px}.head{position:sticky;top:0;height:60px}.main{margin-top:-30px;padding-top:60px;height:140px}',
      '<div class="wrap"><div class="head">Header</div><div class="main">Content</div></div>'
    ),
  },
  {
    id: 'different-z-index-layers',
    html: page(
      '.row{display:flex;width:400px}.a{position:relative;z-index:1}.b{position:relative;z-index:2;margin-left:-60px}',
      '<div class="row"><div class="box a">Alpha</div><div class="box b">Bravo</div></div>'
    ),
  },
  {
    id: 'four-pixel-overlap',
    html: page(
      '.row{display:flex;width:400px}.b{margin-left:-4px}',
      '<div class="row"><div class="box a">Alpha</div><div class="box b">Bravo</div></div>'
    ),
  },
  {
    id: 'five-overlapping-pairs',
    html: page(
      '.row{display:flex;width:700px}.box{width:100px}.row .box+.box{margin-left:-50px}',
      '<div class="row"><div class="box">One</div><div class="box">Two</div><div class="box">Three</div><div class="box">Four</div><div class="box">Five</div><div class="box">Six</div></div>'
    ),
  },
  {
    id: 'text-over-text-pair',
    html: page(
      '.row{display:flex;width:400px}.b{margin-left:-100px}',
      '<div class="row"><div class="box a">Overlapping words</div><div class="box b">Second line of words</div></div>'
    ),
  },
  {
    id: 'floating-label-on-own-field',
    html: page(
      '.fl{position:relative;width:300px;margin:24px 0}.fl input{display:block;width:100%;height:50px;box-sizing:border-box;padding:14px 16px;border:1px solid #999}.fl label{position:absolute;left:12px;top:-9px;padding:0 4px;background:#fff;font-size:12px}',
      '<div class="fl"><input id="em" type="email" value="khach@example.vn"><label for="em">Email dang nhap</label></div>'
    ),
  },
  {
    id: 'read-more-button-over-clamped-text',
    html: page(
      '.desc{position:relative;width:300px;max-height:60px;overflow:hidden;line-height:20px}.desc p{margin:0}.more{position:absolute;left:100px;bottom:2px;width:96px;height:28px}',
      '<div class="desc"><p>Line one of a long description. Line two of a long description. Line three of a long description. Line four of a long description. Line five of a long description. Line six of a long description.</p><button class="more" type="button">Xem them</button></div>'
    ),
  },
  {
    id: 'absolute-button-over-unclipped-text',
    html: page(
      '.desc{position:relative;width:300px;line-height:20px}.desc p{margin:0}.more{position:absolute;left:100px;top:30px;width:96px;height:28px}',
      '<div class="desc"><p>Line one of a description. Line two of a description.</p><button class="more" type="button">Xem them</button></div>'
    ),
  },
  {
    id: 'label-over-different-input',
    html: page(
      '.fl{position:relative;width:300px;margin:24px 0}.fl input{display:block;width:100%;height:50px;box-sizing:border-box;padding:14px 16px;border:1px solid #999}.fl label{position:absolute;left:12px;top:-9px;padding:0 4px;background:#fff;font-size:12px}',
      '<div class="fl"><input id="first" type="text" value="first value"><label for="second">Second field</label></div><div><input id="second" type="text" value="second value"></div>'
    ),
  },
  {
    id: 'label-in-other-parent-over-third-element',
    html: page(
      '.box{position:relative;width:300px;margin:24px 0}.box p{margin:0;line-height:20px}.box label{position:absolute;left:12px;top:12px;padding:0 4px;background:#fff;font-size:12px}',
      '<div class="box"><button type="button" id="third" style="display:block;width:100%;height:20px">Third element</button><label for="elsewhere">Elsewhere label</label></div><div><input id="elsewhere" type="text" value="far away"></div>'
    ),
  },
  {
    // The paragraph must stay on one line: a wrapped paragraph is taller than the label, which then lies wholly
    // inside the paragraph box and is skipped as nesting (pre-existing rule), not as a label exemption.
    id: 'label-in-other-parent-over-paragraph',
    html: page(
      '.box{position:relative;width:300px;margin:24px 0}.box p{margin:0;line-height:20px}.box label{position:absolute;left:12px;top:12px;padding:0 4px;background:#fff;font-size:12px}',
      '<div class="box"><p>Short paragraph</p><label for="elsewhere">Elsewhere label</label></div><div><input id="elsewhere" type="text" value="far away"></div>'
    ),
  },
  {
    id: 'read-more-over-hidden-container-that-fits',
    html: page(
      '.desc{position:relative;width:300px;height:80px;overflow:hidden;line-height:20px}.desc p{margin:0}.more{position:absolute;left:100px;top:30px;width:96px;height:28px}',
      '<div class="desc"><p>Line one of a description. Line two of a description.</p><button class="more" type="button">Xem them</button></div>'
    ),
  },
];
