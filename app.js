(() => {
  const C = window.AUX_CONFIG || {};
  const API = "https://api.spotify.com/v1";
  const PID = C.playlistId || "";
  const PURI = PID ? "spotify:playlist:" + PID : "";
  const $ = (id) => document.getElementById(id);

  let token = null, tokenExp = 0;
  let state = null, lastFetch = 0;          // player state
  let plist = [], snapshot = null, curIdx = -1, lastQueueUri = "", cleaning = false; // shared-queue playlist
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
    const r = await fetch(API + path, { cache: "no-store", ...opts, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) {
      const msg = j?.error?.message || r.statusText;
      if (r.status === 404 && path.startsWith("/me/player")) throw new Error("Nothing is playing on the Echo — tap a song to start");
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
      renderSpeakerNotice();
      if (state?.item?.uri !== prevUri) { loadLyrics(); loadQueue(); if (simFor) loadSimilar(); }
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
    tick();
  }

  function tick() {
    const item = state?.item; if (!item) return;
    const pos = position();
    $("tNow").textContent = fmt(pos);
    const pct = (100 * pos / item.duration_ms) + "%";
    $("progress").style.width = pct;
    syncLyrics(pos);
    if (state.is_playing && pos >= item.duration_ms && Date.now() - lastFetch > 1500) refresh();
  }

  // ---------- controls ----------
  const actions = {
    next: async () => (!inQueue() && upcomingStart() < plist.length)
      ? startQueueAt(upcomingStart())
      : sp("/me/player/next" + await deviceParam(), { method: "POST" }),
    previous: async () => sp("/me/player/previous" + await deviceParam(), { method: "POST" }),
    restart: async () => sp("/me/player/seek" + await deviceParam("?position_ms=0"), { method: "PUT" }),
    toggle: async () => {
      if (state?.is_playing) return sp("/me/player/pause" + await deviceParam(), { method: "PUT" });
      if (!inQueue() && upcomingStart() < plist.length) return startQueueAt(upcomingStart());
      return sp("/me/player/play" + await deviceParam(), { method: "PUT" });
    },
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
    try { await sp("/me/player/volume" + await deviceParam(`?volume_percent=${v}`), { method: "PUT" }); }
    catch (e) { toast(e.message); }
  }
  $("vol").addEventListener("input", () => {
    volBusy = Date.now();
    $("volVal").textContent = $("vol").value + "%";
    clearTimeout(volTimer); volTimer = setTimeout(() => setVolume(+$("vol").value), 250);
  });
  $("volMax").addEventListener("click", () => { setVolume(100); toast("Volume MAX 🔊"); });

  // ---------- song lists: tap a row = play now, queue icon = add to queue ----------
  const QICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-2v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>`;
  function renderTracks(ul, tracks) {
    ul.innerHTML = tracks.map((t, i) => `
      <li class="song" data-i="${i}" title="Tap to play now">
        <img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>${esc(t.name)}</div><div class="muted">${esc(artists(t))}</div></div>
        <span class="play-hint">▶</span>
        <button class="qbtn" data-i="${i}" title="Add to queue" aria-label="Add to queue">${QICON}</button></li>`).join("");
    ul.querySelectorAll("li.song").forEach((li) => li.addEventListener("click", async (ev) => {
      if (ev.target.closest("button")) return;
      if (li.classList.contains("busy")) return;
      const t = tracks[li.dataset.i];
      li.classList.add("busy");
      try { await playNow(t); toast(`▶ Playing "${t.name}"`); setTimeout(refresh, 900); }
      catch (e) { toast(e.message); }
      li.classList.remove("busy");
    }));
    ul.querySelectorAll("button.qbtn").forEach((b) => b.addEventListener("click", async () => {
      const t = tracks[b.dataset.i];
      b.disabled = true;
      try { await addSong(t); b.textContent = "✓"; toast(`Queued "${t.name}"`); }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
  }

  $("searchForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = $("q").value.trim(); if (!q) return;
    const ul = $("results"); ul.innerHTML = "<li class='muted'>Searching…</li>";
    try {
      const j = await sp(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
      const tracks = j.tracks?.items || [];
      if (!tracks.length) { ul.innerHTML = "<li class='muted'>No results</li>"; return; }
      renderTracks(ul, tracks);
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  });

  async function addSong(t) {
    if (!PID) { // no party playlist configured: fall back to Spotify's own queue
      await sp(`/me/player/queue?uri=${encodeURIComponent(t.uri)}`, { method: "POST" });
      return;
    }
    await sp(`/playlists/${PID}/items`, { method: "POST", body: JSON.stringify({ uris: [t.uri] }) });
    await loadQueue();
    if (!state?.is_playing) setTimeout(() => toast("Queued — press ▶ to start the music"), 1200);
  }

  // Everything only ever plays on the Echo Plus.
  const SPEAKER = C.speakerName || "Echo Plus";
  let echoCache = { id: "", at: 0 };
  async function echoId(force) {
    if (!force && echoCache.id && Date.now() - echoCache.at < 60000) return echoCache.id;
    const d = (await sp("/me/player/devices"))?.devices || [];
    const want = SPEAKER.toLowerCase();
    const pick = d.find((x) => x.name.toLowerCase().includes(want)) || d.find((x) => /echo|alexa/i.test(x.name));
    if (!pick) throw new Error(`The ${SPEAKER} is offline — say "Alexa, play Spotify" once to wake it up`);
    echoCache = { id: pick.id, at: Date.now() };
    return pick.id;
  }
  async function deviceParam(extra) {
    const id = await echoId();
    return (extra ? extra + "&" : "?") + "device_id=" + id;
  }
  const onEcho = () => !state?.device || (echoCache.id ? state.device.id === echoCache.id : /echo|alexa/i.test(state.device.name));

  // Play a song right now. It's slotted in right after the current song in the shared
  // queue, so everything that was queued still plays afterwards.
  async function playNow(t) {
    const dev = await deviceParam();
    if (!PID) {
      await sp("/me/player/play" + dev, { method: "PUT", body: JSON.stringify({ uris: [t.uri] }) });
      return;
    }
    const pos = upcomingStart();
    await sp(`/playlists/${PID}/items`, { method: "POST", body: JSON.stringify({ uris: [t.uri], position: pos }) });
    await sp("/me/player/play" + dev, { method: "PUT", body: JSON.stringify({ context_uri: PURI, offset: { uri: t.uri } }) });
    curIdx = pos;
    deviceParam("?state=false").then((q) => sp("/me/player/shuffle" + q, { method: "PUT" })).catch(() => {});
    loadQueue();
  }

  // ---------- more like this (Deezer artist radio -> matched on Spotify) ----------
  const jsonp = (url) => new Promise((res, rej) => {
    const cb = "dz" + Math.floor(Math.random() * 1e9);
    const s = document.createElement("script");
    const done = () => { delete window[cb]; s.remove(); };
    window[cb] = (d) => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error("Couldn't reach the suggestions service")); };
    s.src = url + (url.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
    document.head.appendChild(s);
    setTimeout(() => rej(new Error("Suggestions timed out")), 9000);
  });
  let simFor = "";
  async function loadSimilar(force) {
    const item = state?.item;
    const ul = $("similar");
    if (!item || item.type !== "track") { ul.innerHTML = "<li class='muted'>Play something first</li>"; return; }
    if (!force && simFor === item.uri) return;
    simFor = item.uri;
    ul.innerHTML = "<li class='muted'>Finding similar songs…</li>";
    try {
      const mainArtist = item.artists?.[0]?.name || "";
      const a = await jsonp("https://api.deezer.com/search/artist?limit=1&q=" + encodeURIComponent(mainArtist));
      const aid = a?.data?.[0]?.id; if (!aid) throw new Error("No suggestions for this artist");
      const radio = await jsonp(`https://api.deezer.com/artist/${aid}/radio?limit=40`);
      let picks = (radio?.data || []).filter((x) => x.title_short.toLowerCase() !== item.name.toLowerCase());
      // favour other artists, keep a couple from the same one, shuffle for variety
      const other = picks.filter((x) => x.artist.name.toLowerCase() !== mainArtist.toLowerCase());
      const same = picks.filter((x) => x.artist.name.toLowerCase() === mainArtist.toLowerCase());
      const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
      picks = shuffle([...shuffle(other).slice(0, 6), ...shuffle(same).slice(0, 2)]);
      const found = await Promise.all(picks.map((x) =>
        sp(`/search?type=track&limit=1&q=${encodeURIComponent(`track:${x.title_short} artist:${x.artist.name}`)}`)
          .then((j) => j?.tracks?.items?.[0]).catch(() => null)));
      if (simFor !== item.uri) return;
      const seen = new Set();
      const tracks = found.filter((t) => t && !seen.has(t.uri) && seen.add(t.uri));
      if (!tracks.length) { ul.innerHTML = "<li class='muted'>No suggestions found</li>"; return; }
      renderTracks(ul, tracks);
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; simFor = ""; }
  }
  $("simBtn").addEventListener("click", () => { $("simBtn").textContent = "↻ Refresh"; loadSimilar(true); });

  // ---------- shared queue (a playlist, so it can be reordered) ----------
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
      cleanPlayed();
    } catch (e) { $("queue").innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  function inQueue() { return state?.context?.uri === PURI; }

  function computeCurIdx() {
    const uri = state?.item?.uri;
    if (!inQueue() || !uri) { curIdx = -1; return; }
    // prefer the occurrence closest to where we last were
    const hits = plist.map((t, i) => (t.uri === uri ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) { curIdx = -1; return; }
    curIdx = hits.find((i) => i >= curIdx) ?? hits[0];
    lastQueueUri = uri;
  }

  // Index of the first song that hasn't played yet.
  function upcomingStart() {
    if (inQueue() && curIdx >= 0) return curIdx + 1;
    const first = plist[0]?.uri;
    return first && (first === lastQueueUri || first === state?.item?.uri) ? 1 : 0;
  }

  // Played songs remove themselves so the queue only ever shows what's next.
  async function cleanPlayed() {
    if (cleaning || !PID) return;
    const start = upcomingStart();
    const keepFrom = inQueue() && curIdx >= 0 ? curIdx : start;
    if (keepFrom <= 0) return;
    const keep = new Set(plist.slice(keepFrom).map((t) => t.uri));
    const played = [...new Set(plist.slice(0, keepFrom).map((t) => t.uri))].filter((u) => !keep.has(u));
    if (!played.length) return;
    cleaning = true;
    try {
      for (let k = 0; k < played.length; k += 100) {
        await sp(`/playlists/${PID}/items`, { method: "DELETE", body: JSON.stringify({ items: played.slice(k, k + 100).map((uri) => ({ uri })) }) });
      }
    } catch { /* another viewer probably cleaned it already */ }
    cleaning = false;
    setTimeout(loadQueue, 800);
  }

  async function startQueueAt(pos) {
    const dev = await deviceParam();
    const uri = plist[pos]?.uri;
    await sp("/me/player/play" + dev, { method: "PUT", body: JSON.stringify({ context_uri: PURI, offset: uri ? { uri } : { position: pos } }) });
    curIdx = pos;
    deviceParam("?state=false").then((q) => sp("/me/player/shuffle" + q, { method: "PUT" })).catch(() => {});
    setTimeout(refresh, 900);
  }

  function renderQueue() {
    if (!PID) return;
    const ul = $("queue");
    const start = upcomingStart();
    const rows = [];
    if (inQueue() && curIdx >= 0) {
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
    ul.innerHTML = start < plist.length ? rows.join("") : (rows.join("") + "<li class='muted'>Nothing queued — search for a song above</li>");
    ul.querySelectorAll("button[data-op]").forEach((b) => b.addEventListener("click", () => queueOp(b.dataset.op, +b.dataset.i, start)));
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
    if (!item || item.type !== "track") { lyr = { key: "", lines: [], plain: "" }; box.innerHTML = "<p class='muted'>No song playing</p>"; return; }
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
     
    } else if (data?.instrumental) {
      box.innerHTML = "<p class='muted'>Instrumental ♪</p>";
    } else {
      box.innerHTML = "<p class='muted'>No lyrics found for this song</p>";
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
  }

  // ---------- keep it on the Echo ----------
  function renderSpeakerNotice() {
    const other = state?.device && !onEcho();
    $("echoNotice").classList.toggle("hidden", !other);
    if (other) $("echoNoticeTxt").textContent = `Music is playing on "${state.device.name}", not the ${SPEAKER}.`;
  }
  $("moveToEcho").addEventListener("click", async () => {
    try {
      await sp("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [await echoId(true)], play: true }) });
      toast(`Moved to the ${SPEAKER}`); setTimeout(refresh, 900);
    } catch (e) { toast(e.message); }
  });

  window.auxDebug = { sp }; // handy for troubleshooting from the browser console

  // ---------- start ----------
  function start() {
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    refresh(); loadQueue(); echoId().catch(() => {});
    setInterval(refresh, 4000);
    setInterval(loadQueue, 12000);
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
