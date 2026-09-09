(() => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      id: el.id || '',
      x: Math.round(b.x + window.scrollX),
      y: Math.round(b.y + window.scrollY),
      w: Math.round(b.width),
      h: Math.round(b.height),
    };
  };
  const out = [];
  const push = (label, el) => { if (el) out.push({ label, ...r(el) }); };
  push('doc', document.documentElement);
  push('body', document.body);
  push('header', document.querySelector('header'));
  push('main', document.querySelector('main'));
  const sections = Array.from(document.querySelectorAll('section'));
  sections.forEach((s, i) => push('section[' + i + ']', s));
  push('footer', document.querySelector('div.site-footer'));
  push('notice-cart', document.querySelector('div.notice-cart'));
  return {
    url: location.href,
    vw: window.innerWidth,
    vh: window.innerHeight,
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    nodes: out,
  };
})()
