import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('clone/hoplongtech/index.html');
let html = fs.readFileSync(filePath, 'utf8');

// Strip wire:snapshot attributes (both single and double quoted, with escaped entities)
html = html.replace(/\swire:snapshot="[^"]*"/gi, '');
html = html.replace(/\swire:effects="[^"]*"/gi, '');
html = html.replace(/\swire:memo="[^"]*"/gi, '');
html = html.replace(/\swire:id="[^"]*"/gi, '');
html = html.replace(/\swire:initial-data="[^"]*"/gi, '');
html = html.replace(/<!--\[if (?:START)?BLOCK\]><!\[endif\]-->/gi, '');
html = html.replace(/<!--\[if ENDBLOCK\]><!\[endif\]-->/gi, '');

// Clean any leftover raw json string that might have spilled into text nodes
html = html.replace(/&quot;:\{&quot;[^<]+?\}(?:,\s*&quot;[^<]+?\})*/g, '');

fs.writeFileSync(filePath, html, 'utf8');
console.log('Cleaned static HTML successfully. New size:', html.length, 'bytes');
