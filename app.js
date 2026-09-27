(() => {
  const C = window.AUX_CONFIG || {};
  const API = "https://api.spotify.com/v1";
  const PID = C.playlistId || "";
  const PURI = PID ? "spotify:playlist:" + PID : "";
  const $ = (id) => document.getElementById(id);

  let token = null, tokenExp = 0;
  let state = null, lastFetch = 0;          // player state
  let plist = [], snapshot = null, curIdx = -1; // party-queue playlist
  let lyr = { key: "", lines: [], plain: "" }, lyrIdx = -2;
  let volBusy = 0;

  document.title = C.partyName || "Aux Control";
  $("partyName").textContent = C.partyName || "Aux Control";

  // ---------- helpers ----------
  const toast = (msg) => {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2500);
  };
  const fmt = (ms) => { const s = Math.floor((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const smallImg = (imgs) => (imgs && imgs.length ? imgs[imgs.length - 1].url : "");
  const bigImg = (imgs) => (imgs && imgs.length ? imgs[0].url : "");
  const artists = (t) => (t?.artists || []).map((a) => a.name).join(", ") || t?.show?.name || "";
  const position = () => {
    const item = state?.item; if (!item) return 0;
    let pos = state.progress_ms || 0;
    if (state.is_playing) pos += Date.now() - lastFetch;
    return Math.min(pos, item.duration_ms);
  };

  // ---------- auth + api ----------
  let tokenP = null;
  function getToken() {
    if (token && Date.now() < tokenExp - 60000) return Promise.resolve(token);
    if (!tokenP) tokenP = fetchToken().finally(() => { tokenP = null; });
    return tokenP;
  }
  async function fetchToken() {
    if (!C.clientId || !C.refreshToken) throw new Error("Site not set up yet — open setup.html");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: C.refreshToken });
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (C.clientSecret) headers.Authorization = "Basic " + btoa(C.clientId + ":" + C.clientSecret);
    else body.set("client_id", C.clientId);
    const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers, body });
    const j = await r.json();
    if (!r.ok) throw new Error("Spotify login expired — owner needs to re-run setup (" + (j.error_description || j.error) + ")");
    token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function sp(path, opts = {}) {
    const t = await getToken();
    const r = await fetch(API + path, { ...opts, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) {
      const msg = j?.error?.message || r.statusText;
      if (r.status === 404 && path.startsWith("/me/player")) throw new Error("No active speaker — pick one under Speaker");
      throw new Error(msg);
    }
    return j;
  }

  // ---------- now playing ----------
  async function refresh() {
    try {
      const prevUri = state?.item?.uri;
      state = await sp("/me/player?additional_types=episode");
      lastFetch = Date.now();
      renderNow();
      renderVolume();
      if (state?.item?.uri !== prevUri) { loadLyrics(); loadQueue(); }
      else computeCurIdx(), renderQueue();
    } catch (e) { $("title").textContent = e.message; }
  }

  function renderNow() {
    const item = state?.item;
    $("title").textContent = item ? item.name : "Nothing playing";
    $("artist").textContent = item ? artists(item) : "";
    const img = item ? bigImg(item.album?.images || item.images) : "";
    if (img && $("art").src !== img) $("art").src = img;
    $("tDur").textContent = fmt(item?.duration_ms);
    $("playBtn").querySelector("b").textContent = state?.is_playing ? "⏸" : "▶";
    // party screen
    $("pTitle").textContent = item ? item.name : "Nothing playing";
    $("pArtist").textContent = item ? artists(item) : "";
    if (img && $("pArt").src !== img) { $("pArt").src = img; $("partyBg").style.backgroundImage = `url("${img}")`; }
    tick();
  }

  function tick() {
    const item = state?.item; if (!item) return;
    const pos = position();
    $("tNow").textContent = fmt(pos);
    const pct = (100 * pos / item.duration_ms) + "%";
    $("progress").style.width = pct;
    $("pProgress").style.width = pct;
    syncLyrics(pos);
    if (state.is_playing && pos >= item.duration_ms && Date.now() - lastFetch > 1500) refresh();
  }

  // ---------- controls ----------
  const actions = {
    next: () => sp("/me/player/next", { method: "POST" }),
    previous: () => sp("/me/player/previous", { method: "POST" }),
    restart: () => sp("/me/player/seek?position_ms=0", { method: "PUT" }),
    toggle: () => sp(state?.is_playing ? "/me/player/pause" : "/me/player/play", { method: "PUT" }),
  };
  const labels = { next: "Skipped ⏭", previous: "Went back ⏮", restart: "Restarted ↺", toggle: "Done" };
  document.querySelectorAll(".controls button").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await actions[b.dataset.act](); toast(labels[b.dataset.act]); }
      catch (e) { toast(e.message); }
      b.disabled = false;
      setTimeout(refresh, 700);
    })
  );

  // ---------- volume (0–100 = full range of the speaker) ----------
  function renderVolume() {
    const d = state?.device;
    if (!d) { $("volVal").textContent = "–"; return; }
    $("volNote").classList.toggle("hidden", d.supports_volume !== false);
    if (Date.now() - volBusy < 4000) return; // don't fight the user's drag
    if (typeof d.volume_percent === "number") {
      $("vol").value = d.volume_percent;
      $("volVal").textContent = d.volume_percent + "%";
    }
  }
  let volTimer;
  async function setVolume(v) {
    volBusy = Date.now();
    $("vol").value = v; $("volVal").textContent = v + "%";
    try { await sp(`/me/player/volume?volume_percent=${v}`, { method: "PUT" }); }
    catch (e) { toast(e.message); }
  }
  $("vol").addEventListener("input", () => {
    volBusy = Date.now();
    $("volVal").textContent = $("vol").value + "%";
    clearTimeout(volTimer); volTimer = setTimeout(() => setVolume(+$("vol").value), 250);
  });
  $("volMax").addEventListener("click", () => { setVolume(100); toast("Volume MAX 🔊"); });

  // ---------- search + add ----------
  $("searchForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("q").value.trim(); if (!q) return;
    const ul = $("results"); ul.innerHTML = "<li class='muted'>Searching…</li>";
    try {
      const j = await sp(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
      const tracks = j.tracks?.items || [];
      if (!tracks.length) { ul.innerHTML = "<li class='muted'>No results</li>"; return; }
      ul.innerHTML = tracks.map((t, i) => `
        <li><img src="${esc(smallImg(t.album.images))}" alt="">
          <div class="txt"><div>${esc(t.name)}</div><div class="muted">${esc(artists(t))}</div></div>
          <button data-i="${i}">+ Add</button></li>`).join("");
      ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
        const t = tracks[b.dataset.i];
        b.disabled = true;
        try {
          await addSong(t);
          b.textContent = "Added ✓"; toast(`Added "${t.name}"`);
        } catch (e) { toast(e.message); b.disabled = false; }
      }));
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  });

  async function addSong(t) {
    if (!PID) { // no party playlist configured: fall back to Spotify's own queue
      await sp(`/me/player/queue?uri=${encodeURIComponent(t.uri)}`, { method: "POST" });
      return;
    }
    await sp(`/playlists/${PID}/items`, { method: "POST", body: JSON.stringify({ uris: [t.uri] }) });
    await loadQueue();
  }

  // ---------- party queue (a playlist, so it can be reordered) ----------
  async function loadQueue() {
    if (!PID) return loadNativeQueue();
    try {
      let items = [], url = `/playlists/${PID}/items?limit=100&offset=0`;
      for (let page = 0; page < 5 && url; page++) {
        const j = await sp(url);
        items = items.concat(j?.items || []);
        url = j?.next ? j.next.replace(API, "") : null;
      }
      plist = items.map((e) => e.item || e.track).filter(Boolean);
      const meta = await sp(`/playlists/${PID}?fields=snapshot_id`);
      snapshot = meta?.snapshot_id || snapshot;
      computeCurIdx();
      renderQueue();
    } catch (e) { $("queue").innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  function inParty() { return state?.context?.uri === PURI; }

  function computeCurIdx() {
    const uri = state?.item?.uri;
    if (!inParty() || !uri) { curIdx = -1; return; }
    // prefer the occurrence closest to where we last were
    const hits = plist.map((t, i) => (t.uri === uri ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) { curIdx = -1; return; }
    curIdx = hits.find((i) => i >= curIdx) ?? hits[0];
  }

  function renderQueue() {
    if (!PID) return;
    const ul = $("queue");
    $("startBanner").classList.toggle("hidden", inParty() || !plist.length);
    const start = inParty() ? curIdx + 1 : 0;
    const rows = [];
    if (inParty() && curIdx >= 0) {
      const t = plist[curIdx];
      rows.push(`<li class="playing"><img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>▶ ${esc(t.name)}</div><div class="muted">${esc(artists(t))} • now playing</div></div></li>`);
    }
    for (let i = start; i < plist.length; i++) {
      const t = plist[i];
      const first = i === start, last = i === plist.length - 1;
      rows.push(`<li><img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>${i - start + 1}. ${esc(t.name)}</div><div class="muted">${esc(artists(t))}</div></div>
        <div class="qbtns">
          <button data-op="next" data-i="${i}" title="Play next" ${first ? "disabled" : ""}>⤒</button>
          <button data-op="up" data-i="${i}" title="Move up" ${first ? "disabled" : ""}>↑</button>
          <button data-op="down" data-i="${i}" title="Move down" ${last ? "disabled" : ""}>↓</button>
          <button data-op="del" data-i="${i}" class="del" title="Remove">✕</button>
        </div></li>`);
    }
    ul.innerHTML = rows.length > (curIdx >= 0 ? 1 : 0) ? rows.join("") : (rows.join("") + "<li class='muted'>Nothing queued — search for a song above</li>");
    ul.querySelectorAll("button[data-op]").forEach((b) => b.addEventListener("click", () => queueOp(b.dataset.op, +b.dataset.i, start)));
    // party screen "up next"
    const nxt = plist[start];
    $("pNext").textContent = nxt ? `Up next: ${nxt.name} — ${artists(nxt)}` : "";
  }

  async function move(from, insertBefore) {
    const j = await sp(`/playlists/${PID}/items`, {
      method: "PUT", body: JSON.stringify({ range_start: from, insert_before: insertBefore, range_length: 1, snapshot_id: snapshot || undefined })
    });
    if (j?.snapshot_id) snapshot = j.snapshot_id;
  }

  async function queueOp(op, i, start) {
    const t = plist[i];
    try {
      if (op === "up") await move(i, i - 1);
      else if (op === "down") await move(i, i + 2);
      else if (op === "next") await move(i, start);
      else if (op === "del") {
        const j = await sp(`/playlists/${PID}/items`, { method: "DELETE", body: JSON.stringify({ items: [{ uri: t.uri }], snapshot_id: snapshot || undefined }) });
        if (j?.snapshot_id) snapshot = j.snapshot_id;
      }
      toast({ up: "Moved up", down: "Moved down", next: `"${t.name}" plays next`, del: "Removed" }[op]);
    } catch (e) { toast(e.message); }
    loadQueue();
  }

  $("startQueue").addEventListener("click", async () => {
    try {
      await sp("/me/player/shuffle?state=false", { method: "PUT" }).catch(() => {});
      await sp("/me/player/play", { method: "PUT", body: JSON.stringify({ context_uri: PURI, offset: { position: 0 } }) });
      toast("Party queue started 🎉"); curIdx = 0;
      setTimeout(refresh, 900);
    } catch (e) { toast(e.message); }
  });

  $("clearPlayed").addEventListener("click", async () => {
    if (!inParty() || curIdx <= 0) { toast("Nothing played to clear"); return; }
    const current = plist[curIdx]?.uri;
    const played = [...new Set(plist.slice(0, curIdx).map((t) => t.uri))].filter((u) => u !== current);
    try {
      for (let k = 0; k < played.length; k += 100) {
        const chunk = played.slice(k, k + 100).map((uri) => ({ uri }));
        await sp(`/playlists/${PID}/items`, { method: "DELETE", body: JSON.stringify({ items: chunk }) });
      }
      toast("Cleared played songs"); curIdx = 0; loadQueue();
    } catch (e) { toast(e.message); }
  });
  if (!PID) $("clearPlayed").classList.add("hidden");

  // fallback: read-only view of Spotify's built-in queue
  async function loadNativeQueue() {
    const ul = $("queue");
    try {
      const j = await sp("/me/player/queue");
      const items = (j?.queue || []).slice(0, 10);
      ul.innerHTML = items.length ? items.map((t) => `
        <li><img src="${esc(smallImg(t.album?.images || t.images))}" alt="">
          <div class="txt"><div>${esc(t.name)}</div><div class="muted">${esc(artists(t))}</div></div></li>`).join("")
        : "<li class='muted'>Queue is empty</li>";
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  // ---------- lyrics (lrclib.net, free + no key) ----------
  async function loadLyrics() {
    const item = state?.item;
    const box = $("lyrics");
    if (!item || item.type !== "track") { lyr = { key: "", lines: [], plain: "" }; box.innerHTML = "<p class='muted'>No song playing</p>"; setPartyLyric("", ""); return; }
    const key = item.uri; if (lyr.key === key) return;
    lyr = { key, lines: [], plain: "" }; lyrIdx = -2;
    box.innerHTML = "<p class='muted'>Loading lyrics…</p>"; $("lyrSrc").textContent = "";
    const artist = item.artists?.[0]?.name || "";
    let data = null;
    try {
      const qs = new URLSearchParams({ track_name: item.name, artist_name: artist, album_name: item.album?.name || "", duration: Math.round(item.duration_ms / 1000) });
      let r = await fetch("https://lrclib.net/api/get?" + qs);
      if (r.ok) data = await r.json();
      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        r = await fetch("https://lrclib.net/api/search?" + new URLSearchParams({ track_name: item.name, artist_name: artist }));
        const arr = r.ok ? await r.json() : [];
        data = arr.find((x) => x.syncedLyrics) || arr[0] || null;
      }
    } catch { data = null; }
    if (lyr.key !== key) return; // song changed meanwhile
    if (data?.syncedLyrics) {
      lyr.lines = data.syncedLyrics.split("\n").map((l) => {
        const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
        return m ? { t: (+m[1] * 60 + +m[2]) * 1000, text: m[3] } : null;
      }).filter(Boolean);
      box.innerHTML = lyr.lines.map((l, i) => `<p data-i="${i}">${esc(l.text) || "♪"}</p>`).join("");
      $("lyrSrc").textContent = "synced";
    } else if (data?.plainLyrics) {
      lyr.plain = data.plainLyrics;
      box.innerHTML = data.plainLyrics.split("\n").map((l) => `<p>${esc(l) || "&nbsp;"}</p>`).join("");
      $("lyrSrc").textContent = "not synced";
      setPartyLyric("", "");
    } else if (data?.instrumental) {
      box.innerHTML = "<p class='muted'>Instrumental ♪</p>"; setPartyLyric("♪", "");
    } else {
      box.innerHTML = "<p class='muted'>No lyrics found for this song</p>"; setPartyLyric("", "");
    }
    tick();
  }

  function syncLyrics(pos) {
    if (!lyr.lines.length) return;
    let i = -1;
    for (let k = 0; k < lyr.lines.length; k++) { if (lyr.lines[k].t <= pos + 300) i = k; else break; }
    if (i === lyrIdx) return;
    lyrIdx = i;
    const box = $("lyrics");
    box.querySelectorAll("p.cur").forEach((p) => p.classList.remove("cur"));
    const el = box.querySelector(`p[data-i="${i}"]`);
    if (el) { el.classList.add("cur"); box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 2 + el.clientHeight / 2; }
    setPartyLyric(i >= 0 ? lyr.lines[i].text || "♪" : "", lyr.lines[i + 1]?.text || "");
  }
  function setPartyLyric(a, b) { $("pLyric").textContent = a; $("pLyricNext").textContent = b; }

  // ---------- party mode ----------
  $("partyBtn").addEventListener("click", () => {
    $("party").classList.remove("hidden");
    document.documentElement.requestFullscreen?.().catch(() => {});
  });
  const exitParty = () => {
    $("party").classList.add("hidden");
    if (document.fullscreenElement) document.exitFullscreen?.();
  };
  $("partyExit").addEventListener("click", exitParty);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") exitParty(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) $("party").classList.add("hidden"); });

  // ---------- devices ----------
  async function loadDevices() {
    const ul = $("devices");
    try {
      const j = await sp("/me/player/devices");
      const devs = j?.devices || [];
      if (!devs.length) { ul.innerHTML = "<li class='muted'>No speakers online</li>"; return; }
      ul.innerHTML = devs.map((d, i) => `
        <li><div class="txt"><div class="${d.is_active ? "active-dev" : ""}">${esc(d.name)}${d.is_active ? " • playing here" : ""}</div>
          <div class="muted">${esc(d.type)}${typeof d.volume_percent === "number" ? " • vol " + d.volume_percent + "%" : ""}</div></div>
          ${d.is_active ? "" : `<button class="ghost" data-i="${i}">Play here</button>`}</li>`).join("");
      ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
        try {
          await sp("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [devs[b.dataset.i].id], play: true }) });
          toast("Switched speaker"); setTimeout(() => { loadDevices(); refresh(); }, 800);
        } catch (e) { toast(e.message); }
      }));
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  // ---------- start ----------
  function start() {
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("partyBtn").classList.remove("hidden");
    refresh(); loadQueue(); loadDevices();
    setInterval(refresh, 4000);
    setInterval(loadQueue, 12000);
    setInterval(loadDevices, 30000);
    setInterval(tick, 250);
  }

  const unlocked = () => { try { return localStorage.getItem("auxCode") === C.accessCode; } catch { return false; } };
  if (!C.accessCode || unlocked()) start();
  else {
    $("gate").classList.remove("hidden");
    $("gateForm").addEventListener("submit", (ev) => {
      ev.preventDefault();
      if ($("gateInput").value === C.accessCode) {
        try { localStorage.setItem("auxCode", C.accessCode); } catch {}
        start();
      } else $("gateMsg").textContent = "Wrong code";
    });
  }
})();
