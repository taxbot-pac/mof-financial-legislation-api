// scripts/sync-laws.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SOURCES } from "./sources.mjs";

const OUT_DIR = path.resolve("api");
const SNAP_DIR = path.join(OUT_DIR, "snapshots");
const DIFF_DIR = path.join(OUT_DIR, "diff");
const today = new Date().toISOString().slice(0, 10);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8"); }
async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "uae-laws-sync/1.0" }});
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}
function hash(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

function textBetween(html, start, end) {
  const i = html.indexOf(start);
  if (i === -1) return "";
  const j = html.indexOf(end, i + start.length);
  return j === -1 ? "" : html.slice(i + start.length, j);
}
function extractLinks(html) {
  const out = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, "").trim();
    out.push({ href, label });
  }
  return out;
}

async function parseMohreIndex(url) {
  const html = await get(url);
  const links = extractLinks(html).filter(a =>
    /decree|law|resolution|regulation|domestic|emiratisation|emiratisation/i.test(a.label)
  );
  const items = [];
  for (const a of links) {
    const t = a.label.replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    if (!t) continue;
    items.push({ id: slugFromTitle(t), title: t, sourceUrl: absolute(url, a.href) });
  }
  const uniq = {};
  for (const it of items) uniq[it.id] = it;
  return Object.values(uniq);
}

function absolute(base, href) { try { return new URL(href, base).toString(); } catch { return href; } }
function slugFromTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9/ ]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60);
}

async function enrichFromPortal(item, url) {
  if (!url) return item;
  try {
    const html = await get(url);
    const statusBlock = textBetween(html, "Status", "</");
    const effectiveBlock = textBetween(html, "Effective Date", "</");
    const repealCue = /repeal|repealed|replaced/i.test(html);
    const effectiveFrom = (effectiveBlock.match(/\d{4}-\d{2}-\d{2}/) || [null])[0] ||
                          (effectiveBlock.match(/\d{1,2}\s+\w+\s+\d{4}/) || [null])[0];
    const status = repealCue ? "repealed" :
      /in\s*force|active/i.test(statusBlock) ? "in_force" :
      /amend|amended/i.test(html) ? "amended" : "unknown";
    return { ...item, uaePortal: url, status, effectiveFrom: normaliseDate(effectiveFrom), metaHash: hash(html).slice(0, 12) };
  } catch {
    return { ...item, uaePortal: url, status: item.status || "unknown" };
  }
}
function normaliseDate(d) {
  if (!d) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : (() => {
    const dt = Date.parse(d);
    return isNaN(dt) ? null : new Date(dt).toISOString().slice(0,10);
  })();
  return iso;
}

async function main() {
  mkdirp(OUT_DIR); mkdirp(SNAP_DIR); mkdirp(DIFF_DIR);
  const prevName = fs.readdirSync(SNAP_DIR).filter(f => f.endswith(".json")).sort().pop();
  const prevSnap = prevName ? readJSON(path.join(SNAP_DIR, prevName), []) : [];

  const discovered = [];
  for (const idx of SOURCES.indexPages) discovered.push(...await parseMohreIndex(idx));
  const byId = new Map();
  for (const it of discovered) byId.set(it.id, it);

  for (const seed of SOURCES.instruments) {
    const base = byId.get(seed.id) || { id: seed.id, title: seed.titleHint, sourceUrl: seed.mohreRef };
    base.topic = seed.topic || base.topic || "labour";
    const enriched = await enrichFromPortal(base, seed.uaePortal);
    byId.set(seed.id, enriched);
  }

  const all = Array.from(byId.values());
  for (const it of all) { it.asAmendedBy = it.asAmendedBy || []; it.repealedBy = it.repealedBy || null; }

  for (const it of all) {
    const m = it.title?.match(/(33|9)\/?20(21|22|23|24)/);
    if (m && /amend/i.test(it.title)) {
      const target = all.find(x => /33\s*of\s*2021|33\/2021/i.test(x.title));
      if (target && !target.asAmendedBy.includes(it.id)) target.asAmendedBy.push(it.id);
    }
    if (/repeal|replaced/i.test(it.title)) {
      const cand = all
        .filter(x => x.topic === it.topic && x.effectiveFrom && it.effectiveFrom && x.effectiveFrom < it.effectiveFrom)
        .sort((a,b)=> (b.effectiveFrom||"").localeCompare(a.effectiveFrom||""))[0];
      if (cand && !cand.repealedBy) cand.repealedBy = it.id;
    }
  }

  const now = today;
  for (const it of all) {
    if (it.repealedBy) { it.effectiveTo = now; it.status = "repealed"; }
    else if ((it.asAmendedBy || []).length) { it.status = it.status === "repealed" ? "repealed" : "amended"; }
    else { it.status = it.status || "in_force"; }
  }

  const snapPath = path.join(SNAP_DIR, `${today}.json`);
  writeJSON(snapPath, all);

  const inForce = all.filter(x => x.status != "repealed");
  writeJSON(path.join(OUT_DIR, "laws.json"), inForce);

  const diff = computeDiff(prevSnap || [], all);
  if (prevName) {
    const diffName = f"{prevName.replace('.json','')}_to_{today}.json";
    writeJSON(path.join(DIFF_DIR, diffName), diff);
  }

  console.log(`Snapshot: ${snapPath}`);
  console.log(`In-force: ${path.join(OUT_DIR, "laws.json")}`);
  console.log(`Added: ${diff.added.length}, Removed: ${diff.removed.length}, Changed: ${diff.changed.length}`);
}

function keyBy(arr) { const m = new Map(); for (const x of arr) m.set(x.id, x); return m; }
function computeDiff(prev, curr) {
  const A = keyBy(prev); const B = keyBy(curr);
  const added = [], removed = [], changed = [];
  for (const id of B.keys()) {
    if (!A.has(id)) { added.push(B.get(id)); continue; }
    const p = A.get(id), c = B.get(id);
    const shallowKeys = ["title","status","effectiveFrom","effectiveTo","repealedBy"];
    const delta = {};
    for (const k of shallowKeys) if ((p[k]||null) !== (c[k]||null)) delta[k] = { from: p[k]||null, to: c[k]||null };
    if (Object.keys(delta).length) changed.push({ id, changes: delta });
  }
  for (const id of A.keys()) if (!B.has(id)) removed.push(A.get(id));
  return { generatedAt: new Date().toISOString(), added, removed, changed };
}

main().catch(err => { console.error(err); process.exit(1); });
