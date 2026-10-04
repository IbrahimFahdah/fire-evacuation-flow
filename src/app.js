(function () {
"use strict";
const $ = s => document.querySelector(s);
const Core = SIM_CORE(), Tests = TEST_SCENES(), Dxf = DXF_IMPORT(Core);
const CS = Core.CS, INF = Core.INF;

// ------------------------------------------------------------------ settings
const PRESETS = {
  "A-M1": { label: "Office (A) · M1 management · simple building B1–B2 · automatic alarm A1–A2", p1: 0.5, p99: 1.0 },
  "A-M1-B3": { label: "Office (A) · M1 · large or complex building B3", p1: 1.0, p99: 2.0 },
  "A-M2": { label: "Office (A) · M2 management · B1–B2 · A1–A2", p1: 1.0, p99: 2.0 },
  "B-M1": { label: "Retail (B, awake & unfamiliar) · M1 · B1 · A1–A2", p1: 0.5, p99: 2.0 },
  "B-M2": { label: "Retail (B) · M2 · B1 · A1–A2", p1: 1.0, p99: 3.0 },
  "M3": { label: "Any · M3 basic management (PD 7974-6: > 15 min, not acceptable for design)", p1: 15, p99: 20 },
};
const S = {
  N: 250, useSeats: true, vMean: 1.25, alarm: 30,
  pre: "preset", preset: "A-M1", p1: 30, p99: 60, uMin: 15, uMax: 90, nMean: 45, nSd: 15, fixed: 30,
  exitChoice: "nearest", furniture: true, stairModel: false, seed: 1,
  L: { travel: 91, stair: 7.6, level: 5.0, spr: true },
};
let parsed = null, roles = {}, model = null, env = null, sim = null, wallG = null, srcName = "";
let playing = true, speed = 4, heatMode = "peak", tool = "select", selected = null, optA = null, done = false;
let view = { cx: 24, cy: 12, s: 18 };
let needStatic = true, needHeat = true, lastHeat = 0, lastPanel = 0;
let colors = {};

function preCfg() {
  if (S.pre === "preset") { const p = PRESETS[S.preset]; return { type: "lognormal", p1: p.p1 * 60, p99: p.p99 * 60 }; }
  if (S.pre === "lognormal") return { type: "lognormal", p1: S.p1, p99: S.p99 };
  if (S.pre === "uniform") return { type: "uniform", min: S.uMin, max: Math.max(S.uMin, S.uMax) };
  if (S.pre === "normal") return { type: "normal", mean: S.nMean, sd: S.nSd };
  if (S.pre === "fixed") return { type: "fixed", fixed: S.fixed };
  return { type: "none" };
}
function simCfg(seed) {
  return { N: S.N, seed: seed || S.seed, pre: preCfg(), alarm: S.alarm, exitChoice: S.exitChoice, stairModel: S.stairModel, useSeats: S.useSeats, params: { vMean: S.vMean } };
}
const fmt = t => { if (t == null || t < 0 || !isFinite(t)) return "—"; t = Math.round(t); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ["paper", "surface", "surface-2", "ink", "ink-2", "ink-3", "line", "wall", "obst", "floor", "furn", "exit", "exit-ink", "exit-soft", "warn", "crit", "sel", "agent", "wait"]) colors[k] = cs.getPropertyValue("--" + k).trim();
  needStatic = true; needHeat = true;
}

// ------------------------------------------------------------------ canvas & view
const cv = $("#cv"), ctx = cv.getContext("2d"), stage = $("#stage");
let cw = 0, ch = 0, dpr = 1;
const stat = document.createElement("canvas"), sctx = stat.getContext("2d");
const heatC = document.createElement("canvas"), hctx = heatC.getContext("2d");
const zoneC = document.createElement("canvas"), zctx = zoneC.getContext("2d");
function resize() {
  const r = stage.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = Math.max(1, r.width); ch = Math.max(1, r.height);
  for (const c of [cv, stat]) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
  needStatic = true;
}
new ResizeObserver(resize).observe(stage);
const W2S = (x, y) => [(x - view.cx) * view.s + cw / 2, ch / 2 - (y - view.cy) * view.s];
const S2W = (px, py) => [(px - cw / 2) / view.s + view.cx, view.cy - (py - ch / 2) / view.s];
function fit() {
  if (!model) return;
  const b = model.bounds, pad = 1.5;
  const w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
  const topRoom = cw < 700 ? 110 : 80, botRoom = 60;
  view.s = Math.min(cw / w, (ch - topRoom - botRoom) / h);
  view.cx = (b[0] + b[2]) / 2; view.cy = (b[1] + b[3]) / 2 - (topRoom - botRoom) / 2 / view.s;
  needStatic = true;
}

// ------------------------------------------------------------------ door geometry helpers
const dp = (d, s, t, h) => { h = h || d.hinge; return [h[0] + d.u[0] * s + d.n[0] * t, h[1] + d.u[1] * s + d.n[1] * t]; };
function doorMid(d) { return dp(d, d.width / 2, 0); }
function bandOf(d) { return d.band || [-0.15, 0.15]; }

// wall raster with every opening shut: used to keep doors inside walls
function buildWallRaster() {
  const saved = model.doors.map(d => d.blocked);
  model.doors.forEach(d => d.blocked = true);
  wallG = Core.rasterize(model, {});
  model.doors.forEach((d, i) => d.blocked = saved[i]);
}
function isWall(x, y) { const k = Core.cellOf(wallG, x, y); return k >= 0 && wallG.obst[k] === 1; }
function validPlacement(d, hinge, width) {
  const b = bandOf(d), tm = (b[0] + b[1]) / 2;
  let tot = 0, w = 0;
  for (let s = 0.05; s <= width - 0.05; s += 0.05) { tot++; const p = dp(d, s, tm, hinge); if (isWall(p[0], p[1])) w++; }
  if (!tot || w / tot < 0.92) return false;
  for (const o of model.doors) {
    if (o === d) continue;
    if (Math.abs(o.u[0] * d.u[0] + o.u[1] * d.u[1]) < 0.99) continue;
    const rel = [o.hinge[0] - hinge[0], o.hinge[1] - hinge[1]];
    if (Math.abs(rel[0] * d.n[0] + rel[1] * d.n[1]) > 0.4) continue;
    let a0 = rel[0] * d.u[0] + rel[1] * d.u[1], a1 = a0 + o.width * (o.u[0] * d.u[0] + o.u[1] * d.u[1]);
    if (a0 > a1) [a0, a1] = [a1, a0];
    if (a1 > -0.1 && a0 < width + 0.1) return false;
  }
  return true;
}

// ------------------------------------------------------------------ load / build
function loadText(text, name, isSample) {
  try { parsed = Dxf.parse(text); } catch (e) { toast("Could not read that file as DXF (" + e.message + ")"); return; }
  srcName = name;
  roles = {};
  for (const l in parsed.layers) roles[l] = Dxf.guessRole(l);
  // layers used only inside blocks or entities may be missing from TABLES
  if (isSample) { buildFromRoles(); return; }
  openLayerModal();
}
function openLayerModal() {
  const F = Dxf.flatten(parsed), counts = {};
  for (const p of F.prims) counts[p.layer] = (counts[p.layer] || 0) + 1;
  for (const l in counts) if (!(l in roles)) roles[l] = Dxf.guessRole(l);
  const names = Object.keys(roles).filter(l => counts[l]).sort();
  $("#mInfo").textContent = srcName + " · " + names.length + " layers with geometry · " + F.inserts.length + " block inserts. Roles are guessed from layer names — check them, then build.";
  let h = "<tr><th>Layer</th><th class='num'>Items</th><th>Role</th></tr>";
  names.forEach((l, i) => {
    h += "<tr><td style='font-family:var(--f-mono);font-size:12px'>" + esc(l) + "</td><td class='num'>" + counts[l] + "</td><td><select data-layer='" + i + "' id='role-" + i + "'>" +
      Dxf.ROLES.map(r => "<option value='" + r + "'" + (roles[l] === r ? " selected" : "") + ">" + Dxf.ROLE_LABEL[r] + "</option>").join("") + "</select></td></tr>";
  });
  $("#mTable").innerHTML = h;
  $("#mTable").querySelectorAll("select").forEach(sel => sel.addEventListener("change", () => { roles[names[+sel.dataset.layer]] = sel.value; }));
  $("#modal").hidden = false;
  $("#mOk").focus();
}
$("#mCancel").onclick = () => { $("#modal").hidden = true; };
$("#mOk").onclick = () => { $("#modal").hidden = true; buildFromRoles(); };

function buildFromRoles() {
  busy(true);
  setTimeout(() => {
    try {
      model = Dxf.buildModel(parsed, roles);
      Dxf.detectExits(model);
    } catch (e) { busy(false); toast("Import failed: " + e.message); console.error(e); return; }
    selected = null; optA = null; renderSel();
    buildWallRaster();
    fit();
    const area = (model.bounds[2] - model.bounds[0]) * (model.bounds[3] - model.bounds[1]);
    $("#hudSrc").innerHTML = "<b>" + esc(srcName) + "</b> · " + Math.round(area) + " m² · " + model.doors.length + " doors";
    const nExit = model.doors.filter(d => d.isExit).length;
    if (model.warnings.length) toast(model.warnings[0]);
    else if (!nExit) toast("No exits recognised — select a door and tick “This is an exit”.");
    renderNPresets();
    rebuild(true);
  }, 30);
}

function rebuild(keepSeed) {
  busy(true);
  setTimeout(() => {
    try { env = Core.buildEnv(model, { furniture: S.furniture }); }
    catch (e) { busy(false); toast("Could not build routes: " + e.message); console.error(e); return; }
    buildZoneImage();
    renderExits();
    renderChecks();
    restart(keepSeed !== false);
    busy(false);
    needStatic = true;
  }, 20);
}
function restart(keepSeed) {
  if (!env) return;
  if (!keepSeed) S.seed = (S.seed % 9973) + 1;
  sim = Core.createSim(env, simCfg());
  done = false; needHeat = true;
  if (!env.exits.length) toast("No usable exits: everyone stays put. Mark at least one exit door.");
  renderResults(true);
}

// ------------------------------------------------------------------ rendering
function buildZoneImage() {
  const g = env.g; zoneC.width = g.nx; zoneC.height = g.ny;
  const img = zctx.createImageData(g.nx, g.ny);
  const c = hexToRgb(colors.exit);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i; if (!env.zone[k]) continue;
    const o = ((g.ny - 1 - j) * g.nx + i) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 34;
  }
  zctx.putImageData(img, 0, 0);
}
function hexToRgb(h) {
  h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function pathPoly(c, pts, close) {
  c.beginPath();
  pts.forEach((p, i) => { const q = W2S(p[0], p[1]); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
  if (close) c.closePath();
}
function drawStatic() {
  const c = sctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = colors.floor; c.fillRect(0, 0, cw, ch);
  if (!model) return;
  const s = view.s;
  // 1 m dot grid inside bounds when zoomed in
  if (s > 14) {
    const b = model.bounds; c.fillStyle = colors.line;
    for (let x = Math.ceil(b[0]); x <= b[2]; x++) for (let y = Math.ceil(b[1]); y <= b[3]; y++) { const q = W2S(x, y); if (q[0] > -2 && q[0] < cw + 2 && q[1] > -2 && q[1] < ch + 2) c.fillRect(q[0] - 0.75, q[1] - 0.75, 1.5, 1.5); }
  }
  // exit zones
  if (env && zoneC.width) {
    const g = env.g, a = W2S(g.x0, g.y0 + g.ny * CS);
    c.imageSmoothingEnabled = false;
    c.drawImage(zoneC, a[0], a[1], g.nx * CS * s, g.ny * CS * s);
    c.imageSmoothingEnabled = true;
  }
  // geometry by role
  const lw = Math.max(0.6, Math.min(1.4, s / 18));
  for (const p of model.draw) {
    if (p.kind === "text") continue;
    if (p.role === "furniture") {
      c.strokeStyle = colors.furn; c.lineWidth = lw * 0.8;
      if (p.kind === "circle" && p.r < 0.4) { const q = W2S(p.c[0], p.c[1]); c.beginPath(); c.arc(q[0], q[1], p.r * s, 0, 7); c.stroke(); continue; }
      pathPoly(c, p.pts, p.closed); c.stroke();
    } else if (p.role === "stair") {
      c.strokeStyle = colors["ink-3"]; c.lineWidth = lw * 0.8; pathPoly(c, p.pts, p.closed); c.stroke();
    } else if (p.role === "exit") {
      c.strokeStyle = colors.exit; c.lineWidth = lw; pathPoly(c, p.pts, p.closed); c.stroke();
    } else if (p.role === "obstacle") {
      if (p.closed && p.pts.length > 2) { c.fillStyle = colors.obst; pathPoly(c, p.pts, true); c.fill(); }
      else { c.strokeStyle = colors.obst; c.lineWidth = lw; pathPoly(c, p.pts, false); c.stroke(); }
    }
  }
  c.fillStyle = colors.wall; c.strokeStyle = colors.wall;
  for (const p of model.draw) {
    if (p.role !== "wall") continue;
    if ((p.kind === "poly" || p.kind === "circle") && p.closed && p.pts.length > 2) { pathPoly(c, p.pts, true); c.fill(); }
    else { c.lineWidth = Math.max(1, 0.1 * s); pathPoly(c, p.pts, false); c.stroke(); }
  }
  // door patches (original openings that moved / closed) and current openings
  for (const d of model.doors) {
    if (!d.orig) continue;
    const moved = Math.hypot(d.orig.hinge[0] - d.hinge[0], d.orig.hinge[1] - d.hinge[1]) > 0.01 || Math.abs(d.orig.width - d.width) > 0.01 || d.blocked;
    if (!moved) continue;
    const b = bandOf(d);
    c.fillStyle = colors.wall;
    pathPoly(c, [dp(d, -0.01, b[0] + 0.03, d.orig.hinge), dp(d, d.orig.width + 0.01, b[0] + 0.03, d.orig.hinge), dp(d, d.orig.width + 0.01, b[1] - 0.03, d.orig.hinge), dp(d, -0.01, b[1] - 0.03, d.orig.hinge)], true); c.fill();
  }
  for (const d of model.doors) {
    if (d.blocked) continue;
    const b = bandOf(d);
    c.fillStyle = colors.floor;
    pathPoly(c, [dp(d, 0, b[0] - 0.02), dp(d, d.width, b[0] - 0.02), dp(d, d.width, b[1] + 0.02), dp(d, 0, b[1] + 0.02)], true); c.fill();
  }
  // texts (room names) — skip title block / far away
  const b = model.bounds;
  c.fillStyle = colors["ink-3"];
  for (const t of model.texts) {
    if (t.p[0] < b[0] - 0.5 || t.p[0] > b[2] + 0.5 || t.p[1] < b[1] - 0.5 || t.p[1] > b[3] + 0.5) continue;
    if (t.ins >= 0 && t.role === "exit") continue;
    const px = t.h * s; if (px < 2.6) continue;
    const q = W2S(t.p[0], t.p[1]);
    c.save(); c.translate(q[0], q[1]); c.rotate(-t.rot * Math.PI / 180);
    c.font = "500 " + Math.max(8.5, Math.min(13, px)).toFixed(1) + "px " + getComputedStyle(document.body).getPropertyValue("--f-mono");
    c.textAlign = t.align === "center" || t.align === "mtext" ? "center" : (t.align === "right" ? "right" : "left");
    c.textBaseline = t.valign === "middle" ? "middle" : (t.valign === "top" ? "top" : "alphabetic");
    c.fillText(t.text.trim(), 0, 0); c.restore();
  }
  // doors
  for (const d of model.doors) drawDoor(c, d);
}
function drawDoor(c, d) {
  const s = view.s, b = bandOf(d), sel = d === selected;
  const col = d.blocked ? colors.crit : (d.isExit ? colors.exit : colors["ink-2"]);
  c.lineWidth = sel ? 2 : 1.2;
  c.strokeStyle = sel ? colors.sel : col;
  if (d.blocked) {
    const a = dp(d, 0, b[0] - 0.15), e = dp(d, d.width, b[1] + 0.15), a2 = dp(d, 0, b[1] + 0.15), e2 = dp(d, d.width, b[0] - 0.15);
    const A = W2S(...a), E = W2S(...e), A2 = W2S(...a2), E2 = W2S(...e2);
    c.lineWidth = 2.2; c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(E[0], E[1]); c.moveTo(A2[0], A2[1]); c.lineTo(E2[0], E2[1]); c.stroke();
  } else {
    const leaves = d.double ? [[0, d.width / 2, 1], [d.width, d.width / 2, -1]] : [[0, d.width, 1]];
    for (const [s0, w, dir] of leaves) {
      const h = dp(d, s0, b[1] > 0 && d.n ? 0 : 0);
      const tip = [h[0] + d.n[0] * w, h[1] + d.n[1] * w];
      const H = W2S(...h), T = W2S(...tip);
      c.beginPath(); c.moveTo(H[0], H[1]); c.lineTo(T[0], T[1]); c.stroke();
      c.save(); c.setLineDash([3, 3]); c.beginPath();
      for (let k = 0; k <= 16; k++) {
        const a = (k / 16) * Math.PI / 2;
        const p = [h[0] + (d.u[0] * dir * Math.cos(a) + d.n[0] * Math.sin(a)) * w, h[1] + (d.u[1] * dir * Math.cos(a) + d.n[1] * Math.sin(a)) * w];
        const P = W2S(...p); k ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]);
      }
      c.stroke(); c.restore();
    }
  }
  if (d.isExit && !d.blocked) {
    // exit pill on the escape side
    const off = Math.max(b[1] + 0.9, d.width * 0.5 + 0.6);
    const m = dp(d, d.width / 2, off), M = W2S(...m);
    const label = "EXIT " + d.name;
    c.font = "600 11px " + getComputedStyle(document.body).getPropertyValue("--f-display");
    const tw = c.measureText(label).width + 12;
    c.fillStyle = colors.exit; roundRect(c, M[0] - tw / 2, M[1] - 9, tw, 18, 4); c.fill();
    c.fillStyle = colors["exit-ink"]; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(label, M[0], M[1] + 0.5);
  }
  if (sel) {
    const p0 = W2S(...dp(d, 0, 0)), p1 = W2S(...dp(d, d.width, 0));
    c.strokeStyle = colors.sel; c.lineWidth = Math.max(4, 0.35 * s); c.globalAlpha = 0.25; c.lineCap = "round";
    c.beginPath(); c.moveTo(p0[0], p0[1]); c.lineTo(p1[0], p1[1]); c.stroke(); c.globalAlpha = 1; c.lineCap = "butt";
    for (const p of [p0, p1]) { c.fillStyle = colors.surface; c.strokeStyle = colors.sel; c.lineWidth = 2; c.beginPath(); c.arc(p[0], p[1], 5, 0, 7); c.fill(); c.stroke(); }
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

const LOS = [[0.31, "A", null], [0.43, "B", [214, 233, 205]], [0.72, "C", [240, 228, 140]], [1.08, "D", [246, 190, 90]], [2.17, "E", [236, 120, 60]], [1e9, "F", [196, 40, 40]]];
function losOf(r) { for (let i = 0; i < LOS.length; i++) if (r < LOS[i][0]) return i; return 5; }
function drawHeat() {
  if (!sim) return;
  const H = sim.heat; heatC.width = H.nx; heatC.height = H.ny;
  const img = hctx.createImageData(H.nx, H.ny), D = img.data;
  let maxC = 1; if (heatMode === "cong") for (let k = 0; k < H.cong.length; k++) if (H.cong[k] > maxC) maxC = H.cong[k];
  for (let j = 0; j < H.ny; j++) for (let i = 0; i < H.nx; i++) {
    const k = j * H.nx + i, o = ((H.ny - 1 - j) * H.nx + i) * 4;
    if (heatMode === "peak") {
      const v = H.peak[k]; if (v < 0.72) continue;
      const li = losOf(v), L = LOS[li];
      D[o] = L[2][0]; D[o + 1] = L[2][1]; D[o + 2] = L[2][2]; D[o + 3] = 70 + li * 34;
    } else if (heatMode === "cong") {
      const v = H.cong[k]; if (v <= 0.2) continue;
      const f = Math.min(1, Math.sqrt(v / maxC));
      D[o] = 240 - 50 * f; D[o + 1] = 180 - 150 * f; D[o + 2] = 40; D[o + 3] = 70 + 170 * f;
    }
  }
  hctx.putImageData(img, 0, 0);
}
function draw() {
  if (needStatic) { drawStatic(); needStatic = false; }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(stat, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!sim || !model) return;
  if (heatMode !== "none") {
    const now = performance.now();
    if (needHeat || now - lastHeat > 350) { drawHeat(); lastHeat = now; needHeat = false; }
    const H = sim.heat, a = W2S(H.x0, H.y0 + H.ny * H.cs);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heatC, a[0], a[1], H.nx * H.cs * view.s, H.ny * H.cs * view.s);
  }
  // redraw doors over heat for legibility
  for (const d of model.doors) if (d.isExit || d === selected) drawDoor(ctx, d);
  const s = view.s, n = sim.n;
  const X = sim.X, Y = sim.Y, ST = sim.ST, R = sim.R, VX = sim.VX, VY = sim.VY, V0 = sim.V0, RHO = sim.RHO, TS = sim.TS;
  const groups = { wait: [], move: [], slow: [], crit: [], stair: [] };
  for (let i = 0; i < n; i++) {
    const st = ST[i]; if (st === Core.OUT) continue;
    if (st === Core.WAIT) groups.wait.push(i);
    else if (st === Core.STAIR) groups.stair.push(i);
    else if (RHO[i] > 2.17) groups.crit.push(i);
    else if (Math.hypot(VX[i], VY[i]) < 0.35 * V0[i] && sim.t - TS[i] > 1) groups.slow.push(i);
    else groups.move.push(i);
  }
  const dot = (list, fill, stroke) => {
    ctx.beginPath();
    for (const i of list) { const q = W2S(X[i], Y[i]), r = Math.max(1.6, R[i] * s * 0.92); ctx.moveTo(q[0] + r, q[1]); ctx.arc(q[0], q[1], r, 0, 6.283); }
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
  };
  dot(groups.wait, colors.surface, colors.wait);
  dot(groups.move, colors.agent);
  dot(groups.slow, colors.warn);
  dot(groups.crit, colors.crit);
  dot(groups.stair, colors.exit);
}

// ------------------------------------------------------------------ loop
let lastT = performance.now();
function frame(now) {
  const dtR = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (sim && playing && !sim.done) {
    let steps = Math.round(dtR * speed / Core.DEF.dt);
    const t0 = performance.now();
    while (steps > 0 && performance.now() - t0 < 22 && !sim.done) { const k = Math.min(steps, 10); sim.step(k); steps -= k; }
    if (sim.done && !done) { done = true; renderResults(true); needHeat = true; }
  }
  draw();
  hud();
  if (now - lastPanel > 300) { lastPanel = now; if (sim && !done) renderResults(false); }
  requestAnimationFrame(frame);
}

function hud() {
  if (!sim) return;
  $("#hudT").textContent = fmt(sim.t);
  const safe = sim.out;
  $("#hudOut").innerHTML = "<b>" + safe + "</b> / " + sim.n + " safe";
  const ph = $("#hudPhase");
  if (sim.done) { ph.textContent = sim.out >= sim.n ? "Floor clear" : "Stopped"; ph.className = "phase move"; }
  else if (sim.t < S.alarm) { ph.textContent = "Alarm in " + fmt(S.alarm - sim.t); ph.className = "phase"; }
  else {
    let moving = 0; for (let i = 0; i < sim.n; i++) if (sim.ST[i] === Core.MOVE) moving++;
    const waiting = sim.n - sim.out - moving - sim.inStair;
    ph.textContent = waiting > 0 ? "Alarm · " + waiting + " still responding" : "Evacuating";
    ph.className = waiting > 0 ? "phase alarm" : "phase move";
  }
}

// ------------------------------------------------------------------ results panel
function hydraulic(summary) {
  // SFPE hydraulic hand calc per exit
  const pre = preCfg();
  let pre99 = 0;
  if (pre.type === "lognormal") pre99 = pre.p99; else if (pre.type === "uniform") pre99 = pre.max; else if (pre.type === "normal") pre99 = pre.mean + 2.33 * pre.sd; else if (pre.type === "fixed") pre99 = pre.fixed;
  let worst = 0;
  env.exits.forEach((E, e) => {
    const Ne = summary.exits[e] ? summary.exits[e].count : 0;
    if (!Ne) return;
    let L = 0; for (const k of env.spawn) { const v = E.pure[k]; if (v < INF && v <= env.pure[k] + 0.01 && v > L) L = v; }
    const d = model.doors[E.door];
    const F = 1.32 * Math.max(0.1, d.width - 0.3);
    const t = Math.max(L / 1.19, Ne / F);
    if (t > worst) worst = t;
  });
  return S.alarm + pre99 + worst;
}
function renderResults(full) {
  if (!sim) return;
  const s = sim.summary();
  const finished = sim.done && sim.out >= sim.n;
  $("#resState").textContent = sim.done ? (finished ? "finished" : "stopped — some people can't reach an exit") : "running · " + fmt(sim.t);
  $("#rTime").textContent = finished ? fmt(s.tClear) : (sim.done ? "—" : fmt(sim.t) + "…");
  // compare with A
  const rc = $("#rCompare");
  if (optA && finished) {
    const d = s.tClear - optA.tClear;
    rc.innerHTML = "<span class='delta " + (d <= 0 ? "good" : "bad") + "'>" + (d <= 0 ? "−" : "+") + Math.abs(Math.round(d)) + " s vs option A (" + fmt(optA.tClear) + ")</span>";
  } else rc.innerHTML = optA ? "<span class='note'>Option A: " + fmt(optA.tClear) + "</span>" : "";
  drawChart();
  // bars
  const seg = (parts) => parts.map(([v, c]) => "<span style='width:" + Math.max(0, v).toFixed(3) + "%;background:" + c + "'></span>").join("");
  const tot = Math.max(1, s.last ? s.last.t : 1);
  if (s.last) {
    const al = Math.min(S.alarm, s.last.pre);
    $("#barLast").innerHTML = seg([[al / tot * 100, colors.crit], [(s.last.pre - al) / tot * 100, colors["ink-3"]], [s.last.travel / tot * 100, colors.exit], [s.last.queue / tot * 100, colors.warn]]);
    const at = Math.max(1, s.pre + s.travel + s.queue), al2 = Math.min(S.alarm, s.pre);
    const scale = (s.pre + s.travel + s.queue) / tot;
    $("#barAvg").innerHTML = seg([[al2 / at * 100 * scale, colors.crit], [(s.pre - al2) / at * 100 * scale, colors["ink-3"]], [s.travel / at * 100 * scale, colors.exit], [s.queue / at * 100 * scale, colors.warn]]);
    $("#barLast").title = "Alarm " + fmt(al) + " · response " + fmt(s.last.pre - al) + " · walking " + fmt(s.last.travel) + " · queuing " + fmt(s.last.queue);
    $("#barAvg").title = "Average: response " + fmt(s.pre) + " · walking " + fmt(s.travel) + " · queuing " + fmt(s.queue);
  } else { $("#barLast").innerHTML = ""; $("#barAvg").innerHTML = ""; }
  // exits
  let h = "<tr><th>Exit</th><th class='num'>People</th><th class='num'>Flow</th><th class='num'>Door cap.</th><th class='num'>Last</th></tr>";
  env.exits.forEach((E, e) => {
    const d = model.doors[E.door], x = s.exits[e];
    h += "<tr><td><button class='nm' style='all:unset;cursor:pointer;font-family:var(--f-mono);font-size:12px;text-decoration:underline;text-decoration-color:var(--line)' data-door='" + E.door + "'>" + esc(d.name) + "</button></td><td class='num'>" + x.count + "</td><td class='num'>" + (x.flow ? x.flow.toFixed(2) : "—") + "</td><td class='num'>" + (1.32 * Math.max(0, d.width - 0.3)).toFixed(2) + "</td><td class='num'>" + fmt(x.last) + "</td></tr>";
  });
  if (!env.exits.length) h += "<tr><td colspan='5' class='note'>No exits — mark a door as an exit.</td></tr>";
  $("#exitTable").innerHTML = h;
  $("#exitTable").querySelectorAll("[data-door]").forEach(b => b.onclick = () => selectDoor(model.doors[+b.dataset.door], true));
  $("#hydro").innerHTML = finished ? "Hand check with the SFPE hydraulic method: <b>" + fmt(hydraulic(s)) + "</b>, simulation <b>" + fmt(s.tClear) + "</b>. Flow and door capacity in persons/s." : "Flow and door capacity in persons/s (door capacity = 1.32 × (width − 0.3 m)).";
}
function drawChart() {
  const c = $("#chart"), r = c.getBoundingClientRect(); if (!r.width) return;
  const d = Math.min(2, devicePixelRatio || 1); c.width = r.width * d; c.height = r.height * d;
  const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height, L = 34, B = 18, T = 6, Rt = 6;
  const cur = sim.curve.concat(sim.done ? [] : [[sim.t, sim.n - sim.out]]);
  let tMax = Math.max(60, sim.t, optA ? optA.curve[optA.curve.length - 1][0] : 0);
  tMax = Math.ceil(tMax / 60) * 60;
  const nMax = Math.max(sim.n, optA ? optA.n : 0, 1);
  const X = t => L + (W - L - Rt) * t / tMax, Y = v => T + (H - T - B) * (1 - v / nMax);
  g.font = "10px " + getComputedStyle(document.body).getPropertyValue("--f-mono"); g.fillStyle = colors["ink-3"]; g.strokeStyle = colors.line; g.lineWidth = 1;
  const step = tMax <= 240 ? 60 : (tMax <= 600 ? 120 : 300);
  g.textAlign = "center"; g.textBaseline = "top";
  for (let t = 0; t <= tMax; t += step) { g.beginPath(); g.moveTo(X(t), T); g.lineTo(X(t), H - B); g.stroke(); g.textAlign = t === 0 ? "left" : (t + step > tMax ? "right" : "center"); g.fillText(fmt(t), X(t), H - B + 4); }
  g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of [0, nMax / 2, nMax]) { g.fillText(Math.round(v), L - 5, Y(v)); }
  g.strokeStyle = colors.crit; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(S.alarm), T); g.lineTo(X(S.alarm), H - B); g.stroke(); g.setLineDash([]);
  const line = (pts, col, w, dash) => { g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))); g.stroke(); g.setLineDash([]); };
  if (optA) line(optA.curve, colors["ink-3"], 1.5, [4, 3]);
  // area under current curve
  g.fillStyle = colors["exit-soft"]; g.beginPath(); cur.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1]))); g.lineTo(X(cur[cur.length - 1][0]), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.fill();
  line(cur, colors.ink, 1.8);
  const lp = cur[cur.length - 1]; g.fillStyle = colors.ink; g.beginPath(); g.arc(X(lp[0]), Y(lp[1]), 3, 0, 7); g.fill();
}

