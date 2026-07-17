const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
let failures = 0;
const check = (condition, message) => {
  if (!condition) { failures++; console.error('FAIL:', message); }
};

check(source.includes("api.contract === 'thymer-semantic-v1' && api.version === 1"), 'Brain validates the public semantic ABI');
check(source.includes('api.similarTo(recordGuid'), 'Brain semantic lens uses similarTo(record)');
check(source.includes("unitKinds: ['record']"), 'Brain requests record-level results');
check(source.includes('native-lexical-fallback'), 'Brain keeps a bounded native fallback');
check(!source.includes('Xenova/all-MiniLM-L6-v2'), 'Brain no longer owns a MiniLM model');
check(!source.includes("import('https://cdn.jsdelivr.net/npm/@huggingface/transformers"), 'Brain no longer imports remote model code');
check(!source.includes('this.plugin._embed('), 'Brain no longer embeds titles one at a time');

if (failures) process.exit(1);
console.log('plexus-brain shared semantic-service checks passed');
