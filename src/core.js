// Evacuation Flow — simulation core. Pure JS, no DOM; stringified into a Web Worker for Monte Carlo.
function SIM_CORE() {
  "use strict";
  const CS = 0.1; // grid cell size, m
  const INF = 1e9;

  // ---------------------------------------------------------------- random
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randn(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

  // ---------------------------------------------------------------- grid + rasterisation
  function makeGrid(bounds, pad) {
    pad = pad == null ? 1.5 : pad;
    const x0 = bounds[0] - pad, y0 = bounds[1] - pad;
    const nx = Math.ceil((bounds[2] - bounds[0] + 2 * pad) / CS), ny = Math.ceil((bounds[3] - bounds[1] + 2 * pad) / CS);
    return { x0, y0, nx, ny, cs: CS, obst: new Uint8Array(nx * ny) };
  }
  function markSeg(g, ax, ay, bx, by, v) { // supercover-ish: dense sampling
    const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / (CS * 0.25)));
    for (let k = 0; k <= n; k++) {
      const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
      const i = Math.floor((x - g.x0) / CS), j = Math.floor((y - g.y0) / CS);
      if (i >= 0 && j >= 0 && i < g.nx && j < g.ny) g.obst[j * g.nx + i] = v;
    }
  }
  function fillPoly(g, pts, v) {
    let ymin = INF, ymax = -INF;
    for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    const j0 = Math.max(0, Math.floor((ymin - g.y0) / CS)), j1 = Math.min(g.ny - 1, Math.ceil((ymax - g.y0) / CS));
    const xs = [];
    for (let j = j0; j <= j1; j++) {
      const yc = g.y0 + (j + 0.5) * CS; xs.length = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / CS - 0.5)), i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / CS - 0.5));
        for (let i = i0; i <= i1; i++) g.obst[j * g.nx + i] = v;
      }
    }
    // only thin shapes (glazing, thin partitions) get their outline marked, so they can't leak;
    // thick shapes stay exact (cell-centre rule) so gaps aren't narrowed
    let area = 0, per = 0;
    for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; per += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    if (2 * Math.abs(area / 2) / Math.max(per, 1e-9) < 0.1)
      for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; markSeg(g, a[0], a[1], b[0], b[1], v); }
  }
  // oriented rectangle in door frame: p = hinge + u*s + n*t
  function rectFrame(g, h, u, n, s0, s1, t0, t1, fn) {
    const c = [];
    for (const s of [s0, s1]) for (const t of [t0, t1]) c.push([h[0] + u[0] * s + n[0] * t, h[1] + u[1] * s + n[1] * t]);
    let xa = INF, xb = -INF, ya = INF, yb = -INF;
    for (const p of c) { xa = Math.min(xa, p[0]); xb = Math.max(xb, p[0]); ya = Math.min(ya, p[1]); yb = Math.max(yb, p[1]); }
    const i0 = Math.max(0, Math.floor((xa - g.x0) / CS)), i1 = Math.min(g.nx - 1, Math.floor((xb - g.x0) / CS));
    const j0 = Math.max(0, Math.floor((ya - g.y0) / CS)), j1 = Math.min(g.ny - 1, Math.floor((yb - g.y0) / CS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = g.x0 + (i + 0.5) * CS - h[0], y = g.y0 + (j + 0.5) * CS - h[1];
      const s = x * u[0] + y * u[1], t = x * n[0] + y * n[1];
      if (s >= s0 && s <= s1 && t >= t0 && t <= t1) fn(j * g.nx + i);
    }
  }
  function isObstAt(g, x, y) {
    const i = Math.floor((x - g.x0) / CS), j = Math.floor((y - g.y0) / CS);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return true;
    return g.obst[j * g.nx + i] === 1;
  }
  // measure wall band (in n direction) around a door, from a raster of walls without door patches
  function measureBand(g, d) {
    let lo = INF, hi = -INF, found = 0;
    for (const s of [-0.12, -0.25, d.width + 0.12, d.width + 0.25]) {
      for (let t = -0.8; t <= 0.8; t += 0.02) {
        const x = d.hinge[0] + d.u[0] * s + d.n[0] * t, y = d.hinge[1] + d.u[1] * s + d.n[1] * t;
        if (isObstAt(g, x, y)) { lo = Math.min(lo, t); hi = Math.max(hi, t); found++; }
      }
    }
    if (!found || hi - lo > 1.0) return [-0.15, 0.15];
    return [lo - 0.03, hi + 0.03];
  }

  // Rasterise model -> grid. opts: {furniture:bool}
  function rasterize(model, opts) {
    const g = makeGrid(model.bounds);
    for (const p of model.solids) fillPoly(g, p, 1);
    for (const s of model.strokes) markSeg(g, s[0], s[1], s[2], s[3], 1);
    if (opts && opts.furniture) for (const p of model.furniture) fillPoly(g, p, 2);
    for (const d of model.doors) if (!d.band) d.band = measureBand(g, d);
    // patch original openings shut, then cut every door at its current place
    for (const d of model.doors) if (d.orig) rectFrame(g, d.orig.hinge, d.u, d.n, -0.02, d.orig.width + 0.02, d.band[0], d.band[1], k => g.obst[k] = 1);
    for (const d of model.doors) if (!d.blocked) rectFrame(g, d.hinge, d.u, d.n, 0, d.width, d.band[0] - 0.1, d.band[1] + 0.1, k => g.obst[k] = 0);
    return g;
  }

  // ---------------------------------------------------------------- Euclidean distance transform (Felzenszwalb)
  function edt1d(f, n, d, v, z, arg) {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; arg[q] = v[k]; }
  }
  // returns [distance (m), nearest obstacle cell index]
  function edt(g) {
    const { nx, ny } = g, N = nx * ny, out = new Float32Array(N), near = new Int32Array(N);
    const m = Math.max(nx, ny), f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1), arg = new Int32Array(m);
    const tmp = new Float64Array(N), rowOf = new Int32Array(N);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) f[j] = g.obst[j * nx + i] ? 0 : 1e12;
      edt1d(f, ny, d, v, z, arg);
      for (let j = 0; j < ny; j++) { tmp[j * nx + i] = d[j]; rowOf[j * nx + i] = arg[j]; }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) f[i] = tmp[j * nx + i];
      edt1d(f, nx, d, v, z, arg);
      for (let i = 0; i < nx; i++) { out[j * nx + i] = Math.sqrt(d[i]) * CS; const ci = arg[i]; near[j * nx + i] = rowOf[j * nx + ci] * nx + ci; }
    }
    out.near = near;
    return out;
  }
  function gradient(g, a) {
    const { nx, ny } = g, gx = new Float32Array(nx * ny), gy = new Float32Array(nx * ny);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      gx[k] = (a[k + 1] - a[k - 1]) / (2 * CS); gy[k] = (a[k + nx] - a[k - nx]) / (2 * CS);
    }
    return [gx, gy];
  }

  // ---------------------------------------------------------------- Dijkstra (16-neighbour) on a binary heap
  const OFFS = [];
  (function () {
    const base = [[1, 0, []], [1, 1, [[1, 0], [0, 1]]], [2, 1, [[1, 0], [1, 1]]], [1, 2, [[0, 1], [1, 1]]]];
    const seen = {};
    for (const [a, b, mids] of base) for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sw of [0, 1]) {
      let dx = a * sx, dy = b * sy, ms = mids.map(m => [m[0] * sx, m[1] * sy]);
      if (sw) { [dx, dy] = [dy, dx]; ms = ms.map(m => [m[1], m[0]]); }
      const key = dx + "," + dy; if (seen[key]) continue; seen[key] = 1;
      OFFS.push({ dx, dy, L: Math.hypot(dx, dy) * CS, mids: ms });
    }
  })();
  function dijkstra(g, blocked, seeds, pen) {
    const { nx, ny } = g, N = nx * ny, dist = new Float64Array(N).fill(INF);
    let hk = new Float64Array(1 << 16), hv = new Int32Array(1 << 16), hn = 0;
    function push(key, val) {
      if (hn >= hk.length) { const k2 = new Float64Array(hk.length * 2), v2 = new Int32Array(hk.length * 2); k2.set(hk); v2.set(hv); hk = k2; hv = v2; }
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= key) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
      hk[i] = key; hv[i] = val;
    }
    function pop() {
      const rv = hv[0], lk = hk[--hn], lv = hv[hn]; let i = 0;
      while (true) {
        let c = 2 * i + 1; if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c;
      }
      hk[i] = lk; hv[i] = lv; return rv;
    }
    for (const s of seeds) { dist[s] = 0; push(0, s); }
    while (hn > 0) {
      const topKey = hk[0], c = pop();
      if (topKey > dist[c]) continue;
      const ci = c % nx, cj = (c - ci) / nx;
      for (const o of OFFS) {
        const ni = ci + o.dx, nj = cj + o.dy;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni; if (blocked[nk]) continue;
        let ok = true;
        for (const m of o.mids) if (blocked[(cj + m[1]) * nx + ci + m[0]]) { ok = false; break; }
        if (!ok) continue;
        const nd = topKey + o.L * (1 + (pen ? 0.5 * (pen[c] + pen[nk]) : 0));
        if (nd < dist[nk]) { dist[nk] = nd; push(nd, nk); }
      }
    }
    return Float32Array.from(dist);
  }
  function flowField(g, dist, blocked) {
    const { nx, ny } = g, N = nx * ny, fx = new Float32Array(N), fy = new Float32Array(N), sx = new Float32Array(N), sy = new Float32Array(N);
    for (let j = 2; j < ny - 2; j++) for (let i = 2; i < nx - 2; i++) {
      const k = j * nx + i, d0 = dist[k]; if (d0 >= INF) continue;
      const dl = dist[k - 1], dr = dist[k + 1], dd = dist[k - nx], du = dist[k + nx];
      let gx, gy;
      if (dl < INF && dr < INF) gx = (dr - dl) / 2; else if (dr < INF) gx = dr - d0; else if (dl < INF) gx = d0 - dl; else gx = 0;
      if (dd < INF && du < INF) gy = (du - dd) / 2; else if (du < INF) gy = du - d0; else if (dd < INF) gy = d0 - dd; else gy = 0;
      const m = Math.hypot(gx, gy); if (m > 1e-9) { fx[k] = -gx / m; fy[k] = -gy / m; }
      // steepest-descent neighbour: never ambiguous on a watershed
      let best = 0, bo = null;
      for (const o of OFFS) {
        const nk = (j + o.dy) * nx + i + o.dx; if (blocked[nk] || dist[nk] >= INF) continue;
        let ok = true; for (const mm of o.mids) if (blocked[(j + mm[1]) * nx + i + mm[0]]) { ok = false; break; }
        if (!ok) continue;
        const sl = (dist[nk] - d0) / o.L; if (sl < best) { best = sl; bo = o; }
      }
      if (bo) { const L = Math.hypot(bo.dx, bo.dy); sx[k] = bo.dx / L; sy[k] = bo.dy / L; } else { sx[k] = fx[k]; sy[k] = fy[k]; }
    }
    return [fx, fy, sx, sy];
  }

  // ---------------------------------------------------------------- environment = everything the sim needs
  // exits get a "zone": the protected space behind the exit door (flood fill on its swing side, bounded),
  // or a 1.2 m strip beyond the door if that space is open-ended (e.g. outside).
  function buildEnv(model, opts) {
    opts = opts || {};
    const g = rasterize(model, opts);
    const { nx, ny } = g, N = nx * ny;
    const dt = edt(g);
    const zone = new Int16Array(N);
    const exits = [];
    model.doors.forEach((d, di) => {
      if (!d.isExit || d.blocked) return;
      const id = exits.length + 1;
      const doorCells = new Uint8Array(N);
      rectFrame(g, d.hinge, d.u, d.n, -0.05, d.width + 0.05, d.band[0] - 0.12, d.band[1] + 0.12, k => doorCells[k] = 1);
      const sx = d.hinge[0] + d.u[0] * d.width / 2 + d.n[0] * (d.band[1] + 0.3);
      const sy = d.hinge[1] + d.u[1] * d.width / 2 + d.n[1] * (d.band[1] + 0.3);
      const si = Math.floor((sx - g.x0) / CS), sj = Math.floor((sy - g.y0) / CS);
      const cells = [];
      const MAXC = (opts.maxZoneArea || 80) / (CS * CS);
      let open = false;
      if (si > 0 && sj > 0 && si < nx - 1 && sj < ny - 1 && !g.obst[sj * nx + si]) {
        const seen = new Uint8Array(N), st = [sj * nx + si]; seen[st[0]] = 1;
        while (st.length) {
          const c = st.pop(); cells.push(c);
          if (cells.length > MAXC) { open = true; break; }
          const ci = c % nx, cj = (c - ci) / nx;
          if (ci === 0 || cj === 0 || ci === nx - 1 || cj === ny - 1) { open = true; break; }
          for (const nk of [c - 1, c + 1, c - nx, c + nx]) if (!seen[nk] && !g.obst[nk] && !doorCells[nk]) { seen[nk] = 1; st.push(nk); }
        }
      } else open = true;
      let zc = cells;
      if (open) { zc = []; rectFrame(g, d.hinge, d.u, d.n, 0, d.width, d.band[1] + 0.1, d.band[1] + 1.2, k => { if (!g.obst[k]) zc.push(k); }); }
      let mx = 0, my = 0;
      for (const k of zc) { zone[k] = id; mx += k % nx; my += Math.floor(k / nx); }
      // descent point (stair model): zone cell farthest from the door centre
      const dcx = d.hinge[0] + d.u[0] * d.width / 2, dcy = d.hinge[1] + d.u[1] * d.width / 2;
      let best = -1, bx = sx, by = sy;
      for (const k of zc) {
        const x = g.x0 + (k % nx + 0.5) * CS, y = g.y0 + (Math.floor(k / nx) + 0.5) * CS;
        const dd = Math.hypot(x - dcx, y - dcy) - (dt[k] < 0.35 ? 5 : 0);
        if (dd > best) { best = dd; bx = x; by = y; }
      }
      exits.push({ door: di, name: d.name, width: d.width, stairWidth: d.stairWidth || 1.2, cells: zc, open, descent: [bx, by], area: zc.length * CS * CS, center: [dcx, dcy] });
    });
    // fields (with wall-proximity penalty) and pure distance (for travel-distance checks)
    const pen = new Float32Array(N);
    for (let k = 0; k < N; k++) pen[k] = Math.max(0, 0.45 - dt[k]) * 4;
    // configuration space: a body centre must stay ~0.2 m off any obstacle (no routes through desk slots)
    const CLR = opts.clearance || 0.2;
    const blocked = new Uint8Array(N);
    for (let k = 0; k < N; k++) blocked[k] = (g.obst[k] || dt[k] < CLR) ? 1 : 0;
    let pure = new Float32Array(N).fill(INF);
    for (let e = 0; e < exits.length; e++) {
      const X = exits[e];
      const f = dijkstra(g, blocked, X.cells, pen);
      const [fx, fy, sdx, sdy] = flowField(g, f, blocked);
      // cells hugging a wall (outside the configuration space): step away from the wall
      for (let k = 0; k < N; k++) if (!g.obst[k] && blocked[k]) {
        const nk = dt.near[k], ci = k % nx, cj = (k - ci) / nx, ni = nk % nx, nj = (nk - ni) / nx;
        let vx = ci - ni, vy = cj - nj; const m = Math.hypot(vx, vy) || 1; fx[k] = sdx[k] = vx / m; fy[k] = sdy[k] = vy / m;
      }
      X.field = f; X.fx = fx; X.fy = fy; X.sx = sdx; X.sy = sdy;
      const p = dijkstra(g, blocked, X.cells, null);
      X.pure = p;
      for (let k = 0; k < N; k++) if (p[k] < pure[k]) pure[k] = p[k];
    }
    // spawnable cells: walkable, not in an exit zone, reachable, clear of walls
    const spawn = [];
    for (let k = 0; k < N; k++) if (!g.obst[k] && !zone[k] && pure[k] < INF && dt[k] > 0.32) spawn.push(k);
    return { g, edt: dt, near: dt.near, zone, exits, pure, spawn: Int32Array.from(spawn), seats: model.seats || [] };
  }

  // ---------------------------------------------------------------- sampling helpers
  function bil(g, a, x, y) {
    const fx = (x - g.x0) / CS - 0.5, fy = (y - g.y0) / CS - 0.5;
    let i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0) i = 0; if (j < 0) j = 0; if (i > g.nx - 2) i = g.nx - 2; if (j > g.ny - 2) j = g.ny - 2;
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), k = j * g.nx + i;
    return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + g.nx] * (1 - tx) + a[k + g.nx + 1] * tx) * ty;
  }
  function cellOf(g, x, y) {
    const i = Math.floor((x - g.x0) / CS), j = Math.floor((y - g.y0) / CS);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1; return j * g.nx + i;
  }
  // pre-movement sampler: returns seconds AFTER the alarm
  function preSampler(pm, r) {
    const t = pm.type;
    if (t === "none") return () => 0;
    if (t === "fixed") return () => pm.fixed;
    if (t === "uniform") return () => pm.min + (pm.max - pm.min) * r();
    if (t === "normal") return () => Math.max(0, pm.mean + pm.sd * randn(r));
    if (t === "lognormal") { // parameterised by 1st and 99th percentile (PD 7974-6 style)
      const a = Math.log(Math.max(1, pm.p1)), b = Math.log(Math.max(pm.p1 + 1, pm.p99));
      const mu = (a + b) / 2, sg = (b - a) / (2 * 2.3263);
      return () => Math.exp(mu + sg * randn(r));
    }
    return () => 0;
  }

  // ---------------------------------------------------------------- social force simulation
  const DEF = { A: 2000, B: 0.08, Aw: 2000, Bw: 0.08, k: 1.2e5, kap: 2.4e5, tau: 0.5, mass: 80, lambda: 0.5, dt: 0.02, rMin: 0.22, rMax: 0.26, noise: 20, vMean: 1.25, vSd: 0.2, vMin: 0.7, vMax: 1.8 };
  const WAIT = 0, MOVE = 1, STAIR = 2, OUT = 3;

  function createSim(env, cfg) {
    const P = Object.assign({}, DEF, cfg.params || {});
    const r = rng(cfg.seed || 1);
    const g = env.g, NMAX = cfg.N;
    const X = new Float32Array(NMAX), Y = new Float32Array(NMAX), VX = new Float32Array(NMAX), VY = new Float32Array(NMAX);
    const R = new Float32Array(NMAX), V0 = new Float32Array(NMAX), TP = new Float32Array(NMAX), TE = new Float32Array(NMAX).fill(-1), TS = new Float32Array(NMAX).fill(-1);
    const NX = new Float32Array(NMAX), NY = new Float32Array(NMAX), TQ = new Float32Array(NMAX), EX = new Int16Array(NMAX), ST = new Uint8Array(NMAX), RHO = new Float32Array(NMAX), XA = new Int16Array(NMAX).fill(-1);
    const nExit = env.exits.length;
    // placement
    let n = 0;
    const hashCell = 0.6, hx = Math.ceil(g.nx * CS / hashCell) + 1, hy = Math.ceil(g.ny * CS / hashCell) + 1;
    const occ = new Map();
    function overl(x, y, rr) {
      const ci = Math.floor((x - g.x0) / hashCell), cj = Math.floor((y - g.y0) / hashCell);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const l = occ.get((cj + dj) * hx + ci + di); if (!l) continue;
        for (const m of l) if (Math.hypot(X[m] - x, Y[m] - y) < R[m] + rr + 0.01) return true;
      }
      return false;
    }
    function put(x, y) {
      const rr = P.rMin + (P.rMax - P.rMin) * r();
      const k = cellOf(g, x, y); if (k < 0 || g.obst[k] || env.zone[k] || env.pure[k] >= INF || env.edt[k] < rr + 0.02) return false;
      if (overl(x, y, rr)) return false;
      X[n] = x; Y[n] = y; R[n] = rr;
      const key = Math.floor((y - g.y0) / hashCell) * hx + Math.floor((x - g.x0) / hashCell);
      if (!occ.has(key)) occ.set(key, []); occ.get(key).push(n); n++; return true;
    }
    if (cfg.positions) { for (const p of cfg.positions) { if (n >= NMAX) break; put(p[0], p[1]); } }
    else {
      if (cfg.useSeats !== false && env.seats.length) {
        const s = env.seats.slice(); for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
        for (const p of s) { if (n >= NMAX) break; put(p[0], p[1]); }
      }
      let tries = 0;
      while (n < NMAX && tries < NMAX * 200 && env.spawn.length) {
        tries++;
        const k = env.spawn[Math.floor(r() * env.spawn.length)];
        put(g.x0 + (k % g.nx + r()) * CS, g.y0 + (Math.floor(k / g.nx) + r()) * CS);
      }
    }
    const pre = preSampler(cfg.pre || { type: "none" }, r);
    const alarm = cfg.alarm || 0;
    for (let i = 0; i < n; i++) {
      V0[i] = cfg.fixedSpeed || Math.min(P.vMax, Math.max(P.vMin, P.vMean + P.vSd * randn(r)));
      TP[i] = alarm + pre(); ST[i] = WAIT; EX[i] = -1;
    }
    const tokens = new Float64Array(nExit);
    const exitCount = new Int32Array(nExit), exitFirst = new Float64Array(nExit).fill(-1), exitLast = new Float64Array(nExit).fill(-1);
    const sim = {
      env, P, n, X, Y, VX, VY, R, V0, TP, TE, TS, TQ, EX, ST, RHO, XA, t: 0, out: 0, inStair: 0, exitCount, exitFirst, exitLast,
      curve: [[0, n]], wallHits: 0, done: n === 0, tClear: -1, tAllOut: -1, cfg,
      heat: null,
    };
    // heat grids (0.25 m)
    const HC = 0.25, hnx = Math.ceil(g.nx * CS / HC), hny = Math.ceil(g.ny * CS / HC);
    sim.heat = { cs: HC, nx: hnx, ny: hny, x0: g.x0, y0: g.y0, peak: new Float32Array(hnx * hny), cong: new Float32Array(hnx * hny), foot: new Float32Array(hnx * hny) };

    // spatial hash for forces
    const CELLH = 1.0, gxn = Math.ceil(g.nx * CS / CELLH) + 1, gyn = Math.ceil(g.ny * CS / CELLH) + 1;
    const head = new Int32Array(gxn * gyn), next = new Int32Array(Math.max(1, n));
    const FX = new Float32Array(n), FY = new Float32Array(n);
    let tChoice = 0, tDens = 0, tNoise = 0; const STK = new Float32Array(n), PX = Float32Array.from(X.subarray(0, n)), PY = Float32Array.from(Y.subarray(0, n));

    function chooseExits(all) {
      if (!nExit) return;
      const queue = cfg.exitChoice === "queue";
      let q = null;
      if (queue) {
        q = new Float32Array(nExit);
        for (let i = 0; i < n; i++) if (ST[i] === MOVE && EX[i] >= 0) { const k = cellOf(g, X[i], Y[i]); if (k >= 0 && env.exits[EX[i]].field[k] < 7) q[EX[i]]++; }
      }
      for (let i = 0; i < n; i++) {
        if (ST[i] !== MOVE && !(all && ST[i] === WAIT)) continue;
        const k = cellOf(g, X[i], Y[i]); if (k < 0) continue;
        let best = -1, bc = INF, cur = INF;
        for (let e = 0; e < nExit; e++) {
          const f = env.exits[e].field[k]; if (f >= INF) continue;
          let c = f / V0[i];
          if (queue) { const cap = 1.32 * Math.max(0.3, env.exits[e].width - 0.3); c += (q[e] - (EX[i] === e && f < 7 ? 1 : 0)) / cap; }
          if (c < bc) { bc = c; best = e; }
          if (e === EX[i]) cur = c;
        }
        if (best < 0) continue;
        if (EX[i] < 0) { EX[i] = best; continue; }
        const fc = env.exits[EX[i]].field[k];
        if (best !== EX[i] && fc > 6 && bc < cur * 0.8 - 3) EX[i] = best;
      }
    }
    chooseExits(true);

    sim.step = function (nsteps) {
      const dt = P.dt, A = P.A, B = P.B, K = P.k, KAP = P.kap, TAU = P.tau, M = P.mass, LAM = P.lambda;
      let wallFy = 0, curI = 0, RI = 0.25, SQ = 1;
      function wallF(dw, wx, wy) {
        const ri = RI, ov = ri - dw; let f = P.Aw * SQ * Math.exp(ov / P.Bw), rx = f * wx, ry = f * wy;
        if (ov > 0) {
          f = K * ov; rx += f * wx; ry += f * wy;
          const tx = -wy, ty = wx, vt = VX[curI] * tx + VY[curI] * ty;
          rx -= KAP * ov * vt * tx; ry -= KAP * ov * vt * ty;
        }
        wallFy = ry; return rx;
      }
      for (let s = 0; s < nsteps && !sim.done; s++) {
        const t = sim.t;
        // activations
        for (let i = 0; i < n; i++) if (ST[i] === WAIT && t >= TP[i]) { ST[i] = MOVE; TS[i] = t; }
        // hash
        head.fill(-1);
        for (let i = 0; i < n; i++) {
          if (ST[i] === OUT) continue;
          const c = Math.floor((Y[i] - g.y0) / CELLH) * gxn + Math.floor((X[i] - g.x0) / CELLH);
          next[i] = head[c]; head[c] = i;
        }
        // forces
        for (let i = 0; i < n; i++) {
          FX[i] = 0; FY[i] = 0;
          if (ST[i] !== MOVE && ST[i] !== STAIR) continue;
          const xi = X[i], yi = Y[i], ri = R[i] * (1 - 0.2 * Math.min(1, STK[i] / 4)); curI = i; RI = ri; SQ = 1 - 0.9 * Math.min(1, STK[i] / 4);
          // desired direction
          let ex = 0, ey = 0;
          if (ST[i] === MOVE && EX[i] >= 0) {
            const E = env.exits[EX[i]];
            ex = bil(g, E.fx, xi, yi); ey = bil(g, E.fy, xi, yi);
            let m = Math.hypot(ex, ey);
            if (m < 0.75) { const k = cellOf(g, xi, yi); if (k >= 0) { ex = E.sx[k]; ey = E.sy[k]; m = Math.hypot(ex, ey); } }
            if (m > 1e-6) { ex /= m; ey /= m; }
          } else if (ST[i] === STAIR) {
            const E = env.exits[EX[i]]; ex = E.descent[0] - xi; ey = E.descent[1] - yi;
            const m = Math.hypot(ex, ey); if (m > 0.05) { ex /= m; ey /= m; } else { ex = 0; ey = 0; }
          }
          let fx = M * (V0[i] * ex - VX[i]) / TAU, fy = M * (V0[i] * ey - VY[i]) / TAU;
          // agents
          const ci = Math.floor((xi - g.x0) / CELLH), cj = Math.floor((yi - g.y0) / CELLH);
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            let j = head[(cj + dj) * gxn + ci + di];
            while (j >= 0) {
              if (j !== i) {
                const dx = xi - X[j], dy = yi - Y[j], d2 = dx * dx + dy * dy;
                if (d2 < 1.2 && d2 > 1e-8) {
                  const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, rij = ri + R[j] * (1 - 0.2 * Math.min(1, STK[j] / 4)), ov = rij - d;
                  const cosp = -(nx * ex + ny * ey);
                  const w = LAM + (1 - LAM) * (1 + cosp) / 2;
                  let f = A * Math.exp(ov / B) * w;
                  if (ov > 0) {
                    f += K * ov;
                    const tx = -ny, ty = nx, dvt = (VX[j] - VX[i]) * tx + (VY[j] - VY[i]) * ty;
                    fx += KAP * ov * dvt * tx; fy += KAP * ov * dvt * ty;
                  }
                  fx += f * nx; fy += f * ny;
                }
              }
              j = next[j];
            }
          }
          // walls: nearest wall point (feature transform) + the opposite wall along the same line
          const kc = cellOf(g, xi, yi);
          if (kc >= 0 && env.edt[kc] < 1.2) {
            const nk = env.near[kc], ni = nk % g.nx, nj = (nk - ni) / g.nx;
            const px = g.x0 + (ni + 0.5) * CS, py = g.y0 + (nj + 0.5) * CS;
            let wx = xi - px, wy = yi - py; const dc = Math.hypot(wx, wy);
            if (dc > 1e-6) {
              wx /= dc; wy /= dc;
              const dw = Math.max(0, dc - CS * 0.5);
              fx += wallF(dw, wx, wy); fy += wallFy;
              // opposite side
              for (let sd = 0.05; sd < 0.9; sd += 0.05) {
                const k2 = cellOf(g, xi + wx * sd, yi + wy * sd);
                if (k2 < 0 || g.obst[k2]) { fx += wallF(Math.max(0, sd - CS * 0.5), -wx, -wy); fy += wallFy; break; }
              }
            }
          }
          FX[i] = fx + NX[i]; FY[i] = fy + NY[i];
        }
        // integrate
        for (let i = 0; i < n; i++) {
          if (ST[i] !== MOVE && ST[i] !== STAIR) continue;
          let vx = VX[i] + FX[i] / M * dt, vy = VY[i] + FY[i] / M * dt;
          const sp = Math.hypot(vx, vy), vm = Math.max(1.3 * V0[i], 1.0);
          if (sp > vm) { vx *= vm / sp; vy *= vm / sp; }
          let nx = X[i] + vx * dt, ny = Y[i] + vy * dt;
          const k = cellOf(g, nx, ny);
          if (k < 0 || g.obst[k]) {
            sim.wallHits++;
            const kx = cellOf(g, nx, Y[i]), ky = cellOf(g, X[i], ny);
            if (kx >= 0 && !g.obst[kx]) { ny = Y[i]; vy = 0; }
            else if (ky >= 0 && !g.obst[ky]) { nx = X[i]; vx = 0; }
            else { nx = X[i]; ny = Y[i]; vx = 0; vy = 0; }
          }
          X[i] = nx; Y[i] = ny; VX[i] = vx; VY[i] = vy;
          if (ST[i] === MOVE) {
            if (Math.hypot(vx, vy) < 0.35 * V0[i] && t - TS[i] > 1) TQ[i] += dt;
            const kk = cellOf(g, nx, ny), z = kk >= 0 ? env.zone[kk] : 0;
            if (z > 0) {
              const e = z - 1; EX[i] = e; XA[i] = e;
              exitCount[e]++; if (exitFirst[e] < 0) exitFirst[e] = t; exitLast[e] = t;
              TE[i] = t;
              if (cfg.stairModel && !env.exits[e].open) { ST[i] = STAIR; sim.inStair++; }
              else { ST[i] = OUT; }
              sim.out++;
            }
          }
        }
        // stair discharge (SFPE stair specific flow x effective width)
        if (cfg.stairModel) {
          for (let e = 0; e < nExit; e++) {
            const E = env.exits[e]; if (E.open) continue;
            const rate = (cfg.stairFs || 1.01) * Math.max(0.3, E.stairWidth - 0.3);
            tokens[e] = Math.min(tokens[e] + rate * dt, 1.5);
            while (tokens[e] >= 1) {
              let best = -1, bd = INF;
              for (let i = 0; i < n; i++) if (ST[i] === STAIR && EX[i] === e) { const d = Math.hypot(X[i] - E.descent[0], Y[i] - E.descent[1]); if (d < bd) { bd = d; best = i; } }
              if (best < 0 || bd > 1.6) break;
              ST[best] = OUT; tokens[e] -= 1; sim.inStair--;
            }
          }
        }
        sim.t += dt;
        tChoice += dt; if (tChoice >= 1) { tChoice = 0; chooseExits(false); }
        // fluctuation force (Helbing et al. 2000): small, time-correlated noise; larger when someone is stuck
        tNoise += dt;
        if (tNoise >= 0.5) {
          tNoise = 0;
          for (let i = 0; i < n; i++) {
            if (ST[i] !== MOVE && ST[i] !== STAIR) continue;
            const moved = Math.hypot(X[i] - PX[i], Y[i] - PY[i]); PX[i] = X[i]; PY[i] = Y[i];
            STK[i] = ((moved < 0.12 && RHO[i] < 1.3) || moved < 0.04) ? STK[i] + 0.5 : Math.max(0, STK[i] - 1.5);
            const amp = P.noise * (1 + Math.min(6, STK[i] / 2));
            const a = r() * 2 * Math.PI; NX[i] = amp * Math.cos(a); NY[i] = amp * Math.sin(a);
          }
        }
        tDens += dt;
        if (tDens >= 0.1) { tDens = 0; density(0.1); }
        if (Math.round(sim.t / dt) % 50 === 0) sim.curve.push([sim.t, n - sim.out]);
        if (sim.out >= n && sim.tClear < 0) { sim.tClear = sim.t; }
        if (sim.out >= n && sim.inStair === 0) { sim.tAllOut = sim.t; sim.done = true; sim.curve.push([sim.t, 0]); }
        if (sim.t > (cfg.tMax || 1800)) sim.done = true;
      }
    };
    function density(dtAcc) {
      // Gaussian-weighted neighbour count (R = 0.7 m) plus a half-weight for the person themself,
      // so a lone walker reads ~0.3 p/m2 (LOS A/B) and a packed queue ~3 p/m2
      const RK = 0.7, inv = 1 / (Math.PI * RK * RK), H = sim.heat;
      for (let i = 0; i < n; i++) {
        if (ST[i] === OUT) { RHO[i] = 0; continue; }
        const ci = Math.floor((X[i] - g.x0) / CELLH), cj = Math.floor((Y[i] - g.y0) / CELLH);
        let s = 0.5;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          let j = head[(cj + dj) * gxn + ci + di];
          while (j >= 0) { if (j !== i && ST[j] !== OUT) { const d2 = (X[i] - X[j]) ** 2 + (Y[i] - Y[j]) ** 2; if (d2 < 2.25) s += Math.exp(-d2 / (RK * RK)); } j = next[j]; }
        }
        RHO[i] = s * inv;
        if (ST[i] === MOVE) {
          const hi = Math.floor((X[i] - H.x0) / H.cs), hj = Math.floor((Y[i] - H.y0) / H.cs);
          if (hi >= 0 && hj >= 0 && hi < H.nx && hj < H.ny) {
            const hk = hj * H.nx + hi;
            if (RHO[i] > H.peak[hk]) H.peak[hk] = RHO[i];
            if (RHO[i] > 1.08) H.cong[hk] += dtAcc;
            H.foot[hk] += dtAcc;
          }
        }
      }
    }
    sim.summary = function () {
      const s = { n, tClear: sim.tClear, tAllOut: sim.tAllOut, exits: [], pre: 0, travel: 0, queue: 0, last: null, wallHits: sim.wallHits };
      let lastI = -1, lt = -1;
      for (let i = 0; i < n; i++) {
        if (TE[i] < 0) continue;
        s.pre += TP[i]; s.queue += TQ[i]; s.travel += Math.max(0, TE[i] - TS[i] - TQ[i]);
        if (TE[i] > lt) { lt = TE[i]; lastI = i; }
      }
      const m = Math.max(1, sim.out); s.pre /= m; s.queue /= m; s.travel /= m;
      if (lastI >= 0) s.last = { pre: TP[lastI], queue: TQ[lastI], travel: Math.max(0, TE[lastI] - TS[lastI] - TQ[lastI]), t: TE[lastI] };
      let preMax = 0; for (let i = 0; i < n; i++) preMax = Math.max(preMax, TP[i]); s.preMax = preMax;
      for (let e = 0; e < nExit; e++) {
        const dur = exitLast[e] - exitFirst[e];
        s.exits.push({ count: exitCount[e], first: exitFirst[e], last: exitLast[e], flow: dur > 1 ? exitCount[e] / dur : 0 });
      }
      return s;
    };
    return sim;
  }

  function runHeadless(env, cfg) {
    const sim = createSim(env, cfg);
    while (!sim.done) sim.step(100);
    return sim;
  }

  return { CS, INF, rng, makeGrid, rasterize, edt, dijkstra, buildEnv, createSim, runHeadless, bil, cellOf, preSampler, DEF, WAIT, MOVE, STAIR, OUT };
}
if (typeof module !== "undefined") module.exports = SIM_CORE();
