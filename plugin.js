'use strict';
/*
 * Plexus Brain — native Thymer TheBrain-style radial graph (from scratch, no @excalidraw / no ExcaliBrain runtime dep).
 * Derives a record's neighbourhood from Thymer's OWN data: incoming backreferences + outbound ref segments,
 * lays them out radially around a focus node, and lets you click any node to re-centre the "plex".
 * Single-file plugin.js. Roadmap: ~/plexus/BRAIN-ROADMAP.md. Deploy: git push -> Plugins-Manager reinstall.
 */

const BRAIN_VERSION = '0.4.0';
const PANEL_ID = 'plexus-brain';
const TEST_HOOKS = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── camera ───────── */
class Camera {
  constructor(x = 0, y = 0, zoom = 1) { this.x = x; this.y = y; this.zoom = zoom; }
  screenToWorld(sx, sy) { return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y }; }
  worldToScreen(wx, wy) { return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom }; }
  zoomAt(sx, sy, f) { const nz = Math.min(6, Math.max(0.1, this.zoom * f)); const wx = sx / this.zoom + this.x, wy = sy / this.zoom + this.y; this.x = wx - sx / nz; this.y = wy - sy / nz; this.zoom = nz; }
}

/* ───────── ontology: derive a focus record's neighbours from Thymer data ───────── */
function refGuidsFromLineItems(items) {
  const out = [];
  for (const li of (items || [])) {
    let segs = null; try { segs = li.segments || []; } catch (_e) { segs = []; }
    for (const s of segs) { if (s && s.type === 'ref' && s.text && s.text.guid) out.push(s.text.guid); }
  }
  return out;
}
// Returns { focus:{guid,title}, neighbours:[{guid,title,dir}] }  dir: 'in'|'out'
async function deriveNeighbourhood(plugin, guid) {
  const rec = await plugin.data.getRecord(guid);
  if (!rec) return { focus: { guid, title: '(not found)' }, neighbours: [] };
  const focus = { guid, title: (rec.getName && rec.getName()) || 'Untitled' };
  const seen = new Set([guid]); const neighbours = [];
  // incoming — records that link to the focus
  try { const back = await rec.getBackReferenceRecords(); for (const r of (back || [])) { const g = r.guid; if (g && !seen.has(g)) { seen.add(g); neighbours.push({ guid: g, title: (r.getName && r.getName()) || 'Untitled', dir: 'in' }); } } } catch (_e) {}
  const addOut = async (g, kind) => {
    if (!g || seen.has(g)) return; seen.add(g);
    let title = 'Untitled'; try { const t = await plugin.data.getRecord(g); if (t) title = (t.getName && t.getName()) || title; else return; } catch (_e) { return; }
    neighbours.push({ guid: g, title, dir: 'out', kind: kind || 'ref' });
  };
  // outbound — ref segments inside the focus's line items
  try { const items = await rec.getLineItems(); for (const g of refGuidsFromLineItems(items)) await addOut(g, 'ref'); } catch (_e) {}
  // outbound — record-type PROPERTY relations (read raw via PluginProperty.values() + normalize, GUARDRAIL rule 13)
  try {
    const props = (rec.getAllProperties && rec.getAllProperties()) || [];
    for (const pr of props) {
      let raw = null; try { raw = pr.values && pr.values(); } catch (_e) {}
      for (const v of (raw || [])) {
        if (typeof v === 'string') { if (v[0] === '[') { try { for (const g of JSON.parse(v)) if (typeof g === 'string') await addOut(g, 'prop'); } catch (_e) {} } else if (/^[0-9A-Z]{12,}$/.test(v)) await addOut(v, 'prop'); }
        else if (v && typeof v === 'object' && v.guid) await addOut(v.guid, 'prop');
      }
    }
  } catch (_e) {}
  return { focus, neighbours };
}
// Radial layout: focus at (0,0), neighbours on rings around it.
function layoutPlex(graph) {
  const nodes = []; const NW = 168, NH = 44;
  nodes.push({ guid: graph.focus.guid, title: graph.focus.title, x: 0, y: 0, w: NW + 24, h: NH + 8, focus: true });
  const n = graph.neighbours.length; if (!n) return { nodes, edges: [] };
  const perRing = 12, R0 = 260; let i = 0;
  for (const nb of graph.neighbours) {
    const ring = Math.floor(i / perRing), idxInRing = i % perRing, countInRing = Math.min(perRing, n - ring * perRing);
    const R = R0 + ring * 200, a = (idxInRing / countInRing) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ guid: nb.guid, title: nb.title, x: Math.cos(a) * R, y: Math.sin(a) * R, w: NW, h: NH, dir: nb.dir });
    i++;
  }
  const edges = nodes.slice(1).map((nd) => ({ from: nodes[0], to: nd, dir: nd.dir }));
  return { nodes, edges };
}