// ------------------------------------------------------------------ exits & selection
function renderExits() {
  const list = model.doors.filter(d => d.isExit || d.score > 0).sort((a, b) => (b.isExit - a.isExit) || (b.score - a.score));
  $("#exitCount").textContent = model.doors.filter(d => d.isExit && !d.blocked).length + " in use · " + model.doors.length + " doors";
  let h = "";
  for (const d of list) {
    const lead = { stair: "into a stair", outside: "to outside", room: "into a room", floor: "into the floor" }[d.leadsTo] || "";
    h += "<div class='exitrow'><input type='checkbox' id='ex-" + d.id + "' data-door='" + d.id + "'" + (d.isExit ? " checked" : "") + " aria-label='Exit " + esc(d.name) + "'>" +
      "<div><button class='nm' data-sel='" + d.id + "'>" + esc(d.name) + "</button> <span class='note'>" + d.width.toFixed(2) + " m · opens " + lead + "</span>" +
      "<div class='why'>" + (d.reasons.length ? esc(d.reasons.join(" · ")) : "added by you") + "</div></div>" +
      (d.blocked ? "<span class='pill fail'>Blocked</span>" : (d.isExit ? "<span class='pill ok'>Exit</span>" : "<span class='pill info'>" + d.score + " pt</span>")) + "</div>";
  }
  if (!list.length) h = "<p class='note'>No door in this drawing carries exit clues. Select a door on the plan and tick “This is an exit”.</p>";
  $("#exitList").innerHTML = h;
  $("#exitList").querySelectorAll("input[data-door]").forEach(cb => cb.onchange = () => { const d = model.doors[+cb.dataset.door]; d.isExit = cb.checked; renderSel(); rebuild(true); });
  $("#exitList").querySelectorAll("[data-sel]").forEach(b => b.onclick = () => selectDoor(model.doors[+b.dataset.sel], true));
}
function selectDoor(d, center) {
  selected = d; renderSel(); needStatic = true;
  if (d && center) {
    const m = doorMid(d), q = W2S(...m);
    if (q[0] < 40 || q[0] > cw - 40 || q[1] < 60 || q[1] > ch - 60) { view.cx = m[0]; view.cy = m[1]; }
  }
}
function renderSel() {
  const box = $("#selCard");
  if (!selected) { box.hidden = true; box.innerHTML = ""; return; }
  const d = selected;
  const lead = { stair: "a stair enclosure", outside: "outside", room: "a room", floor: "the open floor" }[d.leadsTo] || "—";
  const moved = d.orig && (Math.hypot(d.orig.hinge[0] - d.hinge[0], d.orig.hinge[1] - d.hinge[1]) > 0.01 || Math.abs(d.orig.width - d.width) > 0.01);
  box.hidden = false; box.className = "card selcard";
  box.innerHTML =
    "<h2>Door " + esc(d.name) + " <small>" + (d.double ? "double" : "single") + (d.fire ? " · fire door " + esc(d.rating) : "") + (d.added ? " · added" : "") + "</small></h2>" +
    "<p>Opens into " + lead + ". Drag it along its wall on the plan.</p>" +
    "<div class='field'><label for='s-w'>Clear width</label><output id='s-wo'>" + d.width.toFixed(2) + " m</output><input type='range' id='s-w' min='0.6' max='3.0' step='0.05' value='" + d.width + "'></div>" +
    "<label class='check'><input type='checkbox' id='s-exit'" + (d.isExit ? " checked" : "") + "> This is an exit (leads to a protected stair or outside)</label>" +
    "<label class='check'><input type='checkbox' id='s-block'" + (d.blocked ? " checked" : "") + "> Blocked — fire, smoke or locked</label>" +
    (d.isExit ? "<div class='field'><label for='s-sw'>Stair width (code check and stair limit)</label><output id='s-swo'>" + d.stairWidth.toFixed(2) + " m</output><input type='range' id='s-sw' min='0.9' max='2.4' step='0.05' value='" + d.stairWidth + "'></div>" : "") +
    (d.reasons && d.reasons.length ? "<ul class='reasons'>" + d.reasons.map(r => "<li>" + esc(r) + "</li>").join("") + "</ul>" : "") +
    "<div class='row'>" + (d.isExit ? "<button class='btn' id='s-flip'>Flip escape side</button>" : "") + (moved ? "<button class='btn' id='s-reset'>Reset to drawing</button>" : "") + (d.added ? "<button class='btn warn' id='s-del'>Delete door</button>" : "") + "<button class='btn' id='s-close'>Done</button></div>";
  const w = $("#s-w");
  let wt = null;
  w.oninput = () => {
    const v = +w.value;
    if (validPlacement(d, d.hinge, v)) { d.width = v; $("#s-wo").textContent = v.toFixed(2) + " m"; needStatic = true; }
    else { w.value = d.width; $("#s-wo").textContent = d.width.toFixed(2) + " m · wall ends"; }
    clearTimeout(wt); wt = setTimeout(() => rebuild(true), 350);
  };
  $("#s-exit").onchange = e => { d.isExit = e.target.checked; renderSel(); renderExits(); rebuild(true); };
  $("#s-block").onchange = e => { d.blocked = e.target.checked; renderSel(); renderExits(); rebuild(true); };
  if ($("#s-sw")) $("#s-sw").oninput = e => { d.stairWidth = +e.target.value; $("#s-swo").textContent = d.stairWidth.toFixed(2) + " m"; renderChecks(); if (S.stairModel) { clearTimeout(wt); wt = setTimeout(() => rebuild(true), 350); } };
  if ($("#s-flip")) $("#s-flip").onclick = () => { d.n = [-d.n[0], -d.n[1]]; d.band = [-d.band[1], -d.band[0]]; rebuild(true); };
  if ($("#s-reset")) $("#s-reset").onclick = () => { d.hinge = d.orig.hinge.slice(); d.width = d.orig.width; renderSel(); rebuild(true); };
  if ($("#s-del")) $("#s-del").onclick = () => { model.doors.splice(model.doors.indexOf(d), 1); model.doors.forEach((x, i) => x.id = i); selected = null; renderSel(); rebuild(true); };
  $("#s-close").onclick = () => { selectDoor(null); };
}

