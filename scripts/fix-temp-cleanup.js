const fs = require('fs');

const file = 'e:/Work/apps/antigravity-browser/test/browser-javascript-integration.test.cjs';
let code = fs.readFileSync(file, 'utf8');

const targetOld = `async function removeTempDirectoryWhenUnlocked(directory, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}`;

const targetNew = `async function removeTempDirectoryWhenUnlocked(directory, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); } catch {}
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}`;

if (code.includes(targetOld)) {
  code = code.replace(targetOld, targetNew);
  fs.writeFileSync(file, code, 'utf8');
  console.log('SUCCESS: browser-javascript-integration.test.cjs cleanup resilience updated!');
} else {
  console.log('Target block already updated or not found');
}
