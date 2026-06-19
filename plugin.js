'use strict';
/*
 * Plexus Brain — native Thymer TheBrain-style radial graph (from scratch, no @excalidraw / no ExcaliBrain runtime dep).
 * Derives a record's neighbourhood from Thymer's OWN data: incoming backreferences + outbound ref segments,
 * lays them out radially around a focus node, and lets you click any node to re-centre the "plex".
 * Single-file plugin.js. Roadmap: ~/plexus/BRAIN-ROADMAP.md. Deploy: git push -> Plugins-Manager reinstall.
 */

const BRAIN_VERSION = '0.27.1';
const PANEL_ID = 'plexus-brain';
const TEST_HOOKS = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// IO-3: ONE shared ontology read by all three Plexus plugins (Canvas/Brain/Templater) so they agree on
// collection names + relation tags. Default ⊕ localStorage['plexus_ontology'] override, hoisted to window.
const PLEXUS_ONTOLOGY_DEFAULT = {
  entityCollections: ['Projects', 'People', 'Books', 'Notes', 'Captures', 'Icons', 'Plexus Drawings'],
  journalCollection: 'Journal', drawingsCollection: 'Plexus Drawings', iconsCollection: 'Icons',
  templatesCollection: 'Templates', capturesCollection: 'Captures',
  relationTags: { captured: 'captured', project: 'project', icon: 'icon' },
  // BP-2/BP-3: which record-property field NAMES map a DEFINED relation to an ExcaliBrain category.
  // Matched case-insensitively against the field label. A name claimed by an earlier bucket wins (priority order).
  relationBuckets: {
    parents: ['parent', 'parents', 'up', 'source', 'origin', 'part of', 'belongs to'],
    children: ['child', 'children', 'down', 'subtask', 'subtasks', 'contains'],
    leftFriends: ['friend', 'friends', 'related', 'similar', 'supports', 'see also', 'attendees', 'people'],
    rightFriends: ['opposes', 'blocks', 'blocked by', 'conflicts with'],
    previous: ['previous', 'prev', 'after'],
    next: ['next', 'before', 'leads to'],
  },
};
function loadPlexusOntology() {
  try { if (typeof window !== 'undefined' && window.__plexusOntology) return window.__plexusOntology; } catch (_e) {}
  let o; try { o = JSON.parse(JSON.stringify(PLEXUS_ONTOLOGY_DEFAULT)); } catch (_e) { o = PLEXUS_ONTOLOGY_DEFAULT; }
  try { const ov = JSON.parse(localStorage.getItem('plexus_ontology') || '{}'); o = Object.assign(o, ov); } catch (_e) {}
  try { if (typeof window !== 'undefined') window.__plexusOntology = o; } catch (_e) {}
  return o;
}

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
// BP-2: field-resolution index — the Dataview replacement. Maps a field LABEL to a relation bucket (priority order:
// a name claimed by an earlier bucket wins), builds a per-collection field schema, and a recordGuid→collection map.
function bucketOfFieldLabel(ontology, label) {
  if (!label) return null;
  const L = String(label).trim().toLowerCase();
  const rb = (ontology && ontology.relationBuckets) || {};
  for (const bucket of ['parents', 'children', 'leftFriends', 'rightFriends', 'previous', 'next']) {
    if ((rb[bucket] || []).some((n) => String(n).toLowerCase() === L)) return bucket;
  }
  return null;
}
async function buildFieldIndex(plugin) {
  const idx = { byGuid: {}, byName: {} };
  let cols = null; try { cols = await plugin.data.getAllCollections(); } catch (_e) { return idx; }
  for (const c of (cols || [])) {
    let guid = null, name = null, cfg = null;
    try { guid = c.getGuid && c.getGuid(); } catch (_e) {}
    try { name = c.getName && c.getName(); } catch (_e) {}
    try { cfg = c.getConfiguration && c.getConfiguration(); } catch (_e) {}
    const fields = {};
    const fl = (cfg && (cfg.fields || cfg.field_definitions)) || [];
    for (const f of fl) {
      const fid = f.id || f.field_id || f.guid; if (!fid) continue;
      const label = f.label || f.name || fid;
      fields[fid] = { label, type: f.type, isRelation: f.type === 'record' || f.type === 'relation', bucket: bucketOfFieldLabel(plugin._ontology, label) };
    }
    const entry = { guid, name, fields, col: c };
    if (guid) idx.byGuid[guid] = entry;
    if (name) idx.byName[name] = entry;
  }
  return idx;
}
async function buildRecordCollectionMap(plugin, fieldIndex) {
  // recordGuid -> colGuid. Built ONCE on graph open, in the BACKGROUND (never the per-frame thread). BOUNDED by a
  // record budget so a huge workspace can't OOM / freeze on open — past the cap, nodes simply render without a
  // collection colour (cosmetic). Yields between collections so it never blocks input.
  const map = {}; let count = 0; const CAP = 60000;
  for (const e of Object.values((fieldIndex && fieldIndex.byGuid) || {})) {
    if (count >= CAP) break;
    let recs = null; try { recs = await e.col.getAllRecords(); } catch (_e) { continue; }
    for (const r of (recs || [])) { if (r && r.guid) { map[r.guid] = e.guid; if (++count >= CAP) break; } }
    await Promise.resolve(); // yield to the event loop between collections
  }
  return map;
}
// BS-6: a record's collection name (via the BP-2 recordGuid→collection map + field index) + a stable colour for it.
function collectionNameOf(plugin, guid) { try { const cg = plugin._recColMap && plugin._recColMap[guid]; if (!cg) return null; const c = plugin._fieldIndex && plugin._fieldIndex.byGuid[cg]; return (c && c.name) || null; } catch (_e) { return null; } }
const COLLECTION_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#ef4444', '#14b8a6', '#6366f1', '#eab308'];
function colorForString(s) { let h = 0; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return COLLECTION_PALETTE[Math.abs(h) % COLLECTION_PALETTE.length]; }
// Resolve a backref's (sourceRecordGuid, propertyId) → { label, isRelation, bucket } using the indexes.
function resolveBackrefField(plugin, sourceGuid, propertyId) {
  if (!propertyId || !plugin._fieldIndex || !plugin._recColMap) return null;
  const colGuid = plugin._recColMap[sourceGuid]; if (!colGuid) return null;
  const col = plugin._fieldIndex.byGuid[colGuid]; if (!col) return null;
  return col.fields[propertyId] || null;
}
function hashtagsFromLineItems(items) {
  const out = new Set();
  for (const li of (items || [])) {
    let segs = null; try { segs = li.segments || []; } catch (_e) { segs = []; }
    for (const s of segs) { if (s && s.type === 'hashtag') { const t = (typeof s.text === 'string') ? s.text : (s.text && (s.text.label || s.text.tag)) || ''; if (t) out.add(String(t).replace(/^#/, '')); } }
  }
  return [...out];
}
// Returns { focus:{guid,title}, neighbours:[{guid,title,dir}] }  dir: 'in'|'out'
async function deriveNeighbourhood(plugin, guid) {
  const rec = await plugin.data.getRecord(guid);
  if (!rec) return { focus: { guid, title: '(not found)' }, neighbours: [] };
  const focus = { guid, title: (rec.getName && rec.getName()) || 'Untitled' };
  const ont = plugin._ontology;
  const rels = new Map(); // guid -> { guid, title, f:{facets}, kinds:Set, propertyId, lineItemGuid }
  const specials = [];    // url / unresolved-virtual nodes (non-relational)
  const seen = new Set([guid]);
  const touch = (g, title) => { let e = rels.get(g); if (!e) { e = { guid: g, title: title || 'Untitled', f: {}, kinds: new Set(), propertyId: null, lineItemGuid: null }; rels.set(g, e); } else if (title && (!e.title || e.title === 'Untitled')) e.title = title; return e; };

  // INCOMING backrefs (BP-1 detailed): a record-PROPERTY pointing here is a DEFINED relation (bucket INVERTED to
  // focus's POV); a LINE ref is an INFERRED parent (someone links to focus ⇒ they're a parent in the link model).
  let back = null;
  try { back = await rec.getBackReferences(); }
  catch (_e) { try { back = ((await rec.getBackReferenceRecords()) || []).map((r) => ({ record: r, kind: 'line' })); } catch (_e2) { back = []; } }
  for (const br of (back || [])) {
    const r = br && br.record; const g = r && r.guid; if (!g || g === guid) continue;
    const e = touch(g, (r.getName && r.getName()) || 'Untitled'); e.kinds.add('in'); e.rec = e.rec || r; // BS-2: keep record for skin
    if (br.kind === 'property' && br.propertyId) {
      e.propertyId = br.propertyId;
      const fld = resolveBackrefField(plugin, g, br.propertyId);
      const bucket = fld && fld.bucket;
      if (fld && fld.label && bucket) e.label = e.label || fld.label; // BS-1: edge label = the relation field name
      if (bucket === 'parents') e.f.cd = true;        // source "parent: focus" ⇒ neighbour is focus's CHILD
      else if (bucket === 'children') e.f.pd = true;  // source "child: focus"  ⇒ neighbour is focus's PARENT
      else if (bucket === 'leftFriends') e.f.lfd = true;
      else if (bucket === 'rightFriends') e.f.rfd = true;
      else if (bucket === 'previous') e.f.nfd = true; // source "previous: focus" ⇒ neighbour is focus's NEXT
      else if (bucket === 'next') e.f.pfd = true;
      else e.f.pi = true;                             // uncategorized property backref ⇒ inferred parent
    } else {
      e.f.pi = true; if (br.lineItemGuid) e.lineItemGuid = br.lineItemGuid;
    }
  }

  // OUTBOUND ref segments (focus body → neighbour): INFERRED child. Unresolvable ref ⇒ a virtual node.
  let items = null; try { items = await rec.getLineItems(); } catch (_e) {}
  // IO-4/BS-3: the focus's OWN open tasks (real task line items) → a togglable rail. Cheap (items already fetched).
  focus.tasks = [];
  for (const li of (items || [])) { let st = null; try { st = li.getTaskStatus && li.getTaskStatus(); } catch (_e) {} if (st != null && st !== 'done') { focus.tasks.push({ guid: li.guid, text: lineTextOf(li) || '(task)', li }); if (focus.tasks.length >= 6) break; } }
  const outRefGuids = refGuidsFromLineItems(items).filter((g) => g !== guid);
  const outRefRecs = await Promise.all(outRefGuids.map((g) => plugin.data.getRecord(g).catch(() => null))); // PARALLEL (was serial N+1)
  outRefGuids.forEach((g, i) => {
    const trec = outRefRecs[i];
    if (!trec) { if (!seen.has(g) && !rels.has(g)) { seen.add(g); specials.push({ guid: g, title: '(unresolved)', dir: 'out', kind: 'virtual', role: 'rightFriend', relType: 'INFERRED' }); } return; }
    const e = touch(g, (trec.getName && trec.getName()) || null); e.kinds.add('ref'); e.f.ci = true; e.rec = e.rec || trec;
  });

  // OUTBOUND record-PROPERTY relations (focus → neighbour): bucket from the focus FIELD NAME (DEFINED).
  try {
    const props = (rec.getAllProperties && rec.getAllProperties()) || [];
    const propTargets = []; // {g, bucket, name} — collect across all props, then fetch the records in ONE parallel batch
    for (const pr of props) {
      const bucket = bucketOfFieldLabel(ont, pr && pr.name);
      let raw = null; try { raw = pr.values && pr.values(); } catch (_e) {}
      const guids = [];
      for (const v of (raw || [])) {
        if (typeof v === 'string') { if (v[0] === '[') { try { for (const g of JSON.parse(v)) if (typeof g === 'string') guids.push(g); } catch (_e) {} } else if (/^[0-9A-Z]{12,}$/.test(v)) guids.push(v); }
        else if (v && typeof v === 'object' && v.guid) guids.push(v.guid);
      }
      for (const g of guids) { if (g !== guid) propTargets.push({ g, bucket, name: pr && pr.name }); }
    }
    const propRecs = await Promise.all(propTargets.map((t) => plugin.data.getRecord(t.g).catch(() => null))); // PARALLEL (was serial N+1)
    propTargets.forEach((t, i) => {
      const trec = propRecs[i], title = (trec && trec.getName && trec.getName()) || null;
      const e = touch(t.g, title); e.kinds.add('prop'); e.rec = e.rec || trec;
      if (t.bucket && t.name) e.label = e.label || t.name; // BS-1: edge label = the relation field name
      if (t.bucket === 'parents') e.f.pd = true;
      else if (t.bucket === 'children') e.f.cd = true;
      else if (t.bucket === 'leftFriends') e.f.lfd = true;
      else if (t.bucket === 'rightFriends') e.f.rfd = true;
      else if (t.bucket === 'previous') e.f.pfd = true;
      else if (t.bucket === 'next') e.f.nfd = true;
      else e.f.ci = true;                            // uncategorized outbound prop ⇒ inferred child
    });
  } catch (_e) {}

  // HASHTAG co-occurrence (records sharing a hashtag): INFERRED friend.
  try {
    const tags = hashtagsFromLineItems(items).slice(0, 4);
    const tagResults = await Promise.all(tags.map((tag) => plugin.data.searchByQuery('#' + tag, 8).catch(() => null))); // PARALLEL (was 4 serial searches; debounce guards rate limits)
    for (const res of tagResults) {
      if (!res) continue;
      const tagRecs = [];
      for (const r of ((res.records) || [])) tagRecs.push([r.guid, (r.getName && r.getName()) || null]);
      for (const li of ((res.lines) || [])) { let g = null, t = null; try { const rr = li.getRecord && li.getRecord(); g = rr && rr.guid; t = rr && rr.getName && rr.getName(); } catch (_e) {} if (g) tagRecs.push([g, t]); }
      for (const [g, t] of tagRecs) { if (!g || g === guid) continue; const e = touch(g, t); e.kinds.add('tag'); e.f.lfi = true; }
    }
  } catch (_e) {}

  // URL nodes (non-relational): external links written in the focus's text.
  try { for (const li of (items || [])) { const segs = li.segments || []; for (const s of segs) { const tx = (typeof s.text === 'string') ? s.text : (s.text && (s.text.url || s.text.label)) || ''; for (const u of (String(tx).match(/https?:\/\/[^\s)]+/g) || [])) { if (!seen.has(u) && !rels.has(u)) { seen.add(u); specials.push({ guid: u, title: u.replace(/^https?:\/\//, '').slice(0, 28), dir: 'out', kind: 'url', url: u, role: 'rightFriend', relType: 'INFERRED' }); } } } } } catch (_e) {}

  // RESOLVE each accumulated relation to ONE role via the truth-table.
  const neighbours = [];
  for (const e of rels.values()) {
    const rr = resolveRole(e.f); if (!rr) continue;
    const dir = (rr.role === 'parent') ? 'in' : 'out';
    neighbours.push({ guid: e.guid, title: e.title, role: rr.role, relType: rr.type, dir, kind: [...e.kinds][0] || 'ref', label: e.label || ROLE_LABEL[rr.role] || '', skin: nodeSkin(e.rec), collection: collectionNameOf(plugin, e.guid), propertyId: e.propertyId, lineItemGuid: e.lineItemGuid });
  }
  for (const sp of specials) neighbours.push(sp);

  // BP-5: siblings — second-order, the CHILDREN of focus's parents (excluding focus + anything already shown).
  // Bounded (≤4 parents, ≤12 siblings) so a huge graph stays fast; this runs once per focus, never per frame.
  const parents = neighbours.filter((n) => n.role === 'parent').slice(0, 4);
  if (parents.length) {
    const known = new Set([guid, ...neighbours.map((n) => n.guid)]);
    const parentRecs = await Promise.all(parents.map((p) => plugin.data.getRecord(p.guid).catch(() => null))); // PARALLEL parent fetch
    const parentItems = await Promise.all(parentRecs.map((pr) => (pr && pr.getLineItems) ? pr.getLineItems().catch(() => null) : Promise.resolve(null)));
    const sibGuids = [];
    for (let pi = 0; pi < parents.length && sibGuids.length < 12; pi++) {
      const pr = parentRecs[pi]; if (!pr) continue;
      const childGuids = new Set(refGuidsFromLineItems(parentItems[pi])); // parent's inferred children (its outbound refs)
      const pprops = (pr.getAllProperties && pr.getAllProperties()) || [];
      for (const prop of pprops) {
        if (bucketOfFieldLabel(ont, prop && prop.name) !== 'children') continue;
        let raw = null; try { raw = prop.values && prop.values(); } catch (_e) {}
        for (const v of (raw || [])) {
          if (typeof v === 'string') { if (v[0] === '[') { try { for (const g of JSON.parse(v)) if (typeof g === 'string') childGuids.add(g); } catch (_e) {} } else if (/^[0-9A-Z]{12,}$/.test(v)) childGuids.add(v); }
          else if (v && typeof v === 'object' && v.guid) childGuids.add(v.guid);
        }
      }
      for (const g of childGuids) { if (g && !known.has(g)) { known.add(g); sibGuids.push(g); if (sibGuids.length >= 12) break; } }
    }
    const sibRecs = await Promise.all(sibGuids.map((g) => plugin.data.getRecord(g).catch(() => null))); // PARALLEL sib title fetch
    sibGuids.forEach((g, i) => { const t = sibRecs[i]; const title = (t && t.getName && t.getName()) || null; neighbours.push({ guid: g, title: title || 'Untitled', role: 'sibling', relType: 'INFERRED', dir: 'out', kind: 'sibling' }); });
  }
  return { focus, neighbours };
}
// LRU cache of derived neighbourhoods, keyed by focus guid — re-focusing a recently-viewed node is INSTANT (no
// re-derive). onChange invalidates the affected entries so it never serves stale data.
async function cachedDerive(plugin, guid, force) {
  const cache = plugin._deriveCache || (plugin._deriveCache = new Map());
  // Hand out a PRIVATE shallow copy — the view mutates its derive (isNew flags, _addSemantic pushes 'sem' nodes,
  // _toggleFocusTask filters focus.tasks); writing through to the shared cached object would corrupt the cache and
  // leak state across views/re-focuses. Clone the mutated surfaces (neighbour objects + the tasks array).
  const clone = (d) => ({ focus: { ...d.focus, tasks: (d.focus.tasks || []).slice() }, neighbours: d.neighbours.map((n) => ({ ...n })), _semDone: false });
  if (!force && cache.has(guid)) { const d = cache.get(guid); cache.delete(guid); cache.set(guid, d); return clone(d); } // LRU touch + private copy
  const d = await deriveNeighbourhood(plugin, guid);
  cache.set(guid, d); while (cache.size > 16) cache.delete(cache.keys().next().value);
  return clone(d);
}
function invalidateDerive(plugin, guid) { try { if (plugin._deriveCache && guid) plugin._deriveCache.delete(guid); } catch (_e) {} }
// BP-3: truth-table — collapse a neighbour's fat facet bag into ONE mutually-exclusive role (ExcaliBrain cases A–Q).
// Facets: pi/pd parent-inferred/defined, ci/cd child, lfd/rfd left/right-friend-defined, pfd/nfd prev/next-defined,
// lfi inferred friend (tag co-occurrence). DEFINED beats INFERRED; ≥2 defined OR mutual inferred parent+child ⇒ friend.
const ROLE_LABEL = { parent: 'parent', child: 'child', leftFriend: 'friend', rightFriend: 'opposite', previous: 'previous', next: 'next', sibling: 'sibling' }; // BS-1: inferred-edge fallback labels
// BS-2: ENUM_COLORS index → hex (red..yellow, per the SDK EnumColors table) for property-driven node skins.
const ENUM_COLOR_HEX = ['#ef4444', '#f97316', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#d946ef', '#f43f5e', '#78716c', '#14b8a6', '#0ea5e9', '#6366f1', '#71717a', '#eab308'];
// BS-2: live node skin from a neighbour's OWN typed properties — Status→choice colour, Priority→size, Due→urgency.
// Synchronous (reads props off a record we already fetched); recomputed every derive so it tracks property changes.
function nodeSkin(rec) {
  const skin = { color: null, scale: 1, urgent: false };
  if (!rec || !rec.prop) return skin;
  try { const sp = rec.prop('Status') || rec.prop('State'); if (sp && sp.choice) { const sel = sp.choice(); const opts = (sp.choices && sp.choices()) || []; const opt = (opts || []).find((o) => o && o.id === sel); if (opt && opt.color != null && ENUM_COLOR_HEX[+opt.color]) skin.color = ENUM_COLOR_HEX[+opt.color]; } } catch (_e) {}
  try { const pp = rec.prop('Priority'); if (pp) { const L = String((pp.choiceLabel && pp.choiceLabel()) || (pp.text && pp.text()) || '').toLowerCase(); if (/high|urgent|critical|\bp0\b|\bp1\b/.test(L)) skin.scale = 1.16; else if (/low|\bp3\b|\bp4\b/.test(L)) skin.scale = 0.9; } } catch (_e) {}
  try { const dp = rec.prop('Due') || rec.prop('Due Date') || rec.prop('Deadline'); if (dp && dp.date) { const d = dp.date(); if (d && d.getTime() < Date.now()) skin.urgent = true; } } catch (_e) {}
  return skin;
}
function definedCount(f) { return [f.pd, f.cd, f.lfd, f.rfd, f.pfd, f.nfd].filter(Boolean).length; }
function resolveRole(f) {
  if (!f) return null;
  if (definedCount(f) >= 2) return { role: 'leftFriend', type: 'DEFINED' }; // over-defined collapses to friend (cases H/I)
  if (f.pd) return { role: 'parent', type: 'DEFINED' };
  if (f.cd) return { role: 'child', type: 'DEFINED' };
  if (f.lfd) return { role: 'leftFriend', type: 'DEFINED' };
  if (f.rfd) return { role: 'rightFriend', type: 'DEFINED' };
  if (f.pfd) return { role: 'previous', type: 'DEFINED' };
  if (f.nfd) return { role: 'next', type: 'DEFINED' };
  if (f.pi && f.ci) return { role: 'leftFriend', type: 'INFERRED' }; // mutual inferred parent+child ⇒ friends
  if (f.pi) return { role: 'parent', type: 'INFERRED' };
  if (f.ci) return { role: 'child', type: 'INFERRED' };
  if (f.lfi) return { role: 'leftFriend', type: 'INFERRED' };        // tag co-occurrence / inferred friend
  return null;
}
// Per-ROLE colour: parent=blue, child=green, friend=purple, right-friend/next=amber, url=cyan, virtual=grey, sem=pink.
function relColor(role, kind) {
  if (kind === 'url') return '#06b6d4'; if (kind === 'virtual') return '#9ca3af'; if (kind === 'sem') return '#ec4899';
  if (role === 'parent') return '#3b82f6'; if (role === 'child') return '#10b981'; if (role === 'sibling') return '#14b8a6';
  if (role === 'rightFriend' || role === 'next') return '#f59e0b';
  return '#7c5cff'; // leftFriend / previous / fallback
}
const MAX_LAYOUT_NODES = 64; // BP-5: cap radial/tree placement (like layoutCross's per-band cap) — keeps a hub node's graph readable + the render loop fast.
// Radial layout: focus at (0,0), neighbours on rings around it.
function layoutPlex(graph) {
  const nodes = []; const NW = 168, NH = 44;
  nodes.push({ guid: graph.focus.guid, title: graph.focus.title, x: 0, y: 0, w: NW + 24, h: NH + 8, focus: true });
  const neigh = graph.neighbours.length > MAX_LAYOUT_NODES ? graph.neighbours.slice(0, MAX_LAYOUT_NODES) : graph.neighbours;
  const n = neigh.length; if (!n) return { nodes, edges: [] };
  const perRing = 12, R0 = 260; let i = 0;
  for (const nb of neigh) {
    const ring = Math.floor(i / perRing), idxInRing = i % perRing, countInRing = Math.min(perRing, n - ring * perRing);
    const R = R0 + ring * 200, a = (idxInRing / countInRing) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ guid: nb.guid, title: nb.title, x: Math.cos(a) * R, y: Math.sin(a) * R, w: NW, h: NH, dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew });
    i++;
  }
  const edges = nodes.slice(1).map((nd) => ({ from: nodes[0], to: nd, dir: nd.dir, kind: nd.kind, role: nd.role, relType: nd.relType, label: nd.label }));
  return { nodes, edges };
}
// Phase 7: alternate layout — focus on top, neighbours in a grid below (hierarchical/tree feel).
function layoutTree(graph) {
  const NW = 180, NH = 44, cols = 4, gx = 206, gy = 66;
  const nodes = [{ guid: graph.focus.guid, title: graph.focus.title, x: 0, y: 0, w: NW + 24, h: NH + 8, focus: true }];
  const neigh = graph.neighbours.length > MAX_LAYOUT_NODES ? graph.neighbours.slice(0, MAX_LAYOUT_NODES) : graph.neighbours;
  neigh.forEach((nb, i) => { const c = i % cols, r = Math.floor(i / cols); nodes.push({ guid: nb.guid, title: nb.title, x: (c - (cols - 1) / 2) * gx, y: 100 + r * gy, w: NW, h: NH, dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew }); });
  const edges = nodes.slice(1).map((nd) => ({ from: nodes[0], to: nd, dir: nd.dir, kind: nd.kind, role: nd.role, relType: nd.relType, label: nd.label }));
  return { nodes, edges };
}
// BP-3/P8: which of the 4 cross-layout bands a neighbour belongs to (top-level so the view can filter/hit-test gates).
function crossBand(nb) { const r = nb.role; if (r === 'parent') return 'up'; if (r === 'child') return 'down'; if (r === 'sibling') return 'sib'; if (r === 'rightFriend' || r === 'next') return 'right'; if (r === 'leftFriend' || r === 'previous') return 'left'; if (nb.kind === 'url' || nb.kind === 'virtual') return 'right'; return 'left'; }
const CROSS_BAND_CAP = 30; // BP-5: per-band node cap; overflow surfaces as a "+k" badge on the gate.
// BP-3/P8/BP-4: structured cross layout — parents UP, children DOWN, friends LEFT, opposites/links RIGHT,
// with per-band caps and gate metadata (label + count + overflow + anchor) for the directional gate headers.
function layoutCross(graph) {
  const NW = 172, NH = 44;
  const nodes = [{ guid: graph.focus.guid, title: graph.focus.title, x: 0, y: 0, w: NW + 24, h: NH + 8, focus: true }];
  const hidden = graph.hidden || {}; // BP-4: gate-collapsed bands keep their COUNT but place no nodes
  const b = { up: [], down: [], left: [], right: [], sib: [] };
  for (const nb of graph.neighbours) b[crossBand(nb)].push(nb);
  const HSTEP = NW + 26, VSTEP = NH + 18, COLS = 6;
  const cap = (arr) => arr.length > CROSS_BAND_CAP ? arr.slice(0, CROSS_BAND_CAP) : arr;
  const row = (arr, ySign, key) => { if (hidden[key]) return; const a = cap(arr); a.forEach((nb, i) => { const r = Math.floor(i / COLS), cc = Math.min(COLS, a.length - r * COLS), ci = i % COLS; nodes.push({ guid: nb.guid, title: nb.title, x: (ci - (cc - 1) / 2) * HSTEP, y: ySign * (190 + r * (NH + 22)), w: NW, h: NH, dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew }); }); };
  const col = (arr, xSign, key) => { if (hidden[key]) return; const a = cap(arr); a.forEach((nb, i) => nodes.push({ guid: nb.guid, title: nb.title, x: xSign * (250 + NW / 2), y: (i - (a.length - 1) / 2) * VSTEP, w: NW, h: NH, dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew })); };
  // BP-5: siblings cluster in the UPPER-RIGHT (ExcaliBrain convention), in its own compact grid.
  const grid = (arr, key, x0, y0, cols) => { if (hidden[key]) return; const a = cap(arr); a.forEach((nb, i) => { const r = Math.floor(i / cols), ci = i % cols; nodes.push({ guid: nb.guid, title: nb.title, x: x0 + ci * (NW + 14), y: y0 + r * (NH + 14), w: NW, h: NH, dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew }); }); };
  row(b.up, -1, 'up'); row(b.down, 1, 'down'); col(b.left, -1, 'left'); col(b.right, 1, 'right'); grid(b.sib, 'sib', 300, -330, 3);
  const m = {}; nodes.forEach((nd) => { m[nd.guid] = nd; });
  const edges = graph.neighbours.map((nb) => ({ from: nodes[0], to: m[nb.guid], dir: nb.dir, kind: nb.kind, role: nb.role, relType: nb.relType, label: nb.label, skin: nb.skin, collection: nb.collection, isNew: nb.isNew })).filter((e) => e.to);
  const ov = (arr) => Math.max(0, arr.length - CROSS_BAND_CAP);
  const bands = {
    up: { key: 'up', label: 'Parents', count: b.up.length, over: ov(b.up), ax: 0, ay: -120, role: 'parent', hidden: !!hidden.up },
    down: { key: 'down', label: 'Children', count: b.down.length, over: ov(b.down), ax: 0, ay: 120, role: 'child', hidden: !!hidden.down },
    left: { key: 'left', label: 'Friends', count: b.left.length, over: ov(b.left), ax: -200, ay: 0, role: 'leftFriend', hidden: !!hidden.left },
    right: { key: 'right', label: 'Opposites · Links', count: b.right.length, over: ov(b.right), ax: 200, ay: 0, role: 'rightFriend', hidden: !!hidden.right },
    sib: { key: 'sib', label: 'Siblings', count: b.sib.length, over: ov(b.sib), ax: 380, ay: -290, role: 'sibling', hidden: !!hidden.sib },
  };
  return { nodes, edges, bands };
}

/* ───────── view ───────── */
class BrainView {
  constructor(plugin, panel, focusGuid) {
    this.plugin = plugin; this.panel = panel; this.host = panel.getElement();
    this.focusGuid = focusGuid; this.camera = new Camera(-400, -300, 1);
    this.dpr = Math.max(1, window.devicePixelRatio || 1); this.dirty = true; this.destroyed = false;
    this.graph = { nodes: [], edges: [] }; this._disposers = []; this._hover = null;
    this._history = []; this._hi = -1; this._loadHistory(); // Phase 4 nav history; BP-6: restore persisted history
    this._filter = { in: true, ref: true, prop: true, tag: true, sem: false }; // Phase 5/6 kind filters (sem opt-in)
    this._layoutMode = 'radial'; // Phase 7: 'radial' | 'tree'
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
  async setFocus(guid, nav, force) {
    this.focusGuid = guid;
    if (!nav) {
      this._history = this._history.slice(0, this._hi + 1);
      if (this._history[this._hi] !== guid) { this._history.push(guid); this._hi = this._history.length - 1; }
      // BP-6: cap at 50 (MRU) + persist so navigation history survives a panel close / reload.
      if (this._history.length > 50) { const drop = this._history.length - 50; this._history.splice(0, drop); this._hi -= drop; }
      this._saveHistory();
    }
    try { await this.plugin._ensureIndex(); } catch (_e) {} // BP-2: field index ready before derive (recColMap fills in async)
    // BS-8: graph diff — when RE-deriving the same focus (e.g. after a record.updated), flag neighbours that are NEW
    // since the last derive so the renderer can glow them green.
    const token = (this._focusToken = (this._focusToken || 0) + 1); // in-flight guard: a newer setFocus supersedes a slow derive
    const sameFocus = this._lastDerivedFocus === guid;
    const prevSet = sameFocus && this._derived ? new Set(this._derived.neighbours.map((n) => n.guid)) : null;
    const derived = await cachedDerive(this.plugin, guid, force); // cached re-focus is instant; force=true re-derives (onChange)
    if (this.destroyed || token !== this._focusToken) return; // a newer focus started — drop this stale result
    this._derived = derived;
    if (prevSet) for (const n of this._derived.neighbours) n.isNew = !prevSet.has(n.guid);
    else for (const n of this._derived.neighbours) n.isNew = false; // clear stale diff flags on a cached / different-focus derive
    this._lastDerivedFocus = guid;
    this._relayout();
  }
  // Trailing-edge debounce for EVENT-driven re-focus (record/lineitem changes, external navigation) so an edit storm
  // or rapid navigation coalesces into ONE derive. User clicks call setFocus directly (immediate).
  _scheduleReFocus(guid, opts) {
    opts = opts || {};
    // A DIFFERENT target already queued (e.g. a navigation) must not be silently dropped by coalescing → fire it now.
    if (this._pend && this._pend.guid !== guid) { const p = this._pend; this._pend = null; if (this._refocusT) { clearTimeout(this._refocusT); this._refocusT = null; } if (!this.destroyed) this.setFocus(p.guid, p.nav, p.force); }
    const prevForce = (this._pend && this._pend.guid === guid && this._pend.force) || false;
    this._pend = { guid, nav: opts.nav, force: opts.force || prevForce };
    if (this._refocusT) clearTimeout(this._refocusT);
    this._refocusT = setTimeout(() => { this._refocusT = null; const p = this._pend; this._pend = null; if (p && p.guid && !this.destroyed) this.setFocus(p.guid, p.nav, p.force); }, 180);
  }
  // Phase 5: filter the derived neighbours by kind, re-layout with a FLIP tween (no re-derive).
  _relayout() {
    if (!this._derived) return;
    const f = this._filter || { in: true, ref: true, prop: true, tag: true };
    const kept = this._derived.neighbours.filter((n) => f[n.dir === 'in' ? 'in' : (n.kind || 'ref')] !== false);
    const prev = new Map((this.graph.nodes || []).map((n) => [n.guid, { x: n.x, y: n.y }]));
    const lay = this._layoutMode === 'tree' ? layoutTree : (this._layoutMode === 'cross' ? layoutCross : layoutPlex);
    this.graph = lay({ focus: this._derived.focus, neighbours: kept, hidden: this._gateHidden }); // BP-4: collapsed bands
    for (const n of this.graph.nodes) { const p = prev.get(n.guid); n._fx = p ? p.x : 0; n._fy = p ? p.y : 0; }
    this._anim = { start: (window.performance && performance.now ? performance.now() : Date.now()), dur: 340 };
    this._fit(); this.dirty = true; this._updateChrome();
    if (this.emptyEl) this.emptyEl.style.display = this.graph.nodes.length ? 'none' : 'flex';
  }
  // Phase 6 semantic lens: embed the focus + a keyword-search candidate set, add the most-similar as 'sem'.
  async _addSemantic() {
    if (!this._derived) return;
    if (this._derived._semDone) { this._relayout(); return; }
    this._derived._semDone = true;
    const focusTitle = this._derived.focus.title || '';
    const words = focusTitle.split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(' ') || focusTitle;
    try { this.plugin.ui.addToaster({ title: 'Plexus Brain: embedding for the semantic lens… (first run loads a model)', dismissible: true }); } catch (_e) {}
    let cands = [];
    try { const res = await this.plugin.data.searchByQuery(words, 25); cands = ((res && res.records) || []).map((r) => ({ guid: r.guid, title: (r.getName && r.getName()) || '' })); } catch (_e) {}
    const seen = new Set([this._derived.focus.guid].concat(this._derived.neighbours.map((n) => n.guid)));
    cands = cands.filter((c) => c.guid && c.title && !seen.has(c.guid)).slice(0, 18);
    if (cands.length) {
      try {
        const fv = await this.plugin._embed(focusTitle); const sims = [];
        for (const c of cands) { try { const cv = await this.plugin._embed(c.title); let s = 0; for (let i = 0; i < fv.length; i++) s += fv[i] * cv[i]; sims.push({ guid: c.guid, title: c.title, sim: s }); } catch (_e) {} }
        sims.sort((a, b) => b.sim - a.sim);
        for (const c of sims.slice(0, 6)) if (c.sim > 0.4) this._derived.neighbours.push({ guid: c.guid, title: c.title, dir: 'out', kind: 'sem' });
      } catch (_e) {}
    }
    this._relayout();
  }
  _buildChrome() {
    const bar = document.createElement('div'); bar.className = 'pb-chrome'; this._chromeEl = bar;
    bar.addEventListener('pointerdown', (e) => e.stopPropagation()); bar.addEventListener('wheel', (e) => e.stopPropagation());
    const mkBtn = (txt, fn) => { const b = document.createElement('button'); b.className = 'pb-btn'; b.textContent = txt; b.addEventListener('click', fn); return b; };
    this._backBtn = mkBtn('‹', () => this._back()); this._fwdBtn = mkBtn('›', () => this._fwd());
    bar.appendChild(this._backBtn); bar.appendChild(this._fwdBtn);
    const LAYOUTS = ['radial', 'cross', 'tree'], LGLYPH = { radial: '◎', cross: '✛', tree: '⊞' };
    this._layoutBtn = mkBtn('◎', () => { const i = (LAYOUTS.indexOf(this._layoutMode) + 1) % LAYOUTS.length; this._layoutMode = LAYOUTS[i]; this._layoutBtn.textContent = LGLYPH[this._layoutMode]; this._layoutBtn.title = this._layoutMode + ' layout (click to cycle)'; this._relayout(); }); // P8: radial → cross → tree
    this._layoutBtn.textContent = LGLYPH[this._layoutMode] || '◎'; this._layoutBtn.title = (this._layoutMode || 'radial') + ' layout (click to cycle)'; bar.appendChild(this._layoutBtn);
    this._crumbEl = document.createElement('span'); this._crumbEl.className = 'pb-crumb'; bar.appendChild(this._crumbEl);
    const sp = document.createElement('span'); sp.style.flex = '1'; bar.appendChild(sp);
    // Phase 5/6: relation-kind filter chips (colour-matched to relColor). 'sem' = the embedding lens (opt-in).
    this._filterChips = {};
    for (const [k, label, col] of [['in', 'in', '#3b82f6'], ['ref', 'ref', '#7c5cff'], ['prop', 'prop', '#10b981'], ['tag', 'tag', '#f59e0b'], ['sem', '✦sem', '#ec4899']]) {
      const c = document.createElement('button'); c.className = 'pb-chip'; c.textContent = label; c.style.setProperty('--c', col);
      if (k === 'sem') c.classList.add('off');
      c.addEventListener('click', () => { this._filter[k] = !this._filter[k]; c.classList.toggle('off', !this._filter[k]); if (k === 'sem' && this._filter.sem) this._addSemantic(); else this._relayout(); });
      bar.appendChild(c); this._filterChips[k] = c;
    }
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
  _back() { if (this._hi > 0) { this._hi--; this.setFocus(this._history[this._hi], true); this._saveHistory(); } }
  _fwd() { if (this._hi < this._history.length - 1) { this._hi++; this.setFocus(this._history[this._hi], true); this._saveHistory(); } }
  // BP-6: persist the navigation history (guids + cursor) so it survives a panel close / reload.
  _saveHistory() { try { localStorage.setItem('plexus_brain_history', JSON.stringify({ h: this._history.slice(-50), i: this._hi })); } catch (_e) {} }
  _loadHistory() { try { const s = JSON.parse(localStorage.getItem('plexus_brain_history') || 'null'); if (s && Array.isArray(s.h)) { this._history = s.h.filter((g) => typeof g === 'string'); this._hi = Math.max(-1, Math.min(this._history.length - 1, s.i == null ? this._history.length - 1 : s.i)); } } catch (_e) {} }
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
    const cv = this.cv; let mode = null, sx = 0, sy = 0, cx0 = 0, cy0 = 0, downNode = null, downGate = null, downTask = null, moved = false;
    const rel = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e) => { cv.focus(); const p = rel(e); moved = false; downNode = this._nodeAt(p.x, p.y); downTask = downNode ? null : this._taskAt(p.x, p.y); downGate = (downNode || downTask) ? null : this._gateAt(p.x, p.y); mode = 'down'; sx = e.clientX; sy = e.clientY; cx0 = this.camera.x; cy0 = this.camera.y; try { cv.setPointerCapture(e.pointerId); } catch (_e) {} };
    const onMove = (e) => {
      const p = rel(e);
      if ((mode === 'down' || mode === 'pan' || mode === 'dragnode') && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) {
        moved = true;
        // BS-5: dragging a NODE (not focus/url/virtual) onto a gate restructures it; dragging empty space pans.
        if (mode !== 'pan' && downNode && !downNode.focus && downNode.kind !== 'url' && downNode.kind !== 'virtual') {
          mode = 'dragnode'; const w = this.camera.screenToWorld(p.x, p.y); this._drag = { guid: downNode.guid, title: downNode.title, x: w.x, y: w.y, gate: this._gateAt(p.x, p.y) }; cv.style.cursor = 'grabbing'; this.dirty = true; return;
        }
        mode = 'pan'; this.camera.x = cx0 - (e.clientX - sx) / this.camera.zoom; this.camera.y = cy0 - (e.clientY - sy) / this.camera.zoom; this.dirty = true; return;
      }
      const h = this._nodeAt(p.x, p.y); if (h !== this._hover) { this._hover = h; this.dirty = true; cv.style.cursor = (h || this._gateAt(p.x, p.y) || this._taskAt(p.x, p.y)) ? 'pointer' : 'grab'; }
    };
    const onUp = (e) => {
      if (mode === 'down' && !moved && downTask) { this._toggleFocusTask(downTask); } // IO-4: complete a focus task in-graph
      else if (mode === 'down' && !moved && downGate) { if (!this._gateHidden) this._gateHidden = {}; this._gateHidden[downGate] = !this._gateHidden[downGate]; this._relayout(); } // BP-4: toggle band
      else if (mode === 'down' && !moved && downNode && e.altKey && !downNode.focus && downNode.kind !== 'url' && downNode.kind !== 'virtual') { this._promoteRelation(downNode.guid); } // BS-4: Alt-click writes a real relation
      else if (mode === 'down' && !moved && downNode) { if (downNode.kind === 'url') { try { window.open(downNode.guid, '_blank'); } catch (_e) {} } else if (downNode.kind === 'virtual') { /* unresolved — not navigable */ } else if (e.shiftKey || e.metaKey || e.ctrlKey) this._openRecord(downNode.guid, downNode.lineItemGuid); else if (!downNode.focus) this.setFocus(downNode.guid); } // P9: url opens externally; virtual is inert; BS-7: open lands on the exact source line
      else if (mode === 'dragnode' && this._drag) { const g = this._gateAt(rel(e).x, rel(e).y) || this._drag.gate; if (g) this._restructure(this._drag.guid, g); } // BS-5: dropped on a gate → write the relation
      this._drag = null; mode = null; downNode = null; downGate = null; downTask = null; try { cv.releasePointerCapture(e.pointerId); } catch (_e) {}
    };
    const onWheel = (e) => { e.preventDefault(); const p = rel(e); this.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0012)); this.dirty = true; };
    const onKey = (e) => {
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); this._pinned = !this._pinned; this.dirty = true; try { this.plugin.ui.addToaster({ title: this._pinned ? 'Plexus Brain: pinned (won’t auto-follow)' : 'Plexus Brain: following active record', dismissible: true }); } catch (_e) {} } // BS-10: pin toggle
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); this._colorMode = this._colorMode === 'collection' ? 'role' : 'collection'; this.dirty = true; try { this.plugin.ui.addToaster({ title: 'Plexus Brain: colour by ' + (this._colorMode === 'collection' ? 'COLLECTION' : 'relation role'), dismissible: true }); } catch (_e) {} } // BS-6: colour mode
    };
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerup', onUp); cv.addEventListener('wheel', onWheel, { passive: false }); cv.addEventListener('keydown', onKey);
    this._disposers.push(() => { cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerup', onUp); cv.removeEventListener('wheel', onWheel); cv.removeEventListener('keydown', onKey); });
  }
  // BS-4: promote an inferred/semantic neighbour to a DEFINED relation — write a record-relation property on the
  // focus pointing at the target, then re-derive so the ghost edge becomes a real typed edge. The Brain as a BUILDER.
  async _promoteRelation(targetGuid) {
    if (!this.focusGuid || !targetGuid || targetGuid === this.focusGuid) return;
    try {
      const rec = await this.plugin.data.getRecord(this.focusGuid); if (!rec || !rec.prop) return;
      const p = rec.prop('Related') || rec.prop('Friends') || rec.prop('Links') || rec.prop('See Also');
      if (!p) { try { this.plugin.ui.addToaster({ title: 'Plexus Brain: focus has no Related/Friends/Links relation property to write.', dismissible: true }); } catch (_e) {} return; }
      if (p.addValue) p.addValue(targetGuid); else if (p.set) p.set(targetGuid);
      try { this.plugin.ui.addToaster({ title: 'Linked as a real relation — re-deriving.', dismissible: true }); } catch (_e) {}
      this.setFocus(this.focusGuid); // re-derive: the edge is now a DEFINED relation
    } catch (e) { console.error('[Plexus Brain] promoteRelation', e); }
  }
  // BS-5: drag-to-restructure — a node dropped on a gate writes the matching relation property on the FOCUS
  // (up=parent, down=child, left/right/sib=friend) → the graph as a control surface. ExcaliBrain can't write typed props.
  async _restructure(targetGuid, gateKey) {
    if (!this.focusGuid || !targetGuid || targetGuid === this.focusGuid) return;
    const cand = gateKey === 'up' ? ['Parent', 'Parents', 'Source', 'Up'] : gateKey === 'down' ? ['Child', 'Children', 'Down', 'Subtasks'] : ['Related', 'Friends', 'Links', 'See Also'];
    try {
      const rec = await this.plugin.data.getRecord(this.focusGuid); if (!rec || !rec.prop) return;
      let p = null; for (const k of cand) { const pp = rec.prop(k); if (pp) { p = pp; break; } }
      if (!p) { try { this.plugin.ui.addToaster({ title: 'Plexus Brain: focus has no ' + cand[0] + '-type relation property to write.', dismissible: true }); } catch (_e) {} return; }
      if (p.addValue) p.addValue(targetGuid); else if (p.set) p.set(targetGuid);
      try { this.plugin.ui.addToaster({ title: 'Restructured — wrote the ' + gateKey + ' relation. Re-deriving.', dismissible: true }); } catch (_e) {}
      this.setFocus(this.focusGuid);
    } catch (e) { console.error('[Plexus Brain] restructure', e); }
  }
  async _openRecord(guid, lineGuid) {
    const ws = (this.plugin.getWorkspaceGuid && this.plugin.getWorkspaceGuid()) || this.plugin.workspaceGuid;
    let p = null; try { p = await this.plugin.ui.createPanel({ afterPanel: this.panel }); } catch (_e) {}
    if (!p) { try { p = await this.plugin.ui.createPanel(); } catch (_e) {} }
    if (!p) return;
    // BS-7: if the neighbour came from a specific source LINE, land on that exact line (highlighted), not just the record root.
    if (lineGuid) { try { const ok = await p.navigateTo({ itemGuid: lineGuid, highlight: true }); if (ok !== false) return; } catch (_e) {} }
    try { p.navigateTo({ type: 'edit_panel', rootId: guid, workspaceGuid: ws }); } catch (e) { console.error('[Plexus Brain] openRecord', e); }
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
      const inf = ed.relType === 'INFERRED'; // BP-3/BP-4: inferred relations render dashed + dimmer than defined ones
      ctx.strokeStyle = relColor(ed.role, ed.kind); ctx.globalAlpha = (inf ? 0.32 : 0.6) * e; ctx.lineWidth = 1.5 / z;
      ctx.setLineDash(inf ? [5 / z, 4 / z] : []);
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.quadraticCurveTo((f.x + tn.x) / 2, (f.y + tn.y) / 2, tn.x, tn.y); ctx.stroke();
      ctx.setLineDash([]);
      // P8: arrowhead encodes direction — 'in' (parent) points AT the focus, others point AWAY to the neighbour.
      const hx = ed.dir === 'in' ? f.x : tn.x, hy = ed.dir === 'in' ? f.y : tn.y, ox = ed.dir === 'in' ? tn.x : f.x, oy = ed.dir === 'in' ? tn.y : f.y;
      const ang = Math.atan2(hy - oy, hx - ox), aw = 9 / z;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - aw * Math.cos(ang - 0.4), hy - aw * Math.sin(ang - 0.4)); ctx.lineTo(hx - aw * Math.cos(ang + 0.4), hy - aw * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fillStyle = relColor(ed.role, ed.kind); ctx.fill();
      // BS-1: typed-edge label — the relation's FIELD NAME on DEFINED edges (inferred stay unlabeled to avoid clutter).
      if (ed.label && ed.relType === 'DEFINED' && z > 0.55) {
        const mx = (f.x + tn.x) / 2, my = (f.y + tn.y) / 2;
        ctx.font = '600 11px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        const lbl = this._clip(ctx, ed.label, 130), tw = ctx.measureText(lbl).width;
        ctx.globalAlpha = 0.96; ctx.fillStyle = '#0d1320';
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(mx - tw / 2 - 5, my - 9, tw + 10, 18, 5); else ctx.rect(mx - tw / 2 - 5, my - 9, tw + 10, 18); ctx.fill();
        ctx.fillStyle = relColor(ed.role, ed.kind); ctx.fillText(lbl, mx, my); ctx.textAlign = 'left';
      }
    }
    ctx.globalAlpha = 1;
    // BS-5: drag-to-restructure feedback — dashed line from the focus to the cursor; the target gate glows.
    if (this._drag) {
      const fn = this.graph.nodes[0]; if (fn) { const fp = pos(fn); ctx.strokeStyle = this._drag.gate ? '#22c55e' : '#7c5cff'; ctx.globalAlpha = 0.8; ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]); ctx.beginPath(); ctx.moveTo(fp.x, fp.y); ctx.lineTo(this._drag.x, this._drag.y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    }
    // nodes
    for (const nd of this.graph.nodes) {
      const sk = nd.skin || {}; const sc = nd.focus ? 1 : (sk.scale || 1); // BS-2: Priority scales the node
      const w = nd.w * sc, h = nd.h * sc; const P = pos(nd); const x = P.x - w / 2, y = P.y - h / 2; const rad = 9;
      if (nd.isNew && !nd.focus) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - 5, y - 5, w + 10, h + 10, rad + 4); else ctx.rect(x - 5, y - 5, w + 10, h + 10); ctx.lineWidth = 2.5 / z; ctx.strokeStyle = '#22c55e'; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1; } // BS-8: new-since-last-derive glow
      if (sk.urgent && !nd.focus) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x - 4, y - 4, w + 8, h + 8, rad + 3); else ctx.rect(x - 4, y - 4, w + 8, h + 8); ctx.lineWidth = 2.5 / z; ctx.strokeStyle = '#ef4444'; ctx.globalAlpha = 0.85; ctx.stroke(); ctx.globalAlpha = 1; } // Due-past urgency ring
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad); else ctx.rect(x, y, w, h);
      ctx.fillStyle = nd.focus ? '#7c5cff' : '#1b2030'; ctx.fill();
      // BS-6: in 'collection' colour mode the border is the collection colour; else Status skin or role colour.
      const border = nd.focus ? '#a78bfa' : (this._colorMode === 'collection' && nd.collection ? colorForString(nd.collection) : (sk.color || relColor(nd.role, nd.kind)));
      ctx.lineWidth = (nd === this._hover ? 2.5 : 1.5) / z; ctx.strokeStyle = border; ctx.stroke();
      ctx.fillStyle = nd.focus ? '#ffffff' : '#e6e8ee'; ctx.font = (nd.focus ? '600 15px' : '13px') + ' system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(this._clip(ctx, nd.title, w - 18), P.x, P.y);
      // BS-6: collection dot (top-left corner) — a stable per-collection colour, the grouping cue.
      if (!nd.focus && nd.collection) { ctx.beginPath(); ctx.arc(x + 9, y + 9, 3.4, 0, Math.PI * 2); ctx.fillStyle = colorForString(nd.collection); ctx.fill(); }
    }
    // BP-4: directional gate headers (cross layout only) — label · count (+overflow), click to collapse/expand the band.
    this._gateRects = [];
    if (this.graph.bands) {
      ctx.font = '600 12px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      for (const g of Object.values(this.graph.bands)) {
        if (!g.count) continue;
        const P = { x: g.ax, y: g.ay };
        const txt = g.label + ' · ' + g.count + (g.over ? ' +' + g.over : '') + (g.hidden ? '  ▸' : '');
        const tw = ctx.measureText(txt).width, padX = 9, gw = tw + padX * 2, gh = 22;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(P.x - gw / 2, P.y - gh / 2, gw, gh, 11); else ctx.rect(P.x - gw / 2, P.y - gh / 2, gw, gh);
        ctx.fillStyle = '#0d1320'; ctx.globalAlpha = g.hidden ? 0.45 : 0.95; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1.3 / z; ctx.strokeStyle = relColor(g.role, null); ctx.stroke();
        ctx.fillStyle = g.hidden ? '#8b93a7' : relColor(g.role, null); ctx.fillText(txt, P.x, P.y);
        this._gateRects.push({ key: g.key, cx: P.x, cy: P.y, w: gw, h: gh });
      }
    }
    // IO-4: focus open-tasks rail — real togglable task line items, stacked just below the focus node.
    this._taskRects = [];
    const ftasks = (this._derived && this._derived.focus && this._derived.focus.tasks) || [];
    if (ftasks.length) {
      ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const RW = 250, RH = 24, x0 = -RW / 2, y0 = 48, show = Math.min(ftasks.length, 3);
      for (let i = 0; i < show; i++) {
        const t = ftasks[i], ry = y0 + i * (RH + 4);
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, ry, RW, RH, 6); else ctx.rect(x0, ry, RW, RH);
        ctx.fillStyle = '#141a28'; ctx.globalAlpha = 0.96; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 1 / z; ctx.strokeStyle = '#2a3344'; ctx.stroke();
        const cbx = x0 + 7, cby = ry + (RH - 14) / 2;
        ctx.lineWidth = 1.4 / z; ctx.strokeStyle = '#f59e0b'; ctx.strokeRect(cbx, cby, 14, 14);
        ctx.fillStyle = '#cdd3df'; ctx.fillText(this._clip(ctx, t.text, RW - 34), cbx + 22, ry + RH / 2);
        this._taskRects.push({ guid: t.guid, cx: x0 + RW / 2, cy: ry + RH / 2, w: RW, h: RH, cbx, cby, li: t.li });
      }
      if (ftasks.length > show) { ctx.fillStyle = '#8b93a7'; ctx.fillText('+' + (ftasks.length - show) + ' more open', x0 + 8, y0 + show * (RH + 4) + 8); }
    }
    ctx.textAlign = 'left';
  }
  // BP-4: which gate header (if any) is at a screen point — mirrors _nodeAt (screen → world).
  _gateAt(sx, sy) {
    if (!this._gateRects || !this._gateRects.length) return null;
    const w = this.camera.screenToWorld(sx, sy);
    for (const g of this._gateRects) { if (Math.abs(w.x - g.cx) <= g.w / 2 && Math.abs(w.y - g.cy) <= g.h / 2) return g.key; }
    return null;
  }
  // IO-4: which task-rail checkbox (if any) is at a screen point. Returns the rail entry so onUp can toggle it.
  _taskAt(sx, sy) {
    if (!this._taskRects || !this._taskRects.length) return null;
    const w = this.camera.screenToWorld(sx, sy);
    for (const t of this._taskRects) { if (Math.abs(w.x - t.cx) <= t.w / 2 && Math.abs(w.y - t.cy) <= t.h / 2) return t; }
    return null;
  }
  async _toggleFocusTask(t) {
    if (!t || !t.li) return;
    try { await t.li.setTaskStatus('done'); } catch (e) { console.error('[Plexus Brain] setTaskStatus', e); return; }
    if (this._derived && this._derived.focus && this._derived.focus.tasks) this._derived.focus.tasks = this._derived.focus.tasks.filter((x) => x.guid !== t.guid);
    this.dirty = true;
  }
  destroy() { this.destroyed = true; if (this._refocusT) clearTimeout(this._refocusT); for (const dz of this._disposers.splice(0)) { try { dz(); } catch (_e) {} } }
}