// ------------------------------------------------------------------ code checks
function renderChecks() {
  if (!env) return;
  const L = S.L, N = S.N;
  const exits = env.exits.map(E => ({ E, d: model.doors[E.door] }));
  let maxT = 0; for (const k of env.spawn) { const v = env.pure[k]; if (v < INF && v > maxT) maxT = v; }
  const caps = exits.map(({ E, d }) => {
    const door = d.width * 1000 / L.level;
    const stair = E.open ? Infinity : d.stairWidth * 1000 / L.stair;
    return Math.floor(Math.min(door, stair));
  });
  const totCap = caps.reduce((a, b) => a + b, 0), maxCap = Math.max(0, ...caps);
  const needExits = N > 1000 ? 4 : (N > 500 ? 3 : 2);
  const diag = Math.hypot(model.bounds[2] - model.bounds[0], model.bounds[3] - model.bounds[1]);
  let sep = 0;
  for (let a = 0; a < exits.length; a++) for (let b = a + 1; b < exits.length; b++) {
    const p = doorMid(exits[a].d), q = doorMid(exits[b].d); sep = Math.max(sep, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  const frac = L.spr ? 1 / 3 : 1 / 2;
  const rows = [
    ["Number of exits", exits.length + " (need " + needExits + " for " + N + " people)", exits.length >= needExits],
    ["Longest travel distance", maxT.toFixed(1) + " m (limit " + L.travel + " m)", maxT <= L.travel],
    ["Exit capacity", totCap + " people (need " + N + ")", totCap >= N],
    ["Losing one exit", exits.length > 1 ? Math.round(100 * (totCap - maxCap) / Math.max(1, totCap)) + "% capacity remains (≥ 50%)" : "only one exit", exits.length > 1 && maxCap <= totCap / 2 + 0.5],
    ["Exit remoteness", exits.length > 1 ? sep.toFixed(1) + " m apart (≥ " + (diag * frac).toFixed(1) + " m)" : "—", exits.length > 1 && sep >= diag * frac],
  ];
  $("#codeTable").innerHTML = "<tr><th>Check</th><th>Result</th><th></th></tr>" + rows.map(r => "<tr><td>" + r[0] + "</td><td style='font-size:12px;color:var(--ink-2)'>" + r[1] + "</td><td>" + (r[2] ? "<span class='pill ok'>Pass</span>" : "<span class='pill fail'>Fail</span>") + "</td></tr>").join("") +
    "<tr><td colspan='3' class='note'>Capacity per exit = min(door width ÷ " + L.level + " mm, stair width ÷ " + L.stair + " mm). Travel distance is measured along the walking route, not as the crow flies. Common path and dead ends are not checked.</td></tr>";
}

// ------------------------------------------------------------------ pre-movement UI
function renderPre() {
  const p = $("#preParams");
  const num = (id, label, val, unit, min, max, step) => "<div class='row'><label class='note' for='" + id + "' style='flex:1'>" + label + "</label><input type='number' id='" + id + "' value='" + val + "' min='" + min + "' max='" + max + "' step='" + step + "'><span class='note'>" + unit + "</span></div>";
  let h = "";
  if (S.pre === "preset") {
    h = "<select id='i-preset' style='width:100%'>" + Object.entries(PRESETS).map(([k, v]) => "<option value='" + k + "'" + (k === S.preset ? " selected" : "") + ">" + v.label + "</option>").join("") + "</select>";
    const v = PRESETS[S.preset];
    h += "<p class='note'>First occupants move after " + (v.p1 * 60) + " s, the last (99th percentile) after " + (v.p99 * 60) + " s from the alarm.</p>";
  } else if (S.pre === "lognormal") h = num("i-p1", "1st percentile", S.p1, "s", 0, 3600, 5) + num("i-p99", "99th percentile", S.p99, "s", 1, 7200, 5);
  else if (S.pre === "uniform") h = num("i-umin", "Earliest", S.uMin, "s", 0, 3600, 5) + num("i-umax", "Latest", S.uMax, "s", 0, 7200, 5);
  else if (S.pre === "normal") h = num("i-nm", "Mean", S.nMean, "s", 0, 3600, 5) + num("i-nsd", "Std. deviation", S.nSd, "s", 0, 1800, 1);
  else if (S.pre === "fixed") h = num("i-fx", "Delay", S.fixed, "s", 0, 3600, 5);
  p.innerHTML = h;
  const bind = (id, key) => { const el = $("#" + id); if (el) el.onchange = () => { S[key] = Math.max(0, +el.value || 0); renderPre(); restart(true); }; };
  if ($("#i-preset")) $("#i-preset").onchange = e => { S.preset = e.target.value; renderPre(); restart(true); };
  bind("i-p1", "p1"); bind("i-p99", "p99"); bind("i-umin", "uMin"); bind("i-umax", "uMax"); bind("i-nm", "nMean"); bind("i-nsd", "nSd"); bind("i-fx", "fixed");
  $("#preNote").textContent = S.pre === "preset" ? "PD 7974-6 tabulates the 1st and 99th percentile response; the app fits a log-normal through them. Check the edition you design to." : "Each person draws their own response time; the alarm delay is added on top.";
  drawPreChart();
}
function drawPreChart() {
  const c = $("#preChart"), r = c.getBoundingClientRect(); if (!r.width) return;
  const d = Math.min(2, devicePixelRatio || 1); c.width = r.width * d; c.height = r.height * d;
  const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height, B = 14;
  const smp = Core.preSampler(preCfg(), Core.rng(5)), vals = [];
  for (let i = 0; i < 4000; i++) vals.push(S.alarm + smp());
  let mx = 0; for (const v of vals) mx = Math.max(mx, v);
  mx = Math.max(60, Math.ceil(mx / 30) * 30);
  const bins = new Array(40).fill(0); for (const v of vals) bins[Math.min(39, Math.floor(v / mx * 40))]++;
  const bm = Math.max(...bins, 1);
  g.fillStyle = colors["ink-3"];
  bins.forEach((b, i) => { const h = (H - B - 4) * b / bm; g.fillRect(i * W / 40 + 0.5, H - B - h, W / 40 - 1, h); });
  g.fillStyle = colors.crit; g.fillRect(S.alarm / mx * W - 1, 0, 2, H - B);
  g.font = "10px " + getComputedStyle(document.body).getPropertyValue("--f-mono"); g.fillStyle = colors["ink-3"]; g.textBaseline = "top";
  g.textAlign = "left"; g.fillText("0:00", 0, H - B + 2); g.textAlign = "right"; g.fillText(fmt(mx), W, H - B + 2);
  g.textAlign = "center"; g.fillText("starts moving", W / 2, H - B + 2);
}

// ------------------------------------------------------------------ Monte Carlo + tests (Web Worker)
let worker = null;
function getWorker() {
  if (worker) return worker;
  const src = SIM_CORE.toString() + "\n" + TEST_SCENES.toString() + "\nconst Core = SIM_CORE(), Tests = TEST_SCENES();\n" +
    "onmessage = function (ev) { const m = ev.data;\n" +
    " if (m.cmd === 'mc') { for (let r = 0; r < m.runs; r++) { const sim = Core.createSim(m.env, Object.assign({}, m.cfg, { seed: 1000 + r * 7919 })); while (!sim.done) sim.step(200); const s = sim.summary(); postMessage({ type: 'mc', i: r, tClear: s.tClear, n: sim.n, out: sim.out }); } postMessage({ type: 'mcDone' }); }\n" +
    " if (m.cmd === 'tests') { for (const id of ['imo1', 'imo4', 'imo6']) postMessage({ type: 'test', r: Tests.runTest(Core, id) }); const rows = {}; for (const seed of [7, 11, 13]) { const s = Tests.runTest(Core, 'sweep', { seed, widths: [0.8, 1.0, 1.2, 1.6, 2.0, 2.4] }); for (const x of s.rows) { rows[x.w] = rows[x.w] || []; rows[x.w].push(x.flow); } postMessage({ type: 'sweepProg', seed }); } postMessage({ type: 'sweep', rows }); }\n" +
    "};";
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  return worker;
}
function envForWorker() {
  return {
    g: { x0: env.g.x0, y0: env.g.y0, nx: env.g.nx, ny: env.g.ny, cs: env.g.cs, obst: env.g.obst },
    edt: env.edt, near: env.near, zone: env.zone, pure: env.pure, spawn: env.spawn, seats: env.seats,
    exits: env.exits.map(E => ({ field: E.field, fx: E.fx, fy: E.fy, sx: E.sx, sy: E.sy, descent: E.descent, width: model.doors[E.door].width, stairWidth: model.doors[E.door].stairWidth, open: E.open, name: E.name })),
  };
}
let mcBusy = false;
$("#b-mc").onclick = () => {
  if (mcBusy || !env || !env.exits.length) return;
  mcBusy = true; const runs = +$("#i-runs").value, res = [];
  $("#b-mc").disabled = true; $("#mcOut").textContent = "Running 0 / " + runs + "…"; $("#mcProg").style.width = "0";
  const w = getWorker();
  w.onmessage = ev => {
    const m = ev.data;
    if (m.type === "mc") { res.push(m); $("#mcProg").style.width = (100 * res.length / runs) + "%"; $("#mcOut").textContent = "Running " + res.length + " / " + runs + "…"; }
    if (m.type === "mcDone") {
      mcBusy = false; $("#b-mc").disabled = false;
      const ok = res.filter(r => r.tClear > 0).map(r => r.tClear).sort((a, b) => a - b);
      if (!ok.length) { $("#mcOut").textContent = "No run cleared the floor."; return; }
      const q = p => ok[Math.min(ok.length - 1, Math.floor(p * (ok.length - 1) + 0.5))];
      $("#mcOut").innerHTML = "<div class='big'><span class='v' style='font-size:32px'>" + fmt(q(0.5)) + "</span><span class='l'>median of " + ok.length + " runs</span></div>" +
        "<table><tr><td>95th percentile</td><td class='num'>" + fmt(q(0.95)) + "</td></tr><tr><td>Fastest – slowest</td><td class='num'>" + fmt(ok[0]) + " – " + fmt(ok[ok.length - 1]) + "</td></tr>" +
        (res.length > ok.length ? "<tr><td colspan='2' class='note'>" + (res.length - ok.length) + " runs did not finish.</td></tr>" : "") + "</table>";
      drawMC(ok);
    }
  };
  w.postMessage({ cmd: "mc", env: envForWorker(), cfg: simCfg(), runs });
};
function drawMC(vals) {
  const c = $("#mcChart"); c.hidden = false;
  const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); c.width = r.width * d; c.height = r.height * d;
  const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height, B = 16, lo = Math.floor(vals[0] / 30) * 30 - 30, hi = Math.ceil(vals[vals.length - 1] / 30) * 30 + 30;
  const X = t => 6 + (W - 12) * (t - lo) / (hi - lo);
  g.strokeStyle = colors.line; g.beginPath(); g.moveTo(0, H - B); g.lineTo(W, H - B); g.stroke();
  const stack = {};
  for (const v of vals) { const k = Math.round(X(v) / 7); stack[k] = (stack[k] || 0) + 1; g.fillStyle = colors.exit; g.beginPath(); g.arc(k * 7, H - B - 5 - (stack[k] - 1) * 7, 3, 0, 7); g.fill(); }
  g.font = "10px " + getComputedStyle(document.body).getPropertyValue("--f-mono"); g.fillStyle = colors["ink-3"]; g.textBaseline = "top";
  g.textAlign = "left"; g.fillText(fmt(lo), 2, H - B + 3); g.textAlign = "right"; g.fillText(fmt(hi), W - 2, H - B + 3);
  if (optA) { g.strokeStyle = colors["ink-3"]; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(optA.tClear), 0); g.lineTo(X(optA.tClear), H - B); g.stroke(); g.setLineDash([]); }
}
$("#b-tests").onclick = () => {
  $("#b-tests").disabled = true; $("#testState").textContent = "Running IMO tests…"; $("#testCards").innerHTML = "";
  const w = getWorker();
  w.onmessage = ev => {
    const m = ev.data;
    if (m.type === "test") {
      const r = m.r, el = document.createElement("div"); el.className = "card";
      el.innerHTML = "<h2>" + esc(r.label) + "</h2><div class='v'>" + esc(r.value) + "</div><p>Expected: " + esc(r.expected) + "</p><div>" + (r.pass ? "<span class='pill ok'>Pass</span>" : "<span class='pill fail'>Fail</span>") + "</div>";
      $("#testCards").appendChild(el);
    }
    if (m.type === "sweepProg") $("#testState").textContent = "Door sweep, seed " + m.seed + " done…";
    if (m.type === "sweep") { $("#b-tests").disabled = false; $("#testState").textContent = "Done. Same engine and parameters as the Studio."; drawSweep(m.rows); }
  };
  w.postMessage({ cmd: "tests" });
};
function drawSweep(rows) {
  const ws = Object.keys(rows).map(Number).sort((a, b) => a - b), mean = w => rows[w].reduce((a, b) => a + b, 0) / rows[w].length;
  let h = "<tr><th>Door width</th><th class='num'>Engine (p/s)</th><th class='num'>SFPE (p/s)</th><th class='num'>Specific flow (p/s/m)</th></tr>";
  for (const w of ws) h += "<tr><td>" + w.toFixed(1) + " m</td><td class='num'>" + mean(w).toFixed(2) + "</td><td class='num'>" + (1.32 * (w - 0.3)).toFixed(2) + "</td><td class='num'>" + (mean(w) / w).toFixed(2) + "</td></tr>";
  $("#sweepTable").innerHTML = h;
  const c = $("#sweepChart"), r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); c.width = r.width * d; c.height = r.height * d;
  const g = c.getContext("2d"); g.setTransform(d, 0, 0, d, 0, 0);
  const W = r.width, H = r.height, L = 40, B = 28, T = 10, R = 10, xMax = 2.6, yMax = 4.5;
  const X = w => L + (W - L - R) * w / xMax, Y = f => T + (H - T - B) * (1 - f / yMax);
  g.font = "11px " + getComputedStyle(document.body).getPropertyValue("--f-mono"); g.fillStyle = colors["ink-3"]; g.strokeStyle = colors.line;
  for (let f = 0; f <= 4; f++) { g.beginPath(); g.moveTo(L, Y(f)); g.lineTo(W - R, Y(f)); g.stroke(); g.textAlign = "right"; g.textBaseline = "middle"; g.fillText(f + " p/s", L - 4, Y(f)); }
  for (let w = 0; w <= 2.5; w += 0.5) { g.textAlign = "center"; g.textBaseline = "top"; g.fillText(w.toFixed(1) + " m", X(w), H - B + 6); }
  g.strokeStyle = colors["ink-3"]; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(X(0.3), Y(0)); g.lineTo(X(xMax), Y(1.32 * (xMax - 0.3))); g.stroke(); g.setLineDash([]);
  g.strokeStyle = colors.warn; g.beginPath(); g.moveTo(X(0.9), Y(1.33)); g.lineTo(X(1.1), Y(1.33)); g.lineWidth = 3; g.stroke();
  g.strokeStyle = colors.exit; g.lineWidth = 2; g.beginPath(); ws.forEach((w, i) => i ? g.lineTo(X(w), Y(mean(w))) : g.moveTo(X(w), Y(mean(w)))); g.stroke();
  for (const w of ws) { g.fillStyle = colors.exit; g.beginPath(); g.arc(X(w), Y(mean(w)), 4, 0, 7); g.fill(); for (const f of rows[w]) { g.globalAlpha = 0.35; g.beginPath(); g.arc(X(w), Y(f), 2.5, 0, 7); g.fill(); g.globalAlpha = 1; } }
}

