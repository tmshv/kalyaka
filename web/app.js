// kalyaka: a shared drawing sheet. Plain JS, no build step.
//
// Everything a client does goes out as a list of ops in one publication per
// tick. The server keeps nothing; a late joiner asks for the sheet and the
// peer who has been in the room longest sends it.
"use strict";

(() => {
  const INKS = [["#f2f6fb", "White"], ["#7fd1ff", "Cyan"], ["#ffcf5a", "Amber"], ["#ff7b6b", "Red"]];
  const PEOPLE_COLORS = ["#ffcf5a", "#ff7b6b", "#7ee0a1", "#c3a6ff", "#ff9fd1", "#7fd1ff", "#ffb36b", "#9be7e0"];
  const REACTIONS = ["👍", "😂", "🔥", "❤️", "💩"];
  const KINDS = ["pen", "line", "arrow", "rect", "circle", "dim"];
  // Coordinates an item carries: pen grows, a dimension has two points and its offset.
  const coordsOf = (k) => (k === "pen" ? 2 : k === "dim" ? 6 : 4);
  const ADJECTIVES = ["quiet", "brave", "steady", "lucky", "swift", "calm", "bold", "keen", "wise", "sunny", "rapid", "gentle", "sharp", "noble", "plain", "bright"];
  const ANIMALS = ["otter", "heron", "badger", "lynx", "falcon", "beaver", "walrus", "crane", "marten", "moose", "pelican", "owl", "narwhal", "wombat", "gecko", "yak"];
  const ARCHITECTS = ["corbusier", "mies", "gropius", "aalto", "wright", "gaudi", "hadid", "kahn", "niemeyer", "foster", "piano", "koolhaas", "siza", "ando", "utzon", "saarinen", "barragan", "zumthor", "melnikov", "shukhov", "leonidov", "ginzburg", "palladio", "brunelleschi"];
  // Nouns for random sheet and people names; add a list here to widen the pool.
  const NOUNS = [...ANIMALS, ...ARCHITECTS];

  const GRID = 20;                 // minor cell, and the snap step
  const MAJOR = 100;
  const TICK_MS = 40;              // one publication per tick at most (25/s; server allows 30/s)
  const MAX_MESSAGE = 14000;       // server refuses publications over 16 KB
  const MAX_SNAPSHOT = 900000;     // server refuses snapshots over 1 MB
  const MAX_ITEMS = 3000;
  const MAX_POINTS = 4000;         // a longer pen line is continued as a new one
  const SYNC_WAIT_MS = 4000;
  const MAX_RISING = 40;

  const $ = (id) => document.getElementById(id);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const rid = () => Math.random().toString(36).slice(2, 10);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch { return null; }
  }

  function randomRoom() {
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${10 + Math.floor(Math.random() * 90)}`;
  }

  function normalizeRoom(s) {
    return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  const roomFromPath = normalizeRoom(decodeURIComponent(location.pathname.slice(1)));
  if (!roomFromPath) {
    showHome();
    return;
  }
  if (location.pathname.slice(1) !== roomFromPath) history.replaceState(null, "", "/" + roomFromPath);
  showBoard(roomFromPath);

  // ---------- home ----------

  function showHome() {
    $("home").hidden = false;
    const input = $("room-input");
    $("host-prefix").textContent = location.host + "/";
    input.value = randomRoom();
    $("reroll").addEventListener("click", () => { input.value = randomRoom(); input.focus(); });
    $("open-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const room = normalizeRoom(input.value);
      if (room) location.assign("/" + room);
    });
  }

  // ---------- board ----------

  function showBoard(room) {
    document.title = `${room} – kalyaka`;
    const board = $("board");
    board.hidden = false;
    $("room-name").textContent = room;
    $("tb-room").textContent = room;
    $("tb-date").textContent = new Date().toISOString().slice(0, 10);
    $("tb-grid").textContent = `${GRID} / ${MAJOR}`;

    const me = store("kalyaka:me") || {};
    if (!me.name) me.name = `${cap(pick(ADJECTIVES))} ${cap(pick(NOUNS))}`;
    if (!PEOPLE_COLORS.includes(me.color)) me.color = pick(PEOPLE_COLORS);
    store("kalyaka:me", me);

    const canvas = $("canvas");
    const ctx = canvas.getContext("2d");
    const items = new Map();       // id -> {id, by, k, c, w, p}; pen: [x, y, ...], shapes: [x1, y1, x2, y2]
    const mine = [];               // my item ids, for undo
    const peers = new Map();       // client id -> {name, color, row, cursor, at}
    const view = { x: 0, y: 0 };   // world = screen + view
    const tool = { kind: "pen", ink: INKS[0][0], weight: 1, snap: store("kalyaka:snap") === true };
    let myId = "";
    let dirty = true;
    let out = [];
    let cursor = null;             // my last cursor in world coords, null when outside
    let cursorSent = true;
    let drawing = null;            // item in progress: {item, sent, sentPoints, changed}
    let syncing = false;
    let syncBuffer = [];
    let syncTimer = 0;

    // ----- rendering -----

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      dirty = true;
    }
    addEventListener("resize", resize);
    resize();

    // A 1 px line sits on pixel centres only at 1x; at 2x integer coords are crisp.
    const halfPixel = () => ((window.devicePixelRatio || 1) === 1 ? 0.5 : 0);

    function drawGrid(g, w, h, ox, oy) {
      const hp = halfPixel();
      g.fillStyle = "#0f2d52";
      g.fillRect(0, 0, w, h);
      g.lineWidth = 1;
      for (const [step, color] of [[GRID, "rgba(150, 195, 255, 0.09)"], [MAJOR, "rgba(150, 195, 255, 0.2)"]]) {
        g.strokeStyle = color;
        g.beginPath();
        for (let x = Math.ceil(ox / step) * step; x - ox < w; x += step) {
          if (step === GRID && x % MAJOR === 0) continue;
          g.moveTo(Math.round(x - ox) + hp, 0); g.lineTo(Math.round(x - ox) + hp, h);
        }
        for (let y = Math.ceil(oy / step) * step; y - oy < h; y += step) {
          if (step === GRID && y % MAJOR === 0) continue;
          g.moveTo(0, Math.round(y - oy) + hp); g.lineTo(w, Math.round(y - oy) + hp);
        }
        g.stroke();
      }
    }

    function drawItem(g, s) {
      const p = s.p;
      g.save();
      if (s.w % 2 === 1) g.translate(halfPixel(), halfPixel());
      g.strokeStyle = s.c;
      g.fillStyle = s.c;
      g.lineWidth = s.w;
      g.lineCap = s.k === "pen" ? "round" : "square";
      g.lineJoin = s.k === "pen" ? "round" : "miter";
      g.beginPath();
      switch (s.k) {
        case "pen":
          g.moveTo(p[0], p[1]);
          if (p.length === 2) g.lineTo(p[0] + 0.01, p[1]);
          for (let i = 2; i < p.length - 2; i += 2) g.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
          if (p.length > 2) g.lineTo(p[p.length - 2], p[p.length - 1]);
          g.stroke();
          break;
        case "line":
          g.moveTo(p[0], p[1]); g.lineTo(p[2], p[3]);
          g.stroke();
          break;
        case "arrow": {
          const len = Math.hypot(p[2] - p[0], p[3] - p[1]);
          const head = Math.min(len, Math.max(12, s.w * 6));
          const a = Math.atan2(p[3] - p[1], p[2] - p[0]);
          const bx = p[2] - head * Math.cos(a), by = p[3] - head * Math.sin(a);
          g.lineCap = "butt";
          g.moveTo(p[0], p[1]); g.lineTo(bx + Math.cos(a), by + Math.sin(a));
          g.stroke();
          const spread = head * 0.32;
          g.beginPath();
          g.moveTo(p[2], p[3]);
          g.lineTo(bx + spread * Math.sin(a), by - spread * Math.cos(a));
          g.lineTo(bx - spread * Math.sin(a), by + spread * Math.cos(a));
          g.closePath();
          g.fill();
          break;
        }
        case "rect":
          g.rect(Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.abs(p[2] - p[0]), Math.abs(p[3] - p[1]));
          g.stroke();
          break;
        case "circle":
          g.arc(p[0], p[1], Math.hypot(p[2] - p[0], p[3] - p[1]), 0, Math.PI * 2);
          g.stroke();
          break;
        case "dim": {
          const d = dimension(p);
          if (!d) break;
          const { ax, ay, bx, by, ux, uy, nx, ny, side } = d;
          const gap = 3, over = 6;
          g.lineCap = "butt";
          // Extension lines start just off the measured points and run past
          // the dimension line, which itself runs past them.
          if (Math.abs(d.off) > gap) {
            g.moveTo(p[0] + nx * side * gap, p[1] + ny * side * gap); g.lineTo(ax + nx * side * over, ay + ny * side * over);
            g.moveTo(p[2] + nx * side * gap, p[3] + ny * side * gap); g.lineTo(bx + nx * side * over, by + ny * side * over);
          }
          g.moveTo(ax - ux * over, ay - uy * over); g.lineTo(bx + ux * over, by + uy * over);
          g.stroke();
          // Architectural ticks: 45° slashes, a notch heavier than the line.
          const tx = (ux + nx) * 4, ty = (uy + ny) * 4;
          g.beginPath();
          g.lineWidth = s.w + 1;
          g.moveTo(ax - tx, ay - ty); g.lineTo(ax + tx, ay + ty);
          g.moveTo(bx - tx, by - ty); g.lineTo(bx + tx, by + ty);
          g.stroke();
          // The length sits above the line, read from the bottom or the right
          // as on a drawing: a vertical one runs bottom to top.
          let angle = Math.atan2(uy, ux);
          if (angle >= Math.PI / 2 - 1e-6 || angle < -Math.PI / 2 - 1e-6) angle += Math.PI;
          g.translate((ax + bx) / 2, (ay + by) / 2);
          g.rotate(angle);
          g.font = '500 12px "Plex Condensed", "Plex Cyrillic", sans-serif';
          g.textAlign = "center";
          g.textBaseline = "bottom";
          g.fillText(String(Math.round(d.len)), 0, -3);
          break;
        }
      }
      g.restore();
    }

    // An aligned dimension: p1 and p2 are measured, p3 sets how far off the
    // line sits. Returns its geometry, or null while p1 and p2 coincide.
    function dimension(p) {
      const dx = p[2] - p[0], dy = p[3] - p[1];
      const len = Math.hypot(dx, dy);
      if (!len) return null;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      const off = (p[4] - p[0]) * nx + (p[5] - p[1]) * ny;
      return { len, ux, uy, nx, ny, off, side: Math.sign(off) || 1, ax: p[0] + nx * off, ay: p[1] + ny * off, bx: p[2] + nx * off, by: p[3] + ny * off };
    }

    function render() {
      requestAnimationFrame(render);
      if (!dirty) return;
      dirty = false;
      const dpr = canvas.width / innerWidth;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGrid(ctx, innerWidth, innerHeight, view.x, view.y);
      ctx.translate(-view.x, -view.y);
      for (const s of items.values()) drawItem(ctx, s);
    }
    requestAnimationFrame(render);
    // Dimension text is set in the page font; redraw once it has loaded.
    if (document.fonts) document.fonts.ready.then(() => { dirty = true; });

    function addItem(s) {
      items.set(s.id, s);
      while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
      dirty = true;
      $("hint").classList.add("gone");
    }

    function cleanItem(id, by, k, c, w, p) {
      if (typeof id !== "string" || !KINDS.includes(k) || !Array.isArray(p)) return null;
      const pts = p.slice(0, MAX_POINTS * 2 + 2).map(Number);
      if (pts.length < 2 || pts.length % 2 || pts.some((v) => !Number.isFinite(v))) return null;
      if (k !== "pen" && pts.length !== coordsOf(k)) return null;
      return { id, by, k, c: /^#[0-9a-f]{6}$/i.test(c) ? c : INKS[0][0], w: Math.max(1, Math.min(8, Math.round(+w) || 1)), p: pts };
    }

    // ----- ops: mine applied locally, others' from the wire -----

    function apply(by, op) {
      switch (op[0]) {
        case "s": { // start: id, kind, color, weight, ...coords
          if (items.has(op[1])) break;
          const s = cleanItem(op[1], by, op[2], op[3], op[4], op.slice(5));
          if (s) addItem(s);
          break;
        }
        case "a": { // pen append: id, first point index, flat points
          const s = items.get(op[1]);
          const at = op[2] * 2, pts = op[3];
          if (!s || s.k !== "pen" || !Array.isArray(pts) || at > s.p.length || at + pts.length > MAX_POINTS * 2 + 2) break;
          for (let j = 0; j < pts.length; j++) s.p[at + j] = +pts[j];
          dirty = true;
          break;
        }
        case "u": { // shape update: id, then all of the shape's coordinates
          const s = items.get(op[1]);
          if (!s || s.k === "pen") break;
          const n = coordsOf(s.k);
          const pts = op.slice(2, 2 + n).map(Number);
          if (pts.length === n && pts.every(Number.isFinite)) { s.p = pts; dirty = true; }
          break;
        }
        case "x":
          if (items.delete(op[1])) dirty = true;
          break;
        case "clr":
          items.clear();
          mine.length = 0;
          dirty = true;
          if (by !== myId) toast(`${nameOf(by)} cleared the sheet`);
          break;
        case "cur":
          moveCursor(by, op.length > 1 ? { x: +op[1], y: +op[2] } : null);
          break;
        case "emo":
          if (REACTIONS.includes(op[1])) rise(op[1], by);
          break;
        case "hi":
          upsertPeer(by, String(op[1] || "").slice(0, 32), PEOPLE_COLORS.includes(op[2]) ? op[2] : PEOPLE_COLORS[0]);
          break;
      }
    }

    function send(op) {
      apply(myId, op);
      out.push(op);
    }

    // ----- people -----

    function nameOf(id) {
      if (id === myId) return me.name;
      const p = peers.get(id);
      return p ? p.name : "Someone";
    }
    function colorOf(id) {
      if (id === myId) return me.color;
      const p = peers.get(id);
      return p ? p.color : PEOPLE_COLORS[0];
    }

    function upsertPeer(id, name, color) {
      if (!id || id === myId) return;
      let p = peers.get(id);
      if (!p) {
        const li = document.createElement("li");
        li.className = "person";
        li.innerHTML = '<span class="swatch-dot"></span><span class="person-name"></span>';
        $("people").append(li);
        p = { row: li, cursor: null, idle: 0, at: null };
        peers.set(id, p);
      }
      p.name = name || "anonymous";
      p.color = color;
      p.row.style.setProperty("--c", color);
      p.row.title = p.name;
      p.row.querySelector(".person-name").textContent = p.name;
      if (p.cursor) {
        p.cursor.style.setProperty("--c", color);
        p.cursor.querySelector(".label").textContent = p.name;
      }
    }

    function removePeer(id) {
      const p = peers.get(id);
      if (!p) return;
      p.row.remove();
      if (p.cursor) p.cursor.remove();
      clearTimeout(p.idle);
      peers.delete(id);
    }

    function moveCursor(id, at) {
      const p = peers.get(id);
      if (!p) return;
      if (!p.cursor) {
        const el = document.createElement("div");
        el.className = "cursor idle";
        el.innerHTML = '<svg viewBox="0 0 17 17"><path d="M0 8.5H6M11 8.5H17M8.5 0V6M8.5 11V17"/></svg><span class="label"></span>';
        el.style.setProperty("--c", p.color);
        el.querySelector(".label").textContent = p.name;
        $("cursors").append(el);
        p.cursor = el;
      }
      clearTimeout(p.idle);
      if (!at) { p.cursor.classList.add("idle"); return; }
      p.at = at;
      placeCursor(p);
      p.cursor.classList.remove("idle");
      p.idle = setTimeout(() => p.cursor && p.cursor.classList.add("idle"), 15000);
    }

    function placeCursor(p) {
      if (p.cursor && p.at) p.cursor.style.transform = `translate(${p.at.x - view.x}px, ${p.at.y - view.y}px)`;
    }

    function renderMe() {
      $("me-row").style.setProperty("--c", me.color);
      $("me-name").textContent = me.name;
    }
    renderMe();

    $("me-name").addEventListener("click", () => {
      $("me-name").hidden = true;
      $("rename-form").hidden = false;
      const input = $("rename-input");
      input.value = me.name;
      input.focus();
      input.select();
    });
    function finishRename() {
      if ($("rename-form").hidden) return;
      const name = $("rename-input").value.trim().slice(0, 32);
      $("rename-form").hidden = true;
      $("me-name").hidden = false;
      if (!name || name === me.name) return;
      me.name = name;
      store("kalyaka:me", me);
      renderMe();
      client.setData({ name: me.name, color: me.color });
      out.push(["hi", me.name, me.color]);
    }
    $("rename-form").addEventListener("submit", (e) => { e.preventDefault(); finishRename(); });
    $("rename-input").addEventListener("blur", finishRename);
    $("rename-input").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { $("rename-input").value = me.name; finishRename(); }
    });

    // ----- reactions, notices -----

    // A reaction rises from the bottom edge, signed with the sender's name.
    function rise(emoji, by) {
      const layer = $("reactions-layer");
      if (layer.childElementCount >= MAX_RISING) return;
      const el = document.createElement("div");
      el.className = "rise";
      el.innerHTML = '<span class="emoji"></span><span class="who"></span>';
      el.querySelector(".emoji").textContent = emoji;
      el.querySelector(".who").textContent = nameOf(by);
      el.style.setProperty("--c", colorOf(by));
      el.style.setProperty("--x", `${8 + Math.random() * 70}%`);
      el.style.setProperty("--h", `${Math.round(innerHeight * (0.35 + Math.random() * 0.2))}px`);
      el.style.setProperty("--drift", `${Math.round(Math.random() * 60 - 30)}px`);
      el.addEventListener("animationend", () => el.remove());
      layer.append(el);
    }

    let toastTimer = 0;
    function toast(text) {
      const el = $("toast");
      el.textContent = text;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
    }

    function status(text) {
      $("status").textContent = text || "";
      $("status").hidden = !text;
    }

    // ----- toolbar -----

    for (const [c, name] of INKS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon ink-btn";
      b.dataset.ink = c;
      b.setAttribute("aria-pressed", String(c === tool.ink));
      b.setAttribute("aria-label", `${name} ink`);
      b.title = `${name} ink`;
      b.innerHTML = "<span></span>";
      b.style.setProperty("--c", c);
      $("inks").append(b);
    }
    for (const e of REACTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon";
      b.dataset.emoji = e;
      b.textContent = e;
      b.title = `Send ${e}`;
      b.setAttribute("aria-label", `Send ${e}`);
      $("reactions").append(b);
    }

    function pressOnly(selector, match) {
      for (const b of document.querySelectorAll(selector)) b.setAttribute("aria-pressed", String(match(b)));
    }
    function setTool(kind) {
      cancelDrawing();
      tool.kind = kind;
      pressOnly(".tool", (b) => b.dataset.tool === kind);
    }
    function setInk(c) {
      tool.ink = c;
      pressOnly(".ink-btn", (b) => b.dataset.ink === c);
      if (tool.kind === "erase") setTool("pen");
    }
    function setWeight(n) {
      tool.weight = n;
      pressOnly(".weight", (b) => +b.dataset.weight === n);
    }
    function setSnap(on) {
      tool.snap = on;
      store("kalyaka:snap", on);
      $("snap").setAttribute("aria-pressed", String(on));
    }
    setSnap(tool.snap);

    let lastReaction = 0;
    function react(emoji) {
      if (performance.now() - lastReaction < 250) return;
      lastReaction = performance.now();
      send(["emo", emoji]);
    }
    function undo() {
      cancelDrawing();
      while (mine.length) {
        const id = mine.pop();
        if (items.has(id)) { send(["x", id]); return; }
      }
    }

    let clearArmed = 0;
    function clearSheet() {
      const b = $("clear");
      if (!clearArmed) {
        b.classList.add("armed");
        b.textContent = "Clear for all?";
        clearArmed = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      send(["clr"]);
    }
    function disarm() {
      clearTimeout(clearArmed);
      clearArmed = 0;
      $("clear").classList.remove("armed");
      $("clear").textContent = "Clear";
    }

    board.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.ink) setInk(b.dataset.ink);
      else if (b.dataset.weight) setWeight(+b.dataset.weight);
      else if (b.dataset.emoji) react(b.dataset.emoji);
      else if (b.id === "snap") setSnap(!tool.snap);
      else if (b.id === "undo") undo();
      else if (b.id === "clear") clearSheet();
      else if (b.id === "save") exportPNG();
    });

    $("copy-link").addEventListener("click", async () => {
      const b = $("copy-link");
      try {
        await navigator.clipboard.writeText(location.href);
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy link"; }, 1500);
      } catch {
        toast(location.href);
      }
    });

    const KEYS = { p: "pen", l: "line", a: "arrow", r: "rect", c: "circle", d: "dim", e: "erase" };
    let spaceDown = false;
    let shiftDown = false;
    addEventListener("keydown", (e) => {
      shiftDown = e.shiftKey;
      if (e.target.closest && e.target.closest("input")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") { spaceDown = true; e.preventDefault(); return; }
      if (e.key === "Escape") { cancelDrawing(); return; }
      const k = e.key.toLowerCase();
      if (KEYS[k]) setTool(KEYS[k]);
      else if (k === "g") setSnap(!tool.snap);
      else if (k === "1" || k === "2" || k === "3") setWeight([1, 2, 4][+k - 1]);
    });
    addEventListener("keyup", (e) => {
      shiftDown = e.shiftKey;
      if (e.key === " ") spaceDown = false;
    });

    // ----- pointer input -----

    const touches = new Map();
    let pan = null;

    function world(e) {
      return { x: Math.round(e.clientX + view.x), y: Math.round(e.clientY + view.y) };
    }
    function snapped(at) {
      return tool.snap ? { x: Math.round(at.x / GRID) * GRID, y: Math.round(at.y / GRID) * GRID } : at;
    }

    function moveView(dx, dy) {
      view.x += dx;
      view.y += dy;
      dirty = true;
      for (const p of peers.values()) placeCursor(p);
    }

    function segmentDistance(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
      return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
    }

    function hits(s, x, y) {
      const r = 6 + s.w / 2;
      const p = s.p;
      switch (s.k) {
        case "pen":
          for (let i = 0; i < p.length; i += 2) {
            const j = i + 2 < p.length ? i + 2 : i;
            if (segmentDistance(x, y, p[i], p[i + 1], p[j], p[j + 1]) <= r) return true;
          }
          return false;
        case "line":
        case "arrow":
          return segmentDistance(x, y, p[0], p[1], p[2], p[3]) <= r;
        case "rect": {
          const c = [[p[0], p[1], p[2], p[1]], [p[2], p[1], p[2], p[3]], [p[2], p[3], p[0], p[3]], [p[0], p[3], p[0], p[1]]];
          return c.some((e) => segmentDistance(x, y, ...e) <= r);
        }
        case "circle":
          return Math.abs(Math.hypot(x - p[0], y - p[1]) - Math.hypot(p[2] - p[0], p[3] - p[1])) <= r;
        case "dim": {
          const d = dimension(p);
          return !!d && [[d.ax, d.ay, d.bx, d.by], [p[0], p[1], d.ax, d.ay], [p[2], p[3], d.bx, d.by]].some((e) => segmentDistance(x, y, ...e) <= r);
        }
      }
      return false;
    }

    function eraseAt(at) {
      let hit = null;
      for (const s of items.values()) if (hits(s, at.x, at.y)) hit = s.id; // topmost wins
      if (hit) send(["x", hit]);
    }

    function startDrawing(at) {
      const id = rid();
      const k = tool.kind;
      const start = k === "pen" ? at : snapped(at);
      const p = [];
      for (let i = 0; i < coordsOf(k); i += 2) p.push(start.x, start.y);
      const item = { id, by: myId, k, c: tool.ink, w: tool.weight, p };
      addItem(item);
      mine.push(id);
      // A dimension is placed in stages: 1 follows its second point, 2 its offset.
      drawing = { item, sent: false, sentPoints: 0, changed: false, stage: 1 };
      // A pen dot is worth sending at once; a shape waits until it has size.
      if (k === "pen") flushDrawing();
    }

    function constrain(p, at) {
      const k = drawing.item.k;
      let { x, y } = snapped(at);
      if (shiftDown && (k === "line" || k === "arrow" || k === "dim")) {
        const len = Math.hypot(x - p[0], y - p[1]);
        const a = Math.round(Math.atan2(y - p[1], x - p[0]) / (Math.PI / 12)) * (Math.PI / 12);
        x = Math.round(p[0] + len * Math.cos(a));
        y = Math.round(p[1] + len * Math.sin(a));
      } else if (shiftDown && k === "rect") {
        const d = Math.max(Math.abs(x - p[0]), Math.abs(y - p[1]));
        x = p[0] + Math.sign(x - p[0] || 1) * d;
        y = p[1] + Math.sign(y - p[1] || 1) * d;
      }
      return { x, y };
    }

    function extendDrawing(at) {
      const s = drawing.item;
      const p = s.p;
      if (s.k === "pen") {
        if (Math.hypot(at.x - p[p.length - 2], at.y - p[p.length - 1]) < 1.5) return;
        if (p.length >= MAX_POINTS * 2) {
          const last = { x: p[p.length - 2], y: p[p.length - 1] };
          endDrawing();
          startDrawing(last);
        }
        drawing.item.p.push(at.x, at.y);
      } else if (s.k === "dim") {
        const end = drawing.stage === 1 ? constrain(p, at) : snapped(at);
        const i = drawing.stage === 1 ? 2 : 4;
        if (end.x === p[i] && end.y === p[i + 1]) return;
        p[i] = end.x;
        p[i + 1] = end.y;
        // Until the offset is set, the dimension line lies on the points.
        if (drawing.stage === 1) { p[4] = end.x; p[5] = end.y; }
        drawing.changed = true;
      } else {
        const end = constrain(p, at);
        if (end.x === p[2] && end.y === p[3]) return;
        p[2] = end.x;
        p[3] = end.y;
        drawing.changed = true;
        showMeasure(s, end);
      }
      dirty = true;
    }

    function hasSize(s) {
      return s.k === "pen" || s.p[0] !== s.p[2] || s.p[1] !== s.p[3];
    }

    // Queues whatever of the item in progress the others haven't seen yet.
    function flushDrawing() {
      if (!drawing) return;
      const s = drawing.item;
      if (!drawing.sent) {
        if (!hasSize(s)) return;
        out.push(["s", s.id, s.k, s.c, s.w, ...s.p.slice(0, coordsOf(s.k))]);
        drawing.sent = true;
        drawing.sentPoints = 1;
        drawing.changed = false;
      }
      if (s.k === "pen") {
        const n = s.p.length / 2;
        if (n > drawing.sentPoints) {
          out.push(["a", s.id, drawing.sentPoints, s.p.slice(drawing.sentPoints * 2)]);
          drawing.sentPoints = n;
        }
      } else if (drawing.changed) {
        out.push(["u", s.id, ...s.p]);
        drawing.changed = false;
      }
    }

    function endDrawing() {
      if (!drawing) return;
      const s = drawing.item;
      if (!hasSize(s)) {
        items.delete(s.id);
        mine.pop();
        dirty = true;
      } else {
        flushDrawing();
      }
      drawing = null;
      $("measure").hidden = true;
    }

    function cancelDrawing() {
      if (!drawing) return;
      const s = drawing.item;
      const sent = drawing.sent;
      drawing = null;
      $("measure").hidden = true;
      if (sent) send(["x", s.id]);
      else { items.delete(s.id); dirty = true; }
    }

    function showMeasure(s, end) {
      const p = s.p;
      const dx = p[2] - p[0], dy = p[3] - p[1];
      let text;
      if (s.k === "rect") text = `${Math.abs(dx)} × ${Math.abs(dy)}`;
      else if (s.k === "circle") text = `R ${Math.round(Math.hypot(dx, dy))}`;
      else {
        const deg = Math.round((-Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        text = `${Math.round(Math.hypot(dx, dy))}   ${deg}°`;
      }
      const el = $("measure");
      el.textContent = text;
      el.style.transform = `translate(${end.x - view.x + 14}px, ${end.y - view.y + 14}px)`;
      el.hidden = false;
    }

    function showCoords(at) {
      const p = tool.kind === "pen" || tool.kind === "erase" ? at : snapped(at);
      $("coords").textContent = `X ${String(p.x).padStart(5)}   Y ${String(p.y).padStart(5)}`;
    }

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      shiftDown = e.shiftKey;
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          // A second finger turns the gesture into a pan; drop what it started.
          cancelDrawing();
          pan = { touch: true };
          return;
        }
        if (touches.size > 2) return;
      }
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        pan = { x: e.clientX, y: e.clientY };
        board.classList.add("panning");
        return;
      }
      if (e.button !== 0) return;
      const at = world(e);
      if (drawing && drawing.item.k === "dim") {
        // Second click fixes the measured length, third places the line.
        extendDrawing(at);
        if (drawing.stage === 1) { if (hasSize(drawing.item)) drawing.stage = 2; }
        else endDrawing();
        return;
      }
      if (tool.kind === "erase") eraseAt(at);
      else startDrawing(at);
    });

    canvas.addEventListener("pointermove", (e) => {
      shiftDown = e.shiftKey;
      if (e.pointerType === "touch" && touches.has(e.pointerId)) {
        const prev = touches.get(e.pointerId);
        if (pan && pan.touch) moveView((prev.x - e.clientX) / 2, (prev.y - e.clientY) / 2);
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pan) return;
      }
      if (pan && !pan.touch) {
        moveView(pan.x - e.clientX, pan.y - e.clientY);
        pan.x = e.clientX;
        pan.y = e.clientY;
        return;
      }
      if (drawing && drawing.item.k === "pen" && e.getCoalescedEvents) {
        for (const ev of e.getCoalescedEvents()) extendDrawing(world(ev));
      }
      const at = world(e);
      if (drawing) extendDrawing(at);
      else if (tool.kind === "erase" && e.buttons === 1) eraseAt(at);
      showCoords(at);
      cursor = at;
      cursorSent = false;
    });

    function release(e) {
      touches.delete(e.pointerId);
      if (pan) {
        if (!pan.touch || touches.size === 0) { pan = null; board.classList.remove("panning"); }
        return;
      }
      if (drawing && drawing.item.k === "dim") {
        // Dragging out the first two points (as on touch) skips the second click.
        const p = drawing.item.p;
        if (drawing.stage === 1 && Math.hypot(p[2] - p[0], p[3] - p[1]) > 4) drawing.stage = 2;
        return;
      }
      endDrawing();
    }
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      cursor = null;
      cursorSent = false;
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!e.ctrlKey) moveView(e.deltaX, e.deltaY);
    }, { passive: false });

    // ----- export -----

    function exportPNG() {
      if (!items.size) { toast("The sheet is empty. Draw something first."); return; }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const grow = (x, y, r = 0) => {
        x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
        y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
      };
      for (const s of items.values()) {
        if (s.k === "circle") grow(s.p[0], s.p[1], Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]));
        else if (s.k === "dim") {
          const d = dimension(s.p);
          if (d) { grow(d.ax, d.ay, 20); grow(d.bx, d.by, 20); }
          grow(s.p[0], s.p[1]); grow(s.p[2], s.p[3]);
        } else for (let i = 0; i < s.p.length; i += 2) grow(s.p[i], s.p[i + 1]);
      }
      x0 = Math.floor(x0 / MAJOR) * MAJOR - GRID * 2;
      y0 = Math.floor(y0 / MAJOR) * MAJOR - GRID * 2;
      const w = Math.min(8000, Math.ceil((x1 - x0) / MAJOR) * MAJOR + GRID * 4);
      const h = Math.min(8000, Math.ceil((y1 - y0) / MAJOR) * MAJOR + GRID * 4);
      const scale = Math.min(2, 8000 / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      const g = c.getContext("2d");
      g.scale(scale, scale);
      drawGrid(g, w, h, x0, y0);
      g.translate(-x0, -y0);
      for (const s of items.values()) drawItem(g, s);
      c.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `kalyaka-${room}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, "image/png");
    }

    // ----- realtime -----

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new Centrifuge(`${proto}//${location.host}/connection/websocket`, {
      data: { name: me.name, color: me.color },
      minReconnectDelay: 800,
      maxReconnectDelay: 15000,
    });
    const sub = client.newSubscription(`room:${room}`);

    client.on("connecting", (ctx) => { if (ctx.code !== 0) status("Connection lost. Reconnecting…"); });
    client.on("connected", (ctx) => { myId = ctx.client; status(""); });
    client.on("disconnected", () => status("Disconnected. Reload the page to try again."));

    sub.on("subscribing", () => {
      for (const id of [...peers.keys()]) removePeer(id);
    });
    sub.on("subscribed", () => {
      status("");
      out.push(["hi", me.name, me.color]);
      requestSheet();
    });
    sub.on("error", (ctx) => {
      if (ctx.error && ctx.error.code === 106) status("Can't join right now: the sheet has 16 people, or the server is at its limit. Retrying…");
    });
    sub.on("join", (ctx) => {
      const info = ctx.info || {};
      const ci = info.connInfo || {};
      upsertPeer(info.client, ci.name, ci.color);
      // Tell the newcomer who we are; their connect-time name for us may be stale.
      setTimeout(() => out.push(["hi", me.name, me.color]), 100 + Math.random() * 400);
    });
    sub.on("leave", (ctx) => removePeer(ctx.info && ctx.info.client));
    sub.on("publication", (ctx) => {
      const by = ctx.info && ctx.info.client;
      if (!by || by === myId || !ctx.data || !Array.isArray(ctx.data.o)) return;
      if (syncing) { syncBuffer.push([by, ctx.data.o]); return; }
      for (const op of ctx.data.o) if (Array.isArray(op)) apply(by, op);
    });

    client.on("message", (ctx) => {
      const m = ctx.data || {};
      if (m.t === "sync" && m.to) sendSheet(m.to);
      else if (m.t === "snap") receiveSheet(m.s);
    });

    function requestSheet(retry = 1) {
      syncing = true;
      client.rpc("sync", {}).then((res) => {
        if (res.data && res.data.alone) { finishSync(); return; }
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => (retry > 0 ? requestSheet(retry - 1) : finishSync()), SYNC_WAIT_MS);
      }, () => finishSync());
    }

    function finishSync() {
      clearTimeout(syncTimer);
      syncing = false;
      const buffered = syncBuffer;
      syncBuffer = [];
      for (const [by, ops] of buffered) for (const op of ops) if (Array.isArray(op)) apply(by, op);
    }

    function receiveSheet(list) {
      if (!syncing || !Array.isArray(list)) return;
      for (const r of list) {
        if (!Array.isArray(r)) continue;
        const s = cleanItem(...r);
        if (!s) continue;
        const have = items.get(s.id);
        if (have && have.k === "pen" && have.p.length >= s.p.length) continue;
        addItem(s);
      }
      finishSync();
    }

    // Newest items first until the size cap, then back in drawing order.
    function sendSheet(to) {
      const list = [];
      let size = 0;
      const all = [...items.values()];
      for (let i = all.length - 1; i >= 0; i--) {
        const s = all[i];
        if (drawing && drawing.item === s && !drawing.sent) continue;
        const r = [s.id, s.by, s.k, s.c, s.w, s.p];
        size += JSON.stringify(r).length + 1;
        if (size > MAX_SNAPSHOT) break;
        list.push(r);
      }
      list.reverse();
      client.rpc("snap", { t: "snap", to, s: list }).catch(() => {});
    }

    // One publication per tick: queued ops plus the latest cursor position.
    setInterval(() => {
      if (sub.state !== "subscribed") return;
      flushDrawing();
      if (!cursorSent) {
        out.push(cursor ? ["cur", cursor.x, cursor.y] : ["cur"]);
        cursorSent = true;
      }
      if (!out.length) return;
      const ops = out;
      out = [];
      let chunk = [], size = 8;
      for (const op of ops) {
        const n = JSON.stringify(op).length + 1;
        if (chunk.length && size + n > MAX_MESSAGE) { sub.publish({ o: chunk }).catch(() => {}); chunk = []; size = 8; }
        chunk.push(op);
        size += n;
      }
      if (chunk.length) sub.publish({ o: chunk }).catch(() => {});
    }, TICK_MS);

    sub.subscribe();
    client.connect();
  }
})();
