// DXF import: parse -> flatten blocks -> classify by layer role -> model (metres) -> exit detection.
function DXF_IMPORT(core) {
  "use strict";
  const ROLES = ["wall", "door", "firedoor", "stair", "exit", "furniture", "obstacle", "ignore"];
  const ROLE_LABEL = { wall: "Wall / partition", door: "Door", firedoor: "Fire door", stair: "Stair", exit: "Exit signage", furniture: "Furniture", obstacle: "Fixed obstacle", ignore: "Ignore" };

  function guessRole(name) {
    const n = name.toUpperCase();
    if (/PATT|HATCH|DEFPOINTS/.test(n)) return "ignore";
    if (/DOOR|\bDR\b/.test(n)) return /FIRE|FD/.test(n) ? "firedoor" : "door";
    if (/STAIR|STAIRS|STR\b/.test(n)) return "stair";
    if (/EXIT|ESCAPE|EGRESS|EVAC/.test(n)) return "exit";
    if (/WALL|PARTITION|GLAZ|CURT|COLS|COLUMN|S-COL|STRUCT/.test(n)) return "wall";
    if (/FURN|FF&E|DESK|CHAIR|TABLE|WKSTN/.test(n)) return "furniture";
    if (/LIFT|ELEV|SHAFT|FIXT|SANIT|PLUMB|EQPM|EQUIP/.test(n)) return "obstacle";
    return "ignore";
  }

  // ------------------------------------------------------------ tokeniser / parser
  function parse(text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].replace(/\s+$/, "")]);
    const out = { insunits: 0, layers: {}, blocks: {}, entities: [] };
    let i = 0;
    function readEntities(stopAt) {
      const ents = [];
      let cur = null;
      while (i < pairs.length) {
        const [c, v] = pairs[i];
        if (c === 0) {
          if (stopAt.includes(v)) break;
          if (cur) ents.push(cur);
          cur = { type: v, g: [] };
          i++; continue;
        }
        if (cur) cur.g.push([c, v]);
        i++;
      }
      if (cur) ents.push(cur);
      return ents;
    }
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 0 && v === "SECTION") {
        const name = pairs[i + 1][1]; i += 2;
        if (name === "HEADER") {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
            if (pairs[i][0] === 9 && pairs[i][1] === "$INSUNITS") out.insunits = parseInt(pairs[i + 1][1], 10);
            i++;
          }
        } else if (name === "TABLES") {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
            if (pairs[i][0] === 0 && pairs[i][1] === "LAYER") {
              let j = i + 1, nm = null, col = 7, off = false;
              while (j < pairs.length && pairs[j][0] !== 0) { if (pairs[j][0] === 2) nm = pairs[j][1]; if (pairs[j][0] === 62) { col = Math.abs(parseInt(pairs[j][1], 10)); off = parseInt(pairs[j][1], 10) < 0; } j++; }
              if (nm) out.layers[nm] = { name: nm, color: col, off };
            }
            i++;
          }
        } else if (name === "BLOCKS") {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) {
            if (pairs[i][0] === 0 && pairs[i][1] === "BLOCK") {
              i++;
              let nm = null, bx = 0, by = 0, flags = 0;
              while (i < pairs.length && pairs[i][0] !== 0) { const [cc, vv] = pairs[i]; if (cc === 2) nm = vv; if (cc === 10) bx = +vv; if (cc === 20) by = +vv; if (cc === 70) flags = +vv; i++; }
              const ents = readEntities(["ENDBLK"]);
              if (nm) out.blocks[nm] = { name: nm, base: [bx, by], ents, flags };
            } else i++;
          }
        } else if (name === "ENTITIES") {
          out.entities = readEntities(["ENDSEC"]);
        } else {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === "ENDSEC")) i++;
        }
      }
      i++;
    }
    return out;
  }
  function gv(e, code, def) { for (const [c, v] of e.g) if (c === code) return v; return def; }
  function gn(e, code, def) { const v = gv(e, code, null); return v == null ? def : parseFloat(v); }

  // ------------------------------------------------------------ affine 2D
  function mat(a, b, c, d, e, f) { return [a, b, c, d, e, f]; } // x' = a x + c y + e ; y' = b x + d y + f
  function mul(m, n) { return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; }
  function ap(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
  const ID = mat(1, 0, 0, 1, 0, 0);

  // ------------------------------------------------------------ flatten into world primitives
  function flatten(P) {
    const prims = [], inserts = [];
    let insCounter = 0;
    function arcPts(cx, cy, r, a0, a1) {
      while (a1 <= a0) a1 += 360;
      const n = Math.max(6, Math.ceil((a1 - a0) / 7.5)), pts = [];
      for (let k = 0; k <= n; k++) { const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
      return pts;
    }
    function walk(ents, M, inhLayer, top, depth) {
      let k = 0;
      while (k < ents.length) {
        const e = ents[k];
        let layer = gv(e, 8, "0"); if (layer === "0" && inhLayer) layer = inhLayer;
        const base = { layer, ins: top ? top.id : -1 };
        switch (e.type) {
          case "LINE": prims.push(Object.assign({ kind: "line", pts: [ap(M, [gn(e, 10, 0), gn(e, 20, 0)]), ap(M, [gn(e, 11, 0), gn(e, 21, 0)])] }, base)); break;
          case "LWPOLYLINE": {
            const pts = []; let x = null;
            for (const [c, v] of e.g) { if (c === 10) x = +v; if (c === 20 && x != null) { pts.push(ap(M, [x, +v])); x = null; } }
            const closed = (gn(e, 70, 0) & 1) === 1;
            if (pts.length > 1) prims.push(Object.assign({ kind: "poly", pts, closed }, base));
            break;
          }
          case "POLYLINE": {
            const closed = (gn(e, 70, 0) & 1) === 1, pts = [];
            k++;
            while (k < ents.length && ents[k].type === "VERTEX") { pts.push(ap(M, [gn(ents[k], 10, 0), gn(ents[k], 20, 0)])); k++; }
            if (pts.length > 1) prims.push(Object.assign({ kind: "poly", pts, closed }, base));
            continue; // SEQEND consumed by default branch next loop
          }
          case "SOLID": {
            const p = [[10, 20], [11, 21], [13, 23], [12, 22]].map(([a, b]) => ap(M, [gn(e, a, 0), gn(e, b, 0)]));
            prims.push(Object.assign({ kind: "poly", pts: p, closed: true }, base)); break;
          }
          case "CIRCLE": {
            const c = [gn(e, 10, 0), gn(e, 20, 0)], r = gn(e, 40, 0);
            const pts = arcPts(c[0], c[1], r, 0, 360).map(p => ap(M, p));
            const wc = ap(M, c), sc = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
            prims.push(Object.assign({ kind: "circle", pts, closed: true, c: wc, r: r * sc }, base)); break;
          }
          case "ARC": {
            const c = [gn(e, 10, 0), gn(e, 20, 0)], r = gn(e, 40, 0), a0 = gn(e, 50, 0), a1 = gn(e, 51, 0);
            const loc = arcPts(c[0], c[1], r, a0, a1);
            const pts = loc.map(p => ap(M, p)), sc = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
            prims.push(Object.assign({ kind: "arc", pts, c: ap(M, c), r: r * sc, p0: pts[0], p1: pts[pts.length - 1] }, base)); break;
          }
          case "ELLIPSE": {
            const c = [gn(e, 10, 0), gn(e, 20, 0)], mj = [gn(e, 11, 1), gn(e, 21, 0)], ra = gn(e, 40, 1);
            let t0 = gn(e, 41, 0), t1 = gn(e, 42, 2 * Math.PI); while (t1 <= t0) t1 += 2 * Math.PI;
            const mn = [-mj[1] * ra, mj[0] * ra], pts = [], n = 36;
            for (let q = 0; q <= n; q++) { const t = t0 + (t1 - t0) * q / n; pts.push(ap(M, [c[0] + mj[0] * Math.cos(t) + mn[0] * Math.sin(t), c[1] + mj[1] * Math.cos(t) + mn[1] * Math.sin(t)])); }
            prims.push(Object.assign({ kind: "poly", pts, closed: Math.abs(t1 - t0 - 2 * Math.PI) < 1e-3 }, base)); break;
          }
          case "TEXT": case "MTEXT": case "ATTRIB": {
            if (e.type === "ATTRIB" && (gn(e, 70, 0) & 1)) break; // invisible
            let s = gv(e, 1, "");
            if (e.type === "MTEXT") { let pre = ""; for (const [c, v] of e.g) if (c === 3) pre += v; s = (pre + s).replace(/\\P/g, " ").replace(/\\[A-Za-z][^;]*;/g, "").replace(/[{}]/g, ""); }
            let p = [gn(e, 10, 0), gn(e, 20, 0)];
            const h72 = gn(e, 72, 0), v73 = gn(e, 73, 0);
            if (e.type !== "MTEXT" && (h72 || v73)) p = [gn(e, 11, p[0]), gn(e, 21, p[1])];
            const sc = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
            const rot = gn(e, 50, 0) + Math.atan2(M[1], M[0]) * 180 / Math.PI;
            const align = e.type === "MTEXT" ? "mtext" : (h72 === 1 || h72 === 4 ? "center" : (h72 === 2 ? "right" : "left"));
            const valign = e.type === "MTEXT" ? "top" : (v73 === 2 || h72 === 4 ? "middle" : (v73 === 3 ? "top" : "baseline"));
            if (s.trim()) prims.push(Object.assign({ kind: "text", p: ap(M, p), h: gn(e, 40, 1) * sc, text: s, rot, align, valign }, base));
            break;
          }
          case "INSERT": {
            const bn = gv(e, 2, ""), B = P.blocks[bn];
            const ip = [gn(e, 10, 0), gn(e, 20, 0)], sx = gn(e, 41, 1), sy = gn(e, 42, 1), rot = gn(e, 50, 0) * Math.PI / 180;
            const attribs = {};
            if (gn(e, 66, 0) === 1) {
              k++;
              while (k < ents.length && ents[k].type === "ATTRIB") { attribs[gv(ents[k], 2, "")] = gv(ents[k], 1, ""); k++; }
            }
            if (B && depth < 8 && !bn.startsWith("*D") && !bn.startsWith("*d")) {
              const cs = Math.cos(rot), sn = Math.sin(rot);
              const L = mul(mat(cs, sn, -sn, cs, ip[0], ip[1]), mul(mat(sx, 0, 0, sy, 0, 0), mat(1, 0, 0, 1, -B.base[0], -B.base[1])));
              const W = mul(M, L);
              let t = top;
              if (!top) { t = { id: insCounter++, name: bn, layer, attribs, at: ap(M, ip), M: W }; inserts.push(t); }
              walk(B.ents, W, layer, t, depth + 1);
            }
            if (gn(e, 66, 0) === 1) continue;
            break;
          }
          default: break;
        }
        k++;
      }
    }
    walk(P.entities, ID, null, null, 0);
    return { prims, inserts };
  }

  function unitScale(P, prims) {
    const u = P.insunits;
    const map = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 };
    if (map[u]) return { s: map[u], how: "from $INSUNITS" };
    let xa = 1e18, xb = -1e18;
    for (const p of prims) for (const q of (p.pts || [])) { xa = Math.min(xa, q[0]); xb = Math.max(xb, q[0]); }
    const w = xb - xa;
    if (w > 2000) return { s: 0.001, how: "guessed: millimetres (drawing extent)" };
    if (w > 300) return { s: 0.01, how: "guessed: centimetres (drawing extent)" };
    return { s: 1, how: "guessed: metres (drawing extent)" };
  }

  // ------------------------------------------------------------ build model
  function buildModel(P, roles, prev) {
    const F = flatten(P);
    const U = unitScale(P, F.prims);
    const S = U.s;
    const sc = p => [p[0] * S, p[1] * S];
    for (const p of F.prims) {
      if (p.pts) p.pts = p.pts.map(sc);
      if (p.c) p.c = sc(p.c); if (p.r) p.r *= S; if (p.p0) { p.p0 = sc(p.p0); p.p1 = sc(p.p1); }
      if (p.p) p.p = sc(p.p); if (p.h) p.h *= S;
    }
    for (const t of F.inserts) t.at = sc(t.at);
    const roleOf = l => roles[l] || "ignore";
    const insRole = {};
    for (const t of F.inserts) {
      let r = roleOf(t.layer);
      if (r !== "door" && r !== "firedoor" && /DOOR/i.test(t.name)) r = /FIRE|FD/i.test(t.name) ? "firedoor" : "door";
      if (/EXIT/i.test(t.name) && r !== "door" && r !== "firedoor") r = "exit";
      insRole[t.id] = r;
    }
    const model = { solids: [], strokes: [], furniture: [], doors: [], seats: [], texts: [], exitSigns: [], stairPts: [], draw: [], units: U, warnings: [] };
    const byIns = {};
    for (const p of F.prims) { if (p.ins >= 0) (byIns[p.ins] = byIns[p.ins] || []).push(p); }
    // doors from inserts
    for (const t of F.inserts) {
      const r = insRole[t.id];
      if (r !== "door" && r !== "firedoor") continue;
      const ps = byIns[t.id] || [];
      const arcs = ps.filter(p => p.kind === "arc"), lines = ps.filter(p => p.kind === "line" || (p.kind === "poly" && !p.closed && p.pts.length === 2));
      let d = null;
      const tipOf = (a) => {
        for (const l of lines) for (const [q0, q1] of [[l.pts[0], l.pts[l.pts.length - 1]], [l.pts[l.pts.length - 1], l.pts[0]]]) {
          if (Math.hypot(q0[0] - a.c[0], q0[1] - a.c[1]) < 0.05) {
            if (Math.hypot(q1[0] - a.p0[0], q1[1] - a.p0[1]) < 0.06) return [a.p0, a.p1];
            if (Math.hypot(q1[0] - a.p1[0], q1[1] - a.p1[1]) < 0.06) return [a.p1, a.p0];
          }
        }
        return null;
      };
      if (arcs.length === 1) {
        const a = arcs[0]; let tp = tipOf(a);
        if (!tp) tp = [a.p1, a.p0];
        const [tip, open] = tp;
        const u = [(open[0] - a.c[0]) / a.r, (open[1] - a.c[1]) / a.r], n = [(tip[0] - a.c[0]) / a.r, (tip[1] - a.c[1]) / a.r];
        d = { hinge: a.c.slice(), u, n, width: a.r, double: false };
      } else if (arcs.length >= 2) {
        const a = arcs[0], b = arcs[1];
        const w = Math.hypot(b.c[0] - a.c[0], b.c[1] - a.c[1]);
        if (w > 0.3) {
          const u = [(b.c[0] - a.c[0]) / w, (b.c[1] - a.c[1]) / w];
          const tp = tipOf(a) || [a.p1, a.p0];
          let n = [(tp[0][0] - a.c[0]) / a.r, (tp[0][1] - a.c[1]) / a.r];
          const dot = n[0] * u[0] + n[1] * u[1]; n = [n[0] - u[0] * dot, n[1] - u[1] * dot]; const nm = Math.hypot(n[0], n[1]) || 1; n = [n[0] / nm, n[1] / nm];
          d = { hinge: a.c.slice(), u, n, width: w, double: true };
        }
      }
      if (!d || d.width < 0.5 || d.width > 4) { model.warnings.push("Could not read door geometry for block " + t.name); continue; }
      // snap u to an orthonormal frame
      const um = Math.hypot(d.u[0], d.u[1]); d.u = [d.u[0] / um, d.u[1] / um];
      const side = d.u[0] * d.n[1] - d.u[1] * d.n[0] >= 0 ? 1 : -1; d.n = [-d.u[1] * side, d.u[0] * side];
      d.width = Math.round(d.width * 100) / 100;
      d.fire = r === "firedoor" || /FIRE|FD/i.test(t.name) || !!t.attribs.FIRE_RATING;
      d.rating = t.attribs.FIRE_RATING || "";
      d.name = t.attribs.DOOR_ID || null;
      d.orig = { hinge: d.hinge.slice(), width: d.width };
      d.ins = t.id; d.block = t.name; d.blocked = false; d.isExit = false; d.reasons = []; d.score = 0; d.stairWidth = 1.2;
      model.doors.push(d);
    }
    model.doors.forEach((d, i) => { d.id = i; if (!d.name) d.name = "D" + String(i + 1).padStart(2, "0"); });
    const doorIns = new Set(model.doors.map(d => d.ins));
    // geometry by role
    let xa = 1e18, ya = 1e18, xb = -1e18, yb = -1e18;
    for (const p of F.prims) {
      const r = p.ins >= 0 && insRole[p.ins] && insRole[p.ins] !== "ignore" && roleOf(p.layer) === "ignore" ? insRole[p.ins] : roleOf(p.layer);
      p.role = r;
      if (p.ins >= 0 && doorIns.has(p.ins)) { p.role = "doorsym"; continue; }
      if (p.kind === "text") { model.texts.push(p); if (r !== "ignore") model.draw.push(p); continue; }
      if (r === "wall" || r === "obstacle") {
        if ((p.kind === "poly" || p.kind === "circle") && p.closed && p.pts.length >= 3) model.solids.push(p.pts);
        else for (let k = 0; k + 1 < p.pts.length; k++) model.strokes.push([p.pts[k][0], p.pts[k][1], p.pts[k + 1][0], p.pts[k + 1][1]]);
        for (const q of p.pts) { xa = Math.min(xa, q[0]); xb = Math.max(xb, q[0]); ya = Math.min(ya, q[1]); yb = Math.max(yb, q[1]); }
      } else if (r === "furniture") {
        if (p.kind === "circle" && p.r > 0.15 && p.r < 0.4) model.seats.push(p.c.slice());
        else if (p.kind === "poly" && p.closed && p.pts.length >= 3) model.furniture.push(p.pts);
      } else if (r === "stair") {
        for (const q of p.pts) model.stairPts.push(q);
      }
      if (r !== "ignore") model.draw.push(p);
    }
    for (const t of F.inserts) if (insRole[t.id] === "exit") model.exitSigns.push(t.at);
    if (xa > xb) { xa = 0; ya = 0; xb = 10; yb = 10; model.warnings.push("No wall geometry found — check the layer roles."); }
    model.bounds = [xa, ya, xb, yb];
    model.stats = { prims: F.prims.length, inserts: F.inserts.length, doors: model.doors.length, seats: model.seats.length, solids: model.solids.length, strokes: model.strokes.length };
    return model;
  }

  // ------------------------------------------------------------ exit detection (clues + geometry)
  const EXIT_TXT = /EXIT|ESCAPE|STAIR|EGRESS|مخرج|درج|سلم/i;
  function detectExits(model) {
    const g = core.rasterize(model, {});
    const { nx, ny } = g, N = nx * ny, CS = g.cs;
    const stairCells = new Uint8Array(N);
    for (const q of model.stairPts) { const k = core.cellOf(g, q[0], q[1]); if (k >= 0) stairCells[k] = 1; }
    for (const d of model.doors) {
      d.reasons = []; d.score = 0;
      const mid = [d.hinge[0] + d.u[0] * d.width / 2, d.hinge[1] + d.u[1] * d.width / 2];
      if (d.fire) { d.score += 2; d.reasons.push(d.rating ? "fire-rated door (" + d.rating + ")" : "fire-door block/layer"); }
      for (const s of model.exitSigns) if (Math.hypot(s[0] - mid[0], s[1] - mid[1]) < 3) { d.score += 2; d.reasons.push("EXIT sign within 3 m"); break; }
      for (const t of model.texts) if (EXIT_TXT.test(t.text) && Math.hypot(t.p[0] - mid[0], t.p[1] - mid[1]) < 4.5) { d.score += 1; d.reasons.push("text “" + t.text.trim().slice(0, 18) + "” nearby"); break; }
      // flood the swing side
      const doorCells = new Uint8Array(N);
      const band = d.band || [-0.15, 0.15];
      // reuse core rect helper through rasterize side effect: approximate with sampling
      for (let s = -0.05; s <= d.width + 0.05; s += CS / 2) for (let t = band[0] - 0.12; t <= band[1] + 0.12; t += CS / 2) {
        const k = core.cellOf(g, d.hinge[0] + d.u[0] * s + d.n[0] * t, d.hinge[1] + d.u[1] * s + d.n[1] * t); if (k >= 0) doorCells[k] = 1;
      }
      const sx = mid[0] + d.n[0] * (band[1] + 0.3), sy = mid[1] + d.n[1] * (band[1] + 0.3);
      const sk = core.cellOf(g, sx, sy);
      let open = false, hasStair = false, cnt = 0;
      if (sk >= 0 && !g.obst[sk]) {
        const seen = new Uint8Array(N), st = [sk]; seen[sk] = 1;
        while (st.length) {
          const c = st.pop(); cnt++;
          if (stairCells[c]) hasStair = true;
          const ci = c % nx, cj = (c - ci) / nx;
          if (ci === 0 || cj === 0 || ci === nx - 1 || cj === ny - 1) { open = true; break; }
          if (cnt > 8000) break;
          for (const k of [c - 1, c + 1, c - nx, c + nx]) if (!seen[k] && !g.obst[k] && !doorCells[k]) { seen[k] = 1; st.push(k); }
        }
      }
      d.leadsTo = open ? "outside" : (hasStair && cnt <= 8000 ? "stair" : (cnt <= 8000 ? "room" : "floor"));
      if (d.leadsTo === "stair") { d.score += 3; d.reasons.push("opens into an enclosure with stair geometry"); }
      if (d.leadsTo === "outside") { d.score += 3; d.reasons.push("door in the external wall (leads outside)"); }
      d.isExit = d.score >= 3 && (d.leadsTo === "stair" || d.leadsTo === "outside" || d.score >= 4);
    }
    return model;
  }

  return { parse, flatten, buildModel, detectExits, guessRole, ROLES, ROLE_LABEL };
}
if (typeof module !== "undefined") module.exports = DXF_IMPORT;