// ------------------------------------------------------------------ interaction
const ptrs = new Map();
let drag = null;
function hitDoor(w) {
  let best = null, bd = 0.7;
  for (const d of model.doors) {
    const rel = [w[0] - d.hinge[0], w[1] - d.hinge[1]];
    const s = rel[0] * d.u[0] + rel[1] * d.u[1], t = rel[0] * d.n[0] + rel[1] * d.n[1];
    const ds = s < 0 ? -s : (s > d.width ? s - d.width : 0);
    const dist = Math.hypot(ds, Math.max(0, Math.abs(t - 0) - 0.25));
    if (dist < bd && t > -0.9 && t < d.width + 0.2) { bd = dist; best = d; }
  }
  return best;
}
function addDoorAt(w) {
  // nearest wall cell within 0.6 m
  let p = null, bd = 1e9;
  for (let dy = -0.6; dy <= 0.6; dy += 0.05) for (let dx = -0.6; dx <= 0.6; dx += 0.05) if (isWall(w[0] + dx, w[1] + dy)) { const dd = Math.hypot(dx, dy); if (dd < bd) { bd = dd; p = [w[0] + dx, w[1] + dy]; } }
  if (!p) { toast("Click on a wall to add a door."); return; }
  const run = (ux, uy) => { let a = 0, b = 0; while (a < 4 && isWall(p[0] - ux * (a + 0.05), p[1] - uy * (a + 0.05))) a += 0.05; while (b < 4 && isWall(p[0] + ux * (b + 0.05), p[1] + uy * (b + 0.05))) b += 0.05; return [a, b]; };
  const hx = run(1, 0), hy = run(0, 1);
  const horiz = hx[0] + hx[1] >= hy[0] + hy[1];
  const u = horiz ? [1, 0] : [0, 1], n = horiz ? [0, 1] : [-1, 0];
  const th = run(n[0], n[1]); // thickness extents across the wall
  const c = [p[0] + n[0] * (th[1] - th[0]) / 2, p[1] + n[1] * (th[1] - th[0]) / 2];
  const width = 1.0;
  const d = { hinge: [c[0] - u[0] * width / 2, c[1] - u[1] * width / 2], u, n, width, band: [-(th[0] + th[1]) / 2 - 0.03, (th[0] + th[1]) / 2 + 0.03], orig: null, blocked: false, isExit: false, reasons: [], score: 0, leadsTo: "", fire: false, rating: "", double: false, added: true, stairWidth: 1.2 };
  if (!validPlacement(d, d.hinge, width)) { toast("No room for a 1 m door there — try the middle of a wall."); return; }
  d.name = "N" + String(model.doors.filter(x => x.added).length + 1).padStart(2, "0");
  model.doors.push(d); model.doors.forEach((x, i) => x.id = i);
  selectDoor(d); renderExits(); rebuild(true);
  setTool("select");
}
cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; drag = { pinch: true, d0: Math.hypot(a[0] - b[0], a[1] - b[1]), s0: view.s }; return; }
  if (!model) return;
  const w = S2W(e.offsetX, e.offsetY);
  if (tool === "door") { addDoorAt(w); return; }
  if (tool === "select") {
    const d = hitDoor(w);
    if (d) { selectDoor(d); drag = { door: d, w0: w, h0: d.hinge.slice(), moved: false }; cv.style.cursor = "grabbing"; return; }
  }
  drag = { pan: true, x: e.offsetX, y: e.offsetY, cx: view.cx, cy: view.cy, click: tool === "select" };
});
cv.addEventListener("pointermove", e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (!drag) {
    if (model && tool === "select") cv.style.cursor = hitDoor(S2W(e.offsetX, e.offsetY)) ? "grab" : "default";
    else cv.style.cursor = tool === "door" ? "crosshair" : "grab";
    return;
  }
  if (drag.pinch && ptrs.size === 2) { const [a, b] = [...ptrs.values()]; view.s = Math.max(3, Math.min(200, drag.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / drag.d0)); needStatic = true; return; }
  if (drag.pan) {
    view.cx = drag.cx - (e.offsetX - drag.x) / view.s; view.cy = drag.cy + (e.offsetY - drag.y) / view.s;
    if (Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 4) drag.click = false;
    needStatic = true; return;
  }
  if (drag.door) {
    const w = S2W(e.offsetX, e.offsetY), d = drag.door;
    const ds = (w[0] - drag.w0[0]) * d.u[0] + (w[1] - drag.w0[1]) * d.u[1];
    const snap = Math.round(ds / 0.05) * 0.05;
    const cand = [drag.h0[0] + d.u[0] * snap, drag.h0[1] + d.u[1] * snap];
    if (validPlacement(d, cand, d.width)) { d.hinge = cand; drag.moved = true; needStatic = true; }
  }
});
function endPtr(e) {
  ptrs.delete(e.pointerId);
  if (!drag) return;
  if (drag.door && drag.moved) { renderSel(); rebuild(true); }
  if (drag.pan && drag.click) selectDoor(null);
  drag = null; cv.style.cursor = "default";
}
cv.addEventListener("pointerup", endPtr);
cv.addEventListener("pointercancel", endPtr);
cv.addEventListener("wheel", e => {
  e.preventDefault();
  const before = S2W(e.offsetX, e.offsetY);
  view.s = Math.max(3, Math.min(200, view.s * Math.exp(-e.deltaY * 0.0015)));
  const after = S2W(e.offsetX, e.offsetY);
  view.cx += before[0] - after[0]; view.cy += before[1] - after[1];
  needStatic = true;
}, { passive: false });