/* ───────── plugin ───────── */
class Plugin extends AppPlugin {
  onLoad() {
    try { window.__plexusBrain && window.__plexusBrain.dispose(); } catch (_e) {}
    this._views = new Set(); this._lastRecordGuid = null; this._raf = 0; this._disposers = [];
    this._ontology = loadPlexusOntology(); // IO-3: shared collection/relation ontology
    window.__plexusBrain = { version: BRAIN_VERSION, dispose: () => this._teardown() };
    console.log('%c[Plexus Brain] v' + BRAIN_VERSION + ' loaded', 'color:#7c3aed;font-weight:bold');
    this.ui.injectCSS(BASE_CSS);
    this.ui.registerCustomPanelType(PANEL_ID, (panel) => this._mount(panel));
    this.ui.addCommandPaletteCommand({ label: 'Plexus Brain: Open graph', icon: 'ti-graph', onSelected: () => this._open(this._lastRecordGuid) });
    this.ui.addCommandPaletteCommand({ label: 'Plexus Brain: Focus current note', icon: 'ti-graph', onSelected: () => { const r = this._activeRecord(); this._open(r); } });
    this.ui.addCommandPaletteCommand({ label: 'Plexus Brain: Edit ontology (relation field names)', icon: 'ti-list-tree', onSelected: () => this._editOntology() }); // BP-7
    // BS-10: cross-plugin live companion — when you navigate to a record elsewhere, an OPEN Brain panel refocuses
    // to it (unless that view is pinned). Makes the Brain track Canvas/editor focus automatically.
    const track = (e) => { try { const r = e.panel && e.panel.getActiveRecord && e.panel.getActiveRecord(); if (r && r.guid) { this._lastRecordGuid = r.guid; for (const v of this._views) { if (!v._pinned && v.focusGuid && v.focusGuid !== r.guid) v._scheduleReFocus(r.guid, { nav: false }); } } } catch (_e) {} }; // debounced (rapid nav coalesces)
    try { this.events.on('panel.focused', track); this.events.on('panel.navigated', track); } catch (_e) {}
    // Re-derive on data change — DEBOUNCED + cache-invalidated, so an edit storm doesn't fire dozens of derives.
    const onChange = (e) => { const g = e && e.recordGuid; if (g) invalidateDerive(this, g); for (const v of this._views) { if (!g || v.focusGuid === g || v.graph.nodes.some((n) => n.guid === g)) { invalidateDerive(this, v.focusGuid); v._scheduleReFocus(v.focusGuid, { nav: true, force: true }); } } };
    try { for (const ev of ['record.updated', 'lineitem.updated', 'lineitem.created', 'lineitem.deleted']) this.events.on(ev, onChange); } catch (_e) {}
    const tick = () => { for (const v of this._views) { if (!v.host || !v.host.isConnected) { v.destroy(); this._views.delete(v); continue; } if (v.dirty) { try { v.render(); } catch (e) { console.error('[Plexus Brain] render', e); } v.dirty = false; } } this._raf = requestAnimationFrame(tick); };
    this._raf = requestAnimationFrame(tick);
    if (TEST_HOOKS) this._installTestHooks();
  }
  _teardown() { cancelAnimationFrame(this._raf); for (const v of this._views) { try { v.destroy(); } catch (_e) {} } this._views.clear(); window.__plexusBrain = undefined; }
  onUnload() { this._teardown(); }
  _activeRecord() { try { const p = this.ui.getActivePanel(); const r = p && p.getActiveRecord && p.getActiveRecord(); return (r && r.guid) || this._lastRecordGuid; } catch (_e) { return this._lastRecordGuid; } }
  // BP-2: build the field-resolution index once. Field schema (cheap) is awaited; the expensive recordGuid→collection
  // map builds in the BACKGROUND so the graph never blocks — DEFINED-relation enrichment lights up when it's ready.
  // BP-7: ontology editor — edit the shared relation field-name buckets; persists to localStorage['plexus_ontology']
  // (the IO-3 shared source) and rebuilds the field index. Canvas/Templater pick it up on their next load.
  _editOntology() {
    const ont = this._ontology || loadPlexusOntology(); const rb = ont.relationBuckets || {};
    const ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
    const box = document.createElement('div'); box.style.cssText = 'background:var(--cards-bg,#1b2030);color:var(--color-text-400,#e6e8ee);border:1px solid var(--cards-border-color,rgba(255,255,255,.12));border-radius:12px;padding:18px 20px;min-width:460px;max-width:640px;max-height:80vh;overflow:auto;font-family:system-ui,sans-serif';
    box.innerHTML = '<div style="font-size:15px;font-weight:600;margin:0 0 4px">Plexus Ontology — relation field names</div><div style="font-size:12px;opacity:.7;margin-bottom:12px">Comma-separated property field labels per relation category. The Brain maps a typed record-property to a category by its field name.</div>';
    const fields = {};
    for (const k of ['parents', 'children', 'leftFriends', 'rightFriends', 'previous', 'next']) {
      const lab = document.createElement('label'); lab.style.cssText = 'display:block;font-size:12px;margin:8px 0 2px;font-weight:600'; lab.textContent = k;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = (rb[k] || []).join(', '); inp.style.cssText = 'width:100%;box-sizing:border-box;background:var(--input-bg-color,rgba(0,0,0,.25));color:var(--color-text-400,#e6e8ee);border:1px solid var(--cards-border-color,rgba(255,255,255,.12));border-radius:6px;padding:7px 9px;font-size:13px';
      box.appendChild(lab); box.appendChild(inp); fields[k] = inp;
    }
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.cssText = 'padding:7px 14px;border-radius:6px;border:1px solid var(--cards-border-color,rgba(255,255,255,.12));background:transparent;color:inherit;cursor:pointer';
    const save = document.createElement('button'); save.textContent = 'Save'; save.style.cssText = 'padding:7px 14px;border-radius:6px;border:none;background:#7c3aed;color:#fff;cursor:pointer';
    cancel.addEventListener('click', () => ov.remove());
    save.addEventListener('click', () => {
      const override = JSON.parse(JSON.stringify(this._ontology || loadPlexusOntology())); override.relationBuckets = override.relationBuckets || {};
      for (const k in fields) override.relationBuckets[k] = fields[k].value.split(',').map((s) => s.trim()).filter(Boolean);
      try { localStorage.setItem('plexus_ontology', JSON.stringify(override)); } catch (_e) {}
      try { window.__plexusOntology = override; } catch (_e) {}
      this._ontology = override; this._indexBuilt = false; // rebuild the field index with the new buckets
      try { this._deriveCache && this._deriveCache.clear(); } catch (_e) {} // ontology change invalidates every cached derive
      for (const v of this._views) v.setFocus(v.focusGuid, true, true);
      ov.remove();
      try { this.ui.addToaster({ title: 'Ontology saved. Reload Canvas/Templater to share the change.', dismissible: true }); } catch (_e) {}
    });
    row.appendChild(cancel); row.appendChild(save); box.appendChild(row);
    ov.appendChild(box); ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }
  async _ensureIndex() {
    if (this._indexBuilt) return;
    this._indexBuilt = true;
    try { this._fieldIndex = await buildFieldIndex(this); } catch (_e) { this._fieldIndex = { byGuid: {}, byName: {} }; }
    buildRecordCollectionMap(this, this._fieldIndex).then((m) => { this._recColMap = m; }).catch(() => { this._recColMap = {}; });
  }
  // Phase 6: local embedder (transformers.js, in-browser) — powers the semantic lens.
  _getEmbedder() {
    if (this._embedderP) return this._embedderP;
    this._embedderP = (async () => { const t = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6'); try { t.env.allowLocalModels = false; } catch (_e) {} return await t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); })();
    return this._embedderP;
  }
  async _embed(text) { const pipe = await this._getEmbedder(); const out = await pipe(String(text || '').slice(0, 400), { pooling: 'mean', normalize: true }); return Array.from(out.data); }
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
      // Phase 5 filters: focus a multi-kind record (journal: in+tag), toggle 'tag' off -> node count drops.
      filterTest: async (guid) => {
        let v = [...this._views].pop(); if (!v) { await this._open(guid); for (let i = 0; i < 40; i++) { await sleep(150); v = [...this._views].pop(); if (v) break; } }
        if (!v) return { error: 'no view' };
        v._filter = { in: true, ref: true, prop: true, tag: true }; await v.setFocus(guid); const before = v.graph.nodes.length;
        v._filter.tag = false; v._relayout(); await sleep(450); const afterNoTag = v.graph.nodes.length;
        v._filter.tag = true; v._relayout(); await sleep(450); const afterTag = v.graph.nodes.length;
        return { before, afterNoTag, afterTag, ok: afterNoTag < before && afterTag === before };
      },
      // Phase 7 alt layout: switch to tree -> a neighbour sits in the grid below (y>=100); back to radial.
      layoutTest: async (guid) => {
        let v = [...this._views].pop(); if (!v) { await this._open(guid); for (let i = 0; i < 40; i++) { await sleep(150); v = [...this._views].pop(); if (v) break; } }
        if (!v) return { error: 'no view' }; await v.setFocus(guid);
        if (v.graph.nodes.length < 2) return { error: 'no neighbours to lay out' };
        v._layoutMode = 'tree'; v._relayout(); await sleep(400); const treeY = v.graph.nodes[1].y;
        v._layoutMode = 'radial'; v._relayout(); await sleep(400); const radialY = v.graph.nodes[1].y;
        return { treeNeighbourY: Math.round(treeY), radialNeighbourY: Math.round(radialY), ok: treeY >= 90 && treeY !== radialY };
      },
      // Phase 6 (view-independent): the local embedder loads + ranks similar text higher.
      embedTest: async () => {
        try {
          const a = await this._embed('cat dog pet animal'), b = await this._embed('puppy kitten pets'), c = await this._embed('quarterly budget finance');
          const cos = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * y[i]; return s; };
          return { dim: a.length, modelLoaded: !!this._embedderP, petSim: +cos(a, b).toFixed(3), petFinSim: +cos(a, c).toFixed(3), ok: cos(a, b) > cos(a, c) };
        } catch (e) { return { error: String(e) }; }
      },
      // Phase 6 semantic lens: focus a record, enable the lens, confirm 'sem' neighbours get added.
      semLensTest: async (guid) => {
        let v = [...this._views].pop(); if (!v) { await this._open(guid); for (let i = 0; i < 40; i++) { await sleep(150); v = [...this._views].pop(); if (v) break; } }
        if (!v) return { error: 'no view' };
        await v.setFocus(guid); const before = v._derived ? v._derived.neighbours.length : -1;
        v._filter.sem = true; await v._addSemantic();
        const after = v._derived ? v._derived.neighbours.length : -1;
        const semN = v._derived ? v._derived.neighbours.filter((n) => n.kind === 'sem').length : -1;
        return { before, after, semNeighbours: semN, ok: after >= before };
      },
      // Phase 4 navigation: focus A, refocus to B, _back -> A, _fwd -> B. Reuses an existing view +
      // resets history (robust to panel saturation; doesn't depend on opening a fresh panel).
      navTest: async (a, b) => {
        let v = [...this._views].pop();
        if (!v) { await this._open(a); for (let i = 0; i < 40; i++) { await sleep(150); v = [...this._views].pop(); if (v) break; } }
        if (!v) return { error: 'no view' };
        v._history = []; v._hi = -1;
        await v.setFocus(a); await v.setFocus(b);
        const afterB = v.focusGuid, depth = v._history.length;
        v._back(); await sleep(500); const afterBack = v.focusGuid;
        v._fwd(); await sleep(500); const afterFwd = v.focusGuid;
        return { afterB, afterBack, afterFwd, histDepth: depth, ok: afterB === b && afterBack === a && afterFwd === b && depth === 2 };
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
.pb-host .pb-root .pb-chip { font-size: 11px; padding: 3px 9px; border-radius: 11px; border: 1px solid var(--c); background: var(--c); color: #0f1117; font-weight: 600; cursor: pointer; }
.pb-host .pb-root .pb-chip.off { background: transparent; color: #6b7280; opacity: .6; }
`;
