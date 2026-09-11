import { evalOn } from '../.canary/tools/lib-rpc.mjs';

async function test() {
  const tabId = '70a8e41e-09a3-4734-bf6a-457a4c1ef9e7';
  const expr = `JSON.stringify((() => {
    const matches = [];
    for (const a of document.querySelectorAll('a[href*="hoplong"]')) {
      matches.push({ tag: 'a', href: a.getAttribute('href'), text: a.innerText.trim().slice(0, 40) });
    }
    for (const img of document.querySelectorAll('img[src*="hoplong"]')) {
      matches.push({ tag: 'img', src: img.getAttribute('src'), alt: img.getAttribute('alt') });
    }
    return matches;
  })())`;
  
  const raw = await evalOn(tabId, expr);
  console.log('Live Hoplong Matches:', JSON.parse(raw));
}

test().catch(err => console.error('Error:', err));