function setTool(t) {
  tool = t;
  for (const [id, v] of [["#t-select", "select"], ["#t-door", "door"], ["#t-pan", "pan"]]) $(id).setAttribute("aria-pressed", String(tool === v));
  $("#hudHint").textContent = t === "door" ? "Click on a wall to cut a new 1 m door" : (t === "pan" ? "Drag to pan · scroll to zoom" : "Drag a door along its wall · scroll to zoom");
}
$("#t-select").onclick = () => setTool("select");
$("#t-door").onclick = () => setTool("door");
$("#t-pan").onclick = () => setTool("pan");
$("#t-fit").onclick = fit;
$("#t-import").onclick = () => $("#file").click();
$("#t-sample").onclick = () => loadText(document.getElementById("sample-dxf").textContent, "Sample_Office_Level03.dxf", true);
$("#file").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), f.name, false);
  r.onerror = () => toast("Could not read the file.");
  r.readAsText(f); e.target.value = "";
};
document.addEventListener("keydown", e => {
  if (e.target.closest("input, select, textarea") || !$("#modal").hidden) { if (e.key === "Escape") $("#modal").hidden = true; return; }
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "v" || e.key === "V") setTool("select");
  else if (e.key === "d" || e.key === "D") setTool("door");
  else if (e.key === "h" || e.key === "H") setTool("pan");
  else if (e.key === "f" || e.key === "F") fit();
  else if (e.key === "r" || e.key === "R") restart(false);
  else if (e.key === "Escape") selectDoor(null);
});
function togglePlay() {
  if (sim && sim.done) { restart(true); playing = true; }
  else playing = !playing;
  $("#l-play").textContent = playing ? "Pause" : "Play";
  $("#i-play").innerHTML = playing ? "<path d='M4 2.5h3v11H4zM9 2.5h3v11H9z' fill='currentColor'/>" : "<path d='M4 2.5v11l9-5.5z' fill='currentColor'/>";
}
$("#b-play").onclick = togglePlay;
$("#b-restart").onclick = () => { restart(false); if (!playing) togglePlay(); };
$("#speedSeg").querySelectorAll("button").forEach(b => b.onclick = () => { speed = +b.dataset.speed; $("#speedSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
$("#heatSeg").querySelectorAll("button").forEach(b => b.onclick = () => { heatMode = b.dataset.heat; $("#heatSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); needHeat = true; renderLegend(); });
function renderLegend() {
  const ag = "<span><i style='background:" + colors.surface + ";border:1.5px solid " + colors.wait + "'></i>responding</span><span><i style='background:" + colors.agent + "'></i>walking</span><span><i style='background:" + colors.warn + "'></i>queuing</span><span><i style='background:" + colors.crit + "'></i>&gt; 2.2 p/m²</span>";
  let h = ag;
  if (heatMode === "peak") h += "<span class='los' title='Fruin Level of Service, walkways'>" + LOS.slice(2).map(L => "<span style='background:rgb(" + L[2].join(",") + ")'>" + L[1] + "</span>").join("") + "</span><span>Fruin LOS (peak)</span>";
  if (heatMode === "cong") h += "<span class='los'><span style='background:rgb(240,180,40);width:30px'></span><span style='background:rgb(190,30,40);width:30px'></span></span><span>s above 1.08 p/m²</span>";
  $("#legend").innerHTML = h;
}
$("#b-saveA").onclick = () => {
  if (!sim || !sim.done || sim.out < sim.n) { toast("Let the run finish first, then save it as option A."); return; }
  const s = sim.summary(); optA = { tClear: s.tClear, curve: sim.curve.slice(), n: sim.n };
  $("#b-clearA").hidden = false; $("#kA").hidden = false; renderResults(true);
  toast("Saved as option A. Now change the design — the new run is compared against it.");
};
$("#b-clearA").onclick = () => { optA = null; $("#b-clearA").hidden = true; $("#kA").hidden = true; renderResults(true); };

// settings bindings
function bindRange(id, out, key, f, after) {
  const el = $(id); el.value = S[key];
  const upd = () => { $(out).textContent = f(+el.value); };
  el.oninput = () => { S[key] = +el.value; upd(); if (after) after(true); };
  el.onchange = () => { S[key] = +el.value; upd(); if (after) after(false); };
  upd();
}
let rt = null;
const debRestart = live => { clearTimeout(rt); rt = setTimeout(() => { renderChecks(); restart(true); }, live ? 400 : 0); };
bindRange("#i-N", "#o-N", "N", v => v + " people", debRestart);
bindRange("#i-v", "#o-v", "vMean", v => v.toFixed(2) + " m/s", debRestart);
bindRange("#i-alarm", "#o-alarm", "alarm", v => v + " s", live => { drawPreChart(); debRestart(live); });
function renderNPresets() {
  const seats = model ? model.seats.length : 0;
  const area = model ? (model.bounds[2] - model.bounds[0]) * (model.bounds[3] - model.bounds[1]) : 0;
  const opts = [];
  if (seats) opts.push(["Workstations", seats]);
  if (area) opts.push(["Code load ÷9.3 m²", Math.round(area / 9.3)]);
  opts.push(["Busy day", Math.round((seats || area / 9.3) * 2 / 10) * 10]);
  $("#nPresets").innerHTML = opts.map(([l, v]) => "<button class='btn' data-n='" + v + "'>" + l + " · " + v + "</button>").join("");
  $("#nPresets").querySelectorAll("button").forEach(b => b.onclick = () => { S.N = Math.min(1000, Math.max(20, +b.dataset.n)); $("#i-N").value = S.N; $("#o-N").textContent = S.N + " people"; renderChecks(); restart(true); });
}
$("#i-seats").onchange = e => { S.useSeats = e.target.checked; restart(true); };
$("#i-pre").onchange = e => { S.pre = e.target.value; renderPre(); restart(true); };
$("#i-choice").onchange = e => { S.exitChoice = e.target.value; restart(true); };
$("#i-furn").onchange = e => { S.furniture = e.target.checked; rebuild(true); };
$("#i-stair").onchange = e => { S.stairModel = e.target.checked; restart(true); };
for (const [id, key] of [["#L-travel", "travel"], ["#L-stair", "stair"], ["#L-level", "level"]]) $(id).onchange = e => { S.L[key] = Math.max(0.1, +e.target.value || S.L[key]); renderChecks(); };
$("#L-spr").onchange = e => { S.L.spr = e.target.checked; renderChecks(); };

// tabs
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
  for (const t of ["studio", "how", "cal"]) $("#tab-" + t).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === "studio") { resize(); }
  if (b.dataset.tab === "cal" && !$("#testCards").children.length) $("#b-tests").click();
});

// misc
let toastT = null;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4200); }
function busy(on) { $("#busy").hidden = !on; }
const mq = matchMedia("(prefers-color-scheme: dark)");
(mq.addEventListener ? mq.addEventListener("change", () => { readColors(); if (env) buildZoneImage(); renderLegend(); }) : null);
new MutationObserver(() => { readColors(); if (env) buildZoneImage(); renderLegend(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// handle for power users / testing
window.evacuationFlow = { get model() { return model; }, get view() { return view; }, get sim() { return sim; }, W2S: (x, y) => W2S(x, y), rebuild: () => rebuild(true) };

// boot
readColors();
resize();
renderPre();
renderLegend();
togglePlay(); togglePlay(); // sync button label
loadText(document.getElementById("sample-dxf").textContent, "Sample_Office_Level03.dxf", true);
requestAnimationFrame(frame);
})();
