(() => {
  const C = window.AUX_CONFIG || {};
  const API = "https://api.spotify.com/v1";
  const $ = (id) => document.getElementById(id);
  let token = null, tokenExp = 0, state = null, lastFetch = 0;

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

  // ---------- auth ----------
  async function getToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    if (!C.clientId || !C.refreshToken) throw new Error("Site not set up yet — open setup.html");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: C.refreshToken });
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (C.clientSecret) headers.Authorization = "Basic " + btoa(C.clientId + ":" + C.clientSecret);
    else body.set("client_id", C.clientId);
    const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers, body });
    const j = await r.json();
    if (!r.ok) throw new Error("Spotify login expired — Ben needs to re-run setup (" + (j.error_description || j.error) + ")");
    token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function sp(path, opts = {}) {
    const t = await getToken();
    const r = await fetch(API + path, { ...opts, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const msg = j?.error?.message || r.statusText;
      if (r.status === 404) throw new Error("No active speaker — pick one under Speaker");
      throw new Error(msg);
    }
    return j;
  }

  // ---------- now playing ----------
  async function refresh() {
    try {
      state = await sp("/me/player?additional_types=episode");
      lastFetch = Date.now();
      renderNow();
    } catch (e) { $("title").textContent = e.message; }
  }

  function renderNow() {
    const item = state?.item;
    $("title").textContent = item ? item.name : "Nothing playing";
    $("artist").textContent = item ? (item.artists || []).map((a) => a.name).join(", ") || item.show?.name || "" : "";
    const img = item ? bigImg(item.album?.images || item.images) : "";
    if (img && $("art").src !== img) $("art").src = img;
    $("tDur").textContent = fmt(item?.duration_ms);
    $("playBtn").firstChild.textContent = state?.is_playing ? "⏸" : "▶";
    tick();
  }

  function tick() {
    const item = state?.item; if (!item) return;
    let pos = state.progress_ms || 0;
    if (state.is_playing) pos += Date.now() - lastFetch;
    pos = Math.min(pos, item.duration_ms);
    $("tNow").textContent = fmt(pos);
    $("progress").style.width = (100 * pos / item.duration_ms) + "%";
    if (state.is_playing && pos >= item.duration_ms) { refresh(); loadQueue(); }
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
      setTimeout(() => { refresh(); loadQueue(); }, 600);
    })
  );

  // ---------- search + queue ----------
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
          <div class="txt"><div>${esc(t.name)}</div><div class="muted">${esc(t.artists.map((a) => a.name).join(", "))}</div></div>
          <button data-i="${i}">+ Queue</button></li>`).join("");
      ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
        const t = tracks[b.dataset.i];
        b.disabled = true;
        try {
          await sp(`/me/player/queue?uri=${encodeURIComponent(t.uri)}`, { method: "POST" });
          b.textContent = "Added ✓"; toast(`Queued "${t.name}"`); loadQueue();
        } catch (e) { toast(e.message); b.disabled = false; }
      }));
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  });

  async function loadQueue() {
    const ul = $("queue");
    try {
      const j = await sp("/me/player/queue");
      const items = (j?.queue || []).slice(0, 10);
      ul.innerHTML = items.length ? items.map((t) => `
        <li><img src="${esc(smallImg(t.album?.images || t.images))}" alt="">
          <div class="txt"><div>${esc(t.name)}</div><div class="muted">${esc((t.artists || []).map((a) => a.name).join(", "))}</div></div></li>`).join("")
        : "<li class='muted'>Queue is empty</li>";
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  // ---------- devices ----------
  async function loadDevices() {
    const ul = $("devices");
    try {
      const j = await sp("/me/player/devices");
      const devs = j?.devices || [];
      if (!devs.length) { ul.innerHTML = "<li class='muted'>No speakers online</li>"; return; }
      ul.innerHTML = devs.map((d, i) => `
        <li><div class="txt"><div class="${d.is_active ? "active-dev" : ""}">${esc(d.name)}${d.is_active ? " • playing here" : ""}</div>
          <div class="muted">${esc(d.type)}</div></div>
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
    refresh(); loadQueue(); loadDevices();
    setInterval(refresh, 5000);
    setInterval(loadQueue, 15000);
    setInterval(loadDevices, 30000);
    setInterval(tick, 1000);
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
