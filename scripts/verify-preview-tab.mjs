import { evalOn } from '../.canary/tools/lib-rpc.mjs';

async function test() {
  const tabId = '70a8e41e-09a3-4734-bf6a-457a4c1ef9e7';
  const expr = `JSON.stringify({
    title: document.title,
    docHeight: document.documentElement.scrollHeight,
    docWidth: document.documentElement.scrollWidth,
    hasHeader: !!document.querySelector('header, .header, #header'),
    hasFooter: !!document.querySelector('footer, .footer, #footer'),
    hoplongLeaks: document.body.innerHTML.includes('hoplongtech.com') || document.body.innerHTML.includes('img.hoplongtech.com'),
    totalLinks: document.querySelectorAll('a').length
  })`;
  
  const raw = await evalOn(tabId, expr);
  console.log('DOM Inspection:', JSON.parse(raw));
}

test().catch(err => console.error('Error:', err));