/* ───────── view ───────── */
class BrainView {
  constructor(plugin, panel, focusGuid) {
    this.plugin = plugin; this.panel = panel; this.host = panel.getElement();
    this.focusGuid = focusGuid; this.camera = new Camera(-400, -300, 1);
    this.dpr = Math.max(1, window.devicePixelRatio || 1); this.dirty = true; this.destroyed = false;
    this.graph = { nodes: [], edges: [] }; this._disposers = []; this._hover = null;
    this._history = []; this._hi = -1; // Phase 4 navigation history
  }
  mount() {
    try { this.panel.setTitle('Brain'); } catch (_e) {}
    const host = this.host; host.innerHTML = ''; host.classList.add('pb-host');
    const wrap = document.createElement('div'); wrap.className = 'pb-root'; this.wrap = wrap;
    wrap.appendChild(this._buildChrome());
    this.cv = document.createElement('canvas'); this.cv.className = 'pb-canvas'; this.cv.tabIndex = 0;
    wrap.appendChild(this.cv);
    const hint = document.createElement('div'); hint.className = 'pb-hint'; hint.textContent = 'click a node to refocus · ⇧/⌘-click opens the record · drag = pan · scroll = zoom'; wrap.appendChild(hint);
    const empty = document.createElement('div'); empty.className = 'pb-empty'; empty.textContent = 'Open a note, then run "Plexus Brain: Focus current note".'; this.emptyEl = empty; wrap.appendChild(empty);
    host.appendChild(wrap);
    this._resize(); const ro = new ResizeObserver(() => { this._resize(); this.dirty = true; }); ro.observe(this.host.closest('.panel-scroller-y') || wrap); this._disposers.push(() => ro.disconnect());
    this._wire();
    if (this.focusGuid) this.setFocus(this.focusGuid);
  }
  _resize() {
    const sc = this.host.closest('.panel-scroller-y') || this.host.closest('.panel') || this.host.parentElement;
    let h = sc ? sc.clientHeight : 0; if (!h || h < 80) h = Math.max(320, (window.innerHeight || 800) - 120);
    this.wrap.style.height = h + 'px'; const w = this.wrap.clientWidth || this.host.clientWidth || 600;
    const ch = this._chromeEl ? this._chromeEl.offsetHeight : 0; const cvh = Math.max(80, h - ch);
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(cvh * this.dpr); this.cv.style.width = w + 'px'; this.cv.style.height = cvh + 'px';
    this.cssW = w; this.cssH = cvh;
  }
  async setFocus(guid, nav) {
    this.focusGuid = guid;
    if (!nav) { this._history = this._history.slice(0, this._hi + 1); if (this._history[this._hi] !== guid) { this._history.push(guid); this._hi = this._history.length - 1; } }
    const prev = new Map((this.graph.nodes || []).map((n) => [n.guid, { x: n.x, y: n.y }]));
    const graph = await deriveNeighbourhood(this.plugin, guid);
    if (this.destroyed) return;
    this.graph = layoutPlex(graph);
    for (const n of this.graph.nodes) { const p = prev.get(n.guid); n._fx = p ? p.x : 0; n._fy = p ? p.y : 0; } // FLIP: persisting nodes glide, new ones grow from centre
    this._anim = { start: (window.performance && performance.now ? performance.now() : Date.now()), dur: 340 };
    this._fit(); this.dirty = true; this._updateChrome();
    if (this.emptyEl) this.emptyEl.style.display = this.graph.nodes.length ? 'none' : 'flex';
  }
  _buildChrome() {
    const bar = document.createElement('div'); bar.className = 'pb-chrome'; this._chromeEl = bar;
    bar.addEventListener('pointerdown', (e) => e.stopPropagation()); bar.addEventListener('wheel', (e) => e.stopPropagation());
    const mkBtn = (txt, fn) => { const b = document.createElement('button'); b.className = 'pb-btn'; b.textContent = txt; b.addEventListener('click', fn); return b; };
    this._backBtn = mkBtn('‹', () => this._back()); this._fwdBtn = mkBtn('›', () => this._fwd());
    bar.appendChild(this._backBtn); bar.appendChild(this._fwdBtn);
    this._crumbEl = document.createElement('span'); this._crumbEl.className = 'pb-crumb'; bar.appendChild(this._crumbEl);
    const sp = document.createElement('span'); sp.style.flex = '1'; bar.appendChild(sp);
    this._searchInp = document.createElement('input'); this._searchInp.className = 'pb-search'; this._searchInp.placeholder = 'Search a record…';
    this._searchInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this._searchFocus(this._searchInp.value); });
    bar.appendChild(this._searchInp);
    return bar;
  }
  _updateChrome() {
    if (this._backBtn) this._backBtn.disabled = this._hi <= 0;
    if (this._fwdBtn) this._fwdBtn.disabled = this._hi >= this._history.length - 1;
    if (this._crumbEl) { const t = (this.graph.nodes[0] && this.graph.nodes[0].title) || ''; this._crumbEl.textContent = t + (this._history.length > 1 ? '  ·  ' + (this._hi + 1) + '/' + this._history.length : ''); }
  }
  _back() { if (this._hi > 0) { this._hi--; this.setFocus(this._history[this._hi], true); } }
  _fwd() { if (this._hi < this._history.length - 1) { this._hi++; this.setFocus(this._history[this._hi], true); } }
  async _searchFocus(q) { q = (q || '').trim(); if (!q) return; try { const res = await this.plugin.data.searchByQuery(q, 5); const r = (res && res.records && res.records[0]); if (r && r.guid) { this.setFocus(r.guid); this._searchInp.value = ''; } else { try { this.plugin.ui.addToaster({ title: 'Plexus Brain: no record matched "' + q + '".', dismissible: true }); } catch (_e) {} } } catch (_e) {} }
  _fit() {
    const nodes = this.graph.nodes; if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nd of nodes) { minX = Math.min(minX, nd.x - nd.w / 2); minY = Math.min(minY, nd.y - nd.h / 2); maxX = Math.max(maxX, nd.x + nd.w / 2); maxY = Math.max(maxY, nd.y + nd.h / 2); }
    const pad = 60, bw = maxX - minX, bh = maxY - minY;
    this.camera.zoom = Math.min(2, Math.max(0.2, Math.min(this.cssW / (bw + pad * 2), this.cssH / (bh + pad * 2))));
    this.camera.x = (minX + maxX) / 2 - (this.cssW / this.camera.zoom) / 2; this.camera.y = (minY + maxY) / 2 - (this.cssH / this.camera.zoom) / 2;
  }
  _nodeAt(sx, sy) {
    const w = this.camera.screenToWorld(sx, sy);
    for (let i = this.graph.nodes.length - 1; i >= 0; i--) { const nd = this.graph.nodes[i]; if (Math.abs(w.x - nd.x) <= nd.w / 2 && Math.abs(w.y - nd.y) <= nd.h / 2) return nd; }
    return null;
  }
  _wire() {
    const cv = this.cv; let mode = null, sx = 0, sy = 0, cx0 = 0, cy0 = 0, downNode = null, moved = false;
    const rel = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e) => { cv.focus(); const p = rel(e); moved = false; downNode = this._nodeAt(p.x, p.y); mode = 'down'; sx = e.clientX; sy = e.clientY; cx0 = this.camera.x; cy0 = this.camera.y; try { cv.setPointerCapture(e.pointerId); } catch (_e) {} };
    const onMove = (e) => { const p = rel(e); if (mode === 'down' || mode === 'pan') { if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) { mode = 'pan'; moved = true; this.camera.x = cx0 - (e.clientX - sx) / this.camera.zoom; this.camera.y = cy0 - (e.clientY - sy) / this.camera.zoom; this.dirty = true; } } const h = this._nodeAt(p.x, p.y); if (h !== this._hover) { this._hover = h; this.dirty = true; cv.style.cursor = h ? 'pointer' : 'grab'; } };
    const onUp = (e) => {
      if (mode === 'down' && !moved && downNode) { if (e.shiftKey || e.metaKey || e.ctrlKey) this._openRecord(downNode.guid); else if (!downNode.focus) this.setFocus(downNode.guid); }
      mode = null; downNode = null; try { cv.releasePointerCapture(e.pointerId); } catch (_e) {}
    };
    const onWheel = (e) => { e.preventDefault(); const p = rel(e); this.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0012)); this.dirty = true; };
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerup', onUp); cv.addEventListener('wheel', onWheel, { passive: false });
    this._disposers.push(() => { cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerup', onUp); cv.removeEventListener('wheel', onWheel); });
  }
  async _openRecord(guid) {
    const ws = (this.plugin.getWorkspaceGuid && this.plugin.getWorkspaceGuid()) || this.plugin.workspaceGuid;
    let p = null; try { p = await this.plugin.ui.createPanel({ afterPanel: this.panel }); } catch (_e) {}
    if (!p) { try { p = await this.plugin.ui.createPanel(); } catch (_e) {} }
    if (p) { try { p.navigateTo({ type: 'edit_panel', rootId: guid, workspaceGuid: ws }); } catch (e) { console.error('[Plexus Brain] openRecord', e); } }
  }
  _clip(ctx, s, maxW) { s = String(s == null ? '' : s); if (ctx.measureText(s).width <= maxW) return s; while (s.length && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1); return s + '…'; }
  render() {
    if (this.destroyed || !this.cv) return; const z = this.camera.zoom, d = this.dpr, ctx = this.cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0f1117'; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(z * d, 0, 0, z * d, -this.camera.x * z * d, -this.camera.y * z * d);
    // FLIP tween progress (easeCubicInOut); keep ticking while animating.
    let e = 1;
    if (this._anim) { const now = (window.performance && performance.now ? performance.now() : Date.now()); let t = (now - this._anim.start) / this._anim.dur; if (t >= 1) { t = 1; this._anim = null; } else this.dirty = true; e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    const pos = (nd) => ({ x: nd._fx == null ? nd.x : nd._fx + (nd.x - nd._fx) * e, y: nd._fy == null ? nd.y : nd._fy + (nd.y - nd._fy) * e });
    // edges
    for (const ed of this.graph.edges) {
      const f = pos(ed.from), tn = pos(ed.to);
      ctx.strokeStyle = ed.dir === 'in' ? '#3b82f6' : '#7c5cff'; ctx.globalAlpha = 0.55 * e; ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.quadraticCurveTo((f.x + tn.x) / 2, (f.y + tn.y) / 2, tn.x, tn.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // nodes
    for (const nd of this.graph.nodes) {
      const P = pos(nd); const x = P.x - nd.w / 2, y = P.y - nd.h / 2; const rad = 9;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, nd.w, nd.h, rad); else ctx.rect(x, y, nd.w, nd.h);
      ctx.fillStyle = nd.focus ? '#7c5cff' : '#1b2030'; ctx.fill();
      ctx.lineWidth = (nd === this._hover ? 2.5 : 1.5) / z; ctx.strokeStyle = nd.focus ? '#a78bfa' : (nd.dir === 'in' ? '#3b82f6' : '#7c5cff'); ctx.stroke();
      ctx.fillStyle = nd.focus ? '#ffffff' : '#e6e8ee'; ctx.font = (nd.focus ? '600 15px' : '13px') + ' system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(this._clip(ctx, nd.title, nd.w - 18), P.x, P.y);
    }
    ctx.textAlign = 'left';
  }
  destroy() { this.destroyed = true; for (const dz of this._disposers.splice(0)) { try { dz(); } catch (_e) {} } }
}

/* ───────── plugin ───────── */
class Plugin extends AppPlugin {
  onLoad() {
    try { window.__plexusBrain && window.__plexusBrain.dispose(); } catch (_e) {}
    this._views = new Set(); this._lastRecordGuid = null; this._raf = 0; this._disposers = [];
    window.__plexusBrain = { version: BRAIN_VERSION, dispose: () => this._teardown() };
    console.log('%c[Plexus Brain] v' + BRAIN_VERSION + ' loaded', 'color:#7c3aed;font-weight:bold');
    this.ui.injectCSS(BASE_CSS);
    this.ui.registerCustomPanelType(PANEL_ID, (panel) => this._mount(panel));
    this.ui.addCommandPaletteCommand({ label: 'Plexus Brain: Open graph', icon: 'ti-graph', onSelected: () => this._open(this._lastRecordGuid) });
    this.ui.addCommandPaletteCommand({ label: 'Plexus Brain: Focus current note', icon: 'ti-graph', onSelected: () => { const r = this._activeRecord(); this._open(r); } });
    const track = (e) => { try { const r = e.panel && e.panel.getActiveRecord && e.panel.getActiveRecord(); if (r && r.guid) this._lastRecordGuid = r.guid; } catch (_e) {} };
    try { this.events.on('panel.focused', track); this.events.on('panel.navigated', track); } catch (_e) {}
    const onChange = (e) => { const g = e && e.recordGuid; for (const v of this._views) { if (!g || v.focusGuid === g || v.graph.nodes.some((n) => n.guid === g)) v.setFocus(v.focusGuid); } };
    try { for (const ev of ['record.updated', 'lineitem.updated', 'lineitem.created', 'lineitem.deleted']) this.events.on(ev, onChange); } catch (_e) {}
    const tick = () => { for (const v of this._views) { if (!v.host || !v.host.isConnected) { v.destroy(); this._views.delete(v); continue; } if (v.dirty) { try { v.render(); } catch (e) { console.error('[Plexus Brain] render', e); } v.dirty = false; } } this._raf = requestAnimationFrame(tick); };
    this._raf = requestAnimationFrame(tick);
    if (TEST_HOOKS) this._installTestHooks();
  }
  _teardown() { cancelAnimationFrame(this._raf); for (const v of this._views) { try { v.destroy(); } catch (_e) {} } this._views.clear(); window.__plexusBrain = undefined; }
  onUnload() { this._teardown(); }
  _activeRecord() { try { const p = this.ui.getActivePanel(); const r = p && p.getActiveRecord && p.getActiveRecord(); return (r && r.guid) || this._lastRecordGuid; } catch (_e) { return this._lastRecordGuid; } }
  async _open(focusGuid) {
    const here = this.ui.getActivePanel();
    const panel = await this.ui.createPanel(here ? { afterPanel: here } : undefined);
    if (!panel) return null;
    this._pendingFocus = focusGuid || null; panel.navigateToCustomType(PANEL_ID); return panel;
  }
  _mount(panel) { const f = this._pendingFocus; this._pendingFocus = null; const v = new BrainView(this, panel, f); this._views.add(v); v.mount(); return v; }
  _installTestHooks() {
    window.__plexusBrain.test = {
      views: () => [...this._views].map((v) => ({ focus: v.focusGuid, nodes: v.graph.nodes.length, edges: v.graph.edges.length })),
      open: async (guid) => { await this._open(guid); for (let i = 0; i < 40; i++) { await sleep(150); const v = [...this._views].pop(); if (v && v.graph.nodes.length) return { focus: v.focusGuid, nodes: v.graph.nodes.length, edges: v.graph.edges.length, focusTitle: v.graph.nodes[0] && v.graph.nodes[0].title, sampleNeighbours: v.graph.nodes.slice(1, 4).map((n) => ({ title: n.title, dir: n.dir })) }; } const v = [...this._views].pop(); return { focus: v ? v.focusGuid : null, nodes: v ? v.graph.nodes.length : -1 }; },
      derive: async (guid) => { const g = await deriveNeighbourhood(this, guid); return { focus: g.focus, neighbourCount: g.neighbours.length, dirs: g.neighbours.reduce((a, n) => { a[n.dir] = (a[n.dir] || 0) + 1; return a; }, {}) }; },
      // Phase 4 navigation: focus A, refocus to a neighbour B, then _back -> should land on A again.
      navTest: async (a, b) => {
        await this._open(a); let v = null; for (let i = 0; i < 40; i++) { await sleep(150); v = [...this._views].pop(); if (v && v.graph.nodes.length) break; }
        if (!v) return { error: 'no view' };
        await v.setFocus(b); const afterB = v.focusGuid; const depth = v._history.length;
        v._back(); await sleep(500); const afterBack = v.focusGuid;
        v._fwd(); await sleep(500); const afterFwd = v.focusGuid;
        return { afterB, afterBack, afterFwd, histDepth: depth, ok: afterB === b && afterBack === a && afterFwd === b };
      },
    };
  }
}

const BASE_CSS = `
.pb-host { position: relative; }
.pb-host .pb-root { position: relative; width: 100%; overflow: hidden; background: #0f1117; font-family: var(--font-family, system-ui, sans-serif); }
.pb-host .pb-root .pb-canvas { display: block; touch-action: none; cursor: grab; outline: none; }
.pb-host .pb-root .pb-hint { position: absolute; left: 12px; bottom: 10px; font-size: 11px; color: #6b7280; pointer-events: none; }
.pb-host .pb-root .pb-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #9aa0a6; font-size: 14px; text-align: center; pointer-events: none; }
.pb-host .pb-root .pb-chrome { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #151823; border-bottom: 1px solid #232838; }
.pb-host .pb-root .pb-btn { width: 26px; height: 26px; border: 1px solid #2a3142; border-radius: 6px; background: #1b2030; color: #cbd1de; cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
.pb-host .pb-root .pb-btn:hover:not(:disabled) { background: #232b3d; }
.pb-host .pb-root .pb-btn:disabled { opacity: .35; cursor: default; }
.pb-host .pb-root .pb-crumb { font-size: 12px; color: #9aa0a6; margin-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.pb-host .pb-root .pb-search { width: 180px; padding: 5px 9px; border: 1px solid #2a3142; border-radius: 6px; background: #0f1117; color: #e6e8ee; font-size: 13px; outline: none; }
`;
