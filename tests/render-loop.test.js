const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
let failures = 0;
const check = (condition, message) => {
  if (!condition) { failures++; console.error('FAIL:', message); }
};

check(source.includes('if (this._views.size) this._raf = requestAnimationFrame(this._renderTick);'), 'render loop stops when no Brain views remain');
check(source.includes('v.mount(); this._ensureRenderLoop(); return v;'), 'mounting a Brain view wakes the render loop');
check(!source.includes('this._raf = requestAnimationFrame(tick);'), 'legacy unconditional Brain RAF is gone');

if (failures) process.exit(1);
console.log('plexus-brain render loop regression checks passed');
