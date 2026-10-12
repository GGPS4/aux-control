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
  let seeking = false; // true while someone is dragging the song position slider

  // ---------- host settings (shared with everyone through the queue playlist's description) ----------
  // Stored as "AUX[key=value,...]" so every open page picks them up on its next queue check.
  const DEFAULTS = { lp: 0, lv: 0, la: 0, lq: 0, np: 0, ab: 0, dp: 0, ex: 0, hr: 0, mv: 100, m: "" };
  const LOCK_NAMES = { lp: "skip, pause and seeking", lv: "volume", la: "adding songs", lq: "moving and removing songs" };
  let S = { ...DEFAULTS };
  let admin = false;
  const can = (k) => admin || !S[k];
  const guard = (k) => { if (can(k)) return true; toast(`🔒 The host locked ${LOCK_NAMES[k]}`); return false; };
  const decodeEntities = (str) => { const t = document.createElement("textarea"); t.innerHTML = str; return t.value; };
  function parseSettings(desc) {
    const out = { ...DEFAULTS };
    const m = decodeEntities(desc || "").match(/AUX\[([^\]]*)\]/);
    if (!m) return out;
    for (const kv of m[1].split(",")) {
      const i = kv.indexOf("="); if (i < 0) continue;
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!(k in DEFAULTS)) continue;
      if (k === "m") { try { out.m = decodeURIComponent(v); } catch { out.m = ""; } }
      else out[k] = +v || 0;
    }
    out.mv = Math.min(100, Math.max(10, out.mv || 100));
    return out;
  }
  function serializeSettings(x) {
    const parts = Object.keys(DEFAULTS).filter((k) => k !== "m" && x[k] !== DEFAULTS[k]).map((k) => `${k}=${x[k]}`);
    const head = "Shared queue for Aux Control. Host settings: ";
    let msg = (x.m || "").slice(0, 80), enc;
    // Spotify descriptions max out at 300 characters; shorten the message until it fits
    while ((enc = head + `AUX[${[...parts, ...(msg ? ["m=" + encodeURIComponent(msg)] : [])].join(",")}]`).length > 300) msg = msg.slice(0, -1);
    return enc;
  }

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
  const clock = (msFromNow) => new Date(Date.now() + msFromNow).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const longDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`; };
  const eta = (ms) => ms < 15000 ? "up next" : state?.is_playing ? `~${clock(ms)}` : `in ${longDur(ms)} of music`;
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
      const prev = state, prevPos = position();
      const prevUri = prev?.item?.uri;
      state = await sp("/me/player?additional_types=episode");
      lastFetch = Date.now();
      checkMissedHandoff(prev, prevPos);
      renderNow();
      renderVolume();
      renderSpeakerNotice();
      if (state?.item?.uri !== prevUri) { loadLyrics(); loadQueue(); if (simFor) loadSimilar(); setTimeout(loadRecent, 3000); }
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
    $("seek").disabled = !item || !can("lp");
    if (!item) { seeking = false; showPos(0, 1); }
    $("playBtn").querySelector("b").textContent = state?.is_playing ? "⏸" : "▶";
    tick();
  }

  function tick() {
    const item = state?.item; if (!item) return;
    const pos = position();
    if (!seeking) showPos(pos, item.duration_ms);
    syncLyrics(pos);
    if (state.is_playing && pos >= item.duration_ms && Date.now() - lastFetch > 1500) refresh();
    // Something Alexa started is about to finish -> hand the Echo over to the shared queue.
    if (outsideQueue() && item.duration_ms - pos < 2500 && handoffFor !== item.uri) {
      handoffFor = item.uri;
      handoff(item.uri);
    }
  }

  // ---------- Alexa requests: let the song finish, then go back to the shared queue ----------
  let handoffFor = "", manualUntil = 0;
  const outsideQueue = () => PID && state?.is_playing && state?.item && !inQueue() && onEcho() && upcomingStart() < plist.length;

  async function handoff(uri, missed) {
    // small random delay so several open pages don't all fire at once
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 900));
    try {
      const fresh = await sp("/me/player?additional_types=episode");
      if (!fresh?.item || fresh.context?.uri === PURI) return;         // someone already switched
      if (!missed && fresh.item.uri === uri && fresh.item.duration_ms - fresh.progress_ms > 6000) { handoffFor = ""; return; } // rewound
      state = fresh; lastFetch = Date.now();
      await loadQueue();
      const pos = upcomingStart();
      if (pos >= plist.length) return;
      await startQueueAt(pos);
      toast("Back to the shared queue ▶");
    } catch (e) { handoffFor = ""; }
  }

  // If this page was asleep when the song ended, catch it on the next check:
  // the previous Alexa song was near its end and now a different non-queue song is playing.
  function checkMissedHandoff(prev, prevPos) {
    if (!prev?.is_playing || !prev.item || prev.context?.uri === PURI || Date.now() < manualUntil) return;
    if (!state?.item || state.item.uri === prev.item.uri || !outsideQueue()) return;
    if (prev.item.duration_ms - prevPos > 20000) return; // it was changed mid-song (e.g. "Alexa, play…"), not finished
    if (handoffFor === prev.item.uri) return;
    handoffFor = prev.item.uri;
    handoff(state.item.uri, true);
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
      if (!guard("lp")) return;
      manualUntil = Date.now() + 8000;
      b.disabled = true;
      try { await actions[b.dataset.act](); toast(labels[b.dataset.act]); }
      catch (e) { toast(e.message); }
      b.disabled = false;
      setTimeout(refresh, 700);
    })
  );

  // ---------- song position: drag the bar to jump around in the song ----------
  function showPos(pos, dur) {
    const frac = dur ? Math.min(1, Math.max(0, pos / dur)) : 0;
    const seek = $("seek");
    seek.value = Math.round(frac * 1000);
    seek.style.setProperty("--pct", (frac * 100) + "%");
    $("tNow").textContent = fmt(pos);
  }
  let seekSafety;
  const seekMs = () => Math.round((+$("seek").value / 1000) * (state?.item?.duration_ms || 0));
  $("seek").addEventListener("input", () => {
    // while dragging, just preview the time; the jump happens when the finger lets go
    if (!state?.item) return;
    seeking = true;
    clearTimeout(seekSafety); seekSafety = setTimeout(() => { seeking = false; }, 10000); // in case "change" never fires
    const ms = seekMs();
    $("seek").style.setProperty("--pct", ($("seek").value / 10) + "%");
    $("tNow").textContent = fmt(ms);
  });
  $("seek").addEventListener("change", async () => {
    const item = state?.item;
    if (!item || !guard("lp")) { seeking = false; tick(); return; }
    const ms = Math.min(seekMs(), item.duration_ms - 1000);
    manualUntil = Date.now() + 8000;
    try {
      await sp("/me/player/seek" + await deviceParam(`?position_ms=${Math.max(0, ms)}`), { method: "PUT" });
      if (state?.item?.uri === item.uri) { state.progress_ms = Math.max(0, ms); lastFetch = Date.now(); }
      toast(`Jumped to ${fmt(ms)}`);
    } catch (e) { toast(e.message); }
    seeking = false; clearTimeout(seekSafety);
    tick();
    setTimeout(refresh, 900);
  });

  // ---------- volume (0–100 = full range of the speaker) ----------
  function renderVolume() {
    const d = state?.device;
    if (!d) { $("volVal").textContent = "–"; return; }
    $("volNote").classList.toggle("hidden", d.supports_volume !== false);
    renderVolumeLimit();
    if (Date.now() - volBusy < 4000) return; // don't fight the user's drag
    if (typeof d.volume_percent === "number") {
      $("vol").value = d.volume_percent;
      $("volVal").textContent = d.volume_percent + "%";
    }
  }
  const volCap = () => (admin ? 100 : S.mv);
  function renderVolumeLimit() {
    const cap = volCap(), locked = !can("lv");
    $("vol").max = cap; $("vol").disabled = locked; $("volMax").disabled = locked;
    $("volMax").textContent = cap < 100 ? `MAX (${cap}%)` : "MAX";
    const note = locked ? "🔒 The host locked the volume." : (cap < 100 ? `The host set the volume limit to ${cap}%.` : "");
    $("volLimit").textContent = note; $("volLimit").classList.toggle("hidden", !note);
  }
  let volTimer;
  async function setVolume(v) {
    if (!guard("lv")) { renderVolume(); return; }
    v = Math.min(v, volCap());
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
  $("volMax").addEventListener("click", () => { if (!guard("lv")) return; setVolume(volCap()); toast("Volume MAX 🔊"); });

  // ---------- song lists: tap a row = play now, queue icon = add to queue ----------
  const QICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-2v-3h2v3h3v2h-3v3h-2v-3h-3v-2z"/></svg>`;
  const playNowAllowed = () => admin || !S.np;
  const explicitBlocked = (t) => !admin && S.ex && t?.explicit;
  // Songs that are already coming up (or playing right now).
  const isQueued = (uri) => plist.slice(upcomingStart()).some((t) => t.uri === uri);
  const isPlayingNow = (uri) => state?.item?.uri === uri;

  // Add with the duplicate check: warn once (tap again to add anyway), or block if the host says so.
  async function tryAdd(t, el) {
    if (!guard("la")) return false;
    if (explicitBlocked(t)) { toast("The host blocked explicit songs"); return false; }
    const dupe = isQueued(t.uri) || isPlayingNow(t.uri);
    if (dupe) {
      const where = isPlayingNow(t.uri) ? "playing right now" : "already in the queue";
      if (!admin && S.dp) { toast(`"${t.name}" is ${where}`); return false; }
      if (el && el.dataset.confirm !== "1") {
        el.dataset.confirm = "1"; el.classList.add("warn");
        toast(`"${t.name}" is ${where}. Tap again to add it anyway`);
        setTimeout(() => { el.dataset.confirm = ""; el.classList.remove("warn"); }, 4000);
        return false;
      }
    }
    await addSong(t);
    toast(`Queued "${t.name}"`);
    return true;
  }

  function renderTracks(ul, tracks, opts = {}) {
    tracks = tracks.filter((t) => !explicitBlocked(t));
    if (!tracks.length) { ul.innerHTML = `<li class='muted'>${opts.empty || "No songs"}</li>`; return; }
    const pn = playNowAllowed();
    ul.innerHTML = (opts.head || "") + tracks.map((t, i) => `
      <li class="song" data-i="${i}" title="${pn ? "Tap to play now" : "Tap to add to the queue"}">
        <img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>${t.explicit ? '<span class="tag e" title="Explicit">E</span>' : ""}${esc(t.name)}</div>
          <div class="muted">${esc(artists(t))}${opts.sub ? " • " + esc(opts.sub(t)) : ""}${isQueued(t.uri) ? ' <span class="tag q">in queue</span>' : ""}</div></div>
        ${pn ? '<span class="play-hint">▶</span>' : ""}
        <button class="qbtn" data-i="${i}" title="Add to queue" aria-label="Add to queue">${QICON}</button></li>`).join("");
    ul.querySelectorAll("li.song").forEach((li) => li.addEventListener("click", async (ev) => {
      if (ev.target.closest("button")) return;
      if (li.classList.contains("busy")) return;
      const t = tracks[li.dataset.i];
      if (!playNowAllowed()) { // host turned off Play now: tapping a row queues it instead
        li.classList.add("busy");
        try { await tryAdd(t, li); } catch (e) { toast(e.message); }
        li.classList.remove("busy");
        return;
      }
      if (!guard("la")) return;
      if (explicitBlocked(t)) { toast("The host blocked explicit songs"); return; }
      li.classList.add("busy");
      try { await playNow(t); toast(`▶ Playing "${t.name}"`); setTimeout(refresh, 900); }
      catch (e) { toast(e.message); }
      li.classList.remove("busy");
    }));
    ul.querySelectorAll("button.qbtn").forEach((b) => b.addEventListener("click", async () => {
      const t = tracks[b.dataset.i];
      b.disabled = true;
      try { if (await tryAdd(t, b)) { b.textContent = "✓"; return; } }
      catch (e) { toast(e.message); }
      b.disabled = false;
    }));
    opts.after?.(ul);
  }

  // ---------- add music: songs, whole albums, or the host's playlists ----------
  let mode = "track";
  const PLACEHOLDER = { track: "Search songs…", album: "Search albums…", playlist: "Filter the host's playlists…" };
  document.querySelectorAll("#searchTabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  function setMode(m) {
    if (m !== "track" && !admin && S.ab) { toast("The host turned off adding albums and playlists"); m = "track"; }
    mode = m;
    document.querySelectorAll("#searchTabs button").forEach((b) => { b.classList.toggle("on", b.dataset.mode === m); b.setAttribute("aria-selected", b.dataset.mode === m); });
    $("q").placeholder = PLACEHOLDER[m];
    $("results").innerHTML = "";
    renderAddHint();
    if (m === "playlist") runSearch();
    else if ($("q").value.trim()) runSearch();
  }
  function renderAddHint() {
    $("addHint").innerHTML = mode !== "track" ? "Tap one to see its songs • tap <b>Add all</b> to queue every song"
      : !can("la") ? "🔒 The host locked adding songs"
      : playNowAllowed() ? 'Tap a song to play it now • tap <span class="qicon-inline">≡+</span> to add it to the queue'
      : 'Tap a song or <span class="qicon-inline">≡+</span> to add it to the queue';
  }
  $("searchForm").addEventListener("submit", (ev) => { ev.preventDefault(); runSearch(); });

  async function runSearch() {
    const q = $("q").value.trim();
    const ul = $("results");
    if (!q && mode !== "playlist") return;
    ul.innerHTML = "<li class='muted'>Searching…</li>";
    try {
      if (mode === "track") {
        const j = await sp(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
        renderTracks(ul, j.tracks?.items || [], { empty: "No results" });
      } else if (mode === "album") {
        const j = await sp(`/search?type=album&limit=10&q=${encodeURIComponent(q)}`);
        renderCollections(ul, (j.albums?.items || []).filter(Boolean), "album");
      } else {
        const mine = await myPlaylists();
        const ql = q.toLowerCase();
        renderCollections(ul, mine.filter((p) => !ql || p.name.toLowerCase().includes(ql)), "playlist");
      }
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  let plCache = { at: 0, list: [] };
  async function myPlaylists() {
    if (Date.now() - plCache.at < 60000) return plCache.list;
    let list = [], url = "/me/playlists?limit=50";
    for (let page = 0; page < 4 && url; page++) {
      const j = await sp(url);
      list = list.concat((j?.items || []).filter(Boolean));
      url = j?.next ? j.next.replace(API, "") : null;
    }
    list = list.filter((p) => p.id !== PID);
    plCache = { at: Date.now(), list };
    return list;
  }

  const countOf = (c) => c.total_tracks ?? (c.items || c.tracks)?.total ?? 0;
  function renderCollections(ul, items, kind) {
    if (!items.length) { ul.innerHTML = `<li class='muted'>${kind === "album" ? "No albums found" : "No playlists found"}</li>`; return; }
    ul.innerHTML = items.map((c, i) => {
      const sub = kind === "album"
        ? `${artists(c)} • ${(c.release_date || "").slice(0, 4)} • ${countOf(c)} songs`
        : `${countOf(c)} songs`;
      return `<li class="song coll" data-i="${i}" title="See the songs">
        <img src="${esc(smallImg(c.images))}" alt="">
        <div class="txt"><div>${esc(c.name)}</div><div class="muted">${esc(sub)}</div></div>
        <button class="small addall" data-i="${i}">Add all</button></li>`;
    }).join("");
    ul.querySelectorAll("li.coll").forEach((li) => li.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      openCollection(ul, items[li.dataset.i], kind, () => renderCollections(ul, items, kind));
    }));
    ul.querySelectorAll("button.addall").forEach((b) => b.addEventListener("click", () => addCollection(items[b.dataset.i], kind, b)));
  }

  async function collectionTracks(c, kind) {
    let out = [];
    if (kind === "album") {
      let url = `/albums/${c.id}/tracks?limit=50`;
      for (let page = 0; page < 4 && url; page++) {
        const j = await sp(url);
        out = out.concat((j?.items || []).map((t) => ({ ...t, album: { images: c.images, name: c.name } })));
        url = j?.next ? j.next.replace(API, "") : null;
      }
    } else {
      let url = `/playlists/${c.id}/items?limit=100`;
      for (let page = 0; page < 3 && url; page++) {
        const j = await sp(url);
        out = out.concat((j?.items || []).map((e) => e.item || e.track));
        url = j?.next ? j.next.replace(API, "") : null;
      }
    }
    return out.filter((t) => t && t.uri && t.type !== "episode" && !t.is_local);
  }

  async function openCollection(ul, c, kind, back) {
    ul.innerHTML = "<li class='muted'>Loading songs…</li>";
    try {
      const tracks = await collectionTracks(c, kind);
      const head = `<li class="coll-head"><button class="ghost small back">← Back</button>
        <div class="txt"><div>${esc(c.name)}</div><div class="muted">${tracks.length} songs</div></div>
        <button class="small addall-open">Add all</button></li>`;
      renderTracks(ul, tracks, { head, empty: "No playable songs in here", after: (u) => {
        u.querySelector(".back")?.addEventListener("click", back);
        u.querySelector(".addall-open")?.addEventListener("click", (ev) => addCollection(c, kind, ev.currentTarget, tracks));
      } });
      if (!ul.querySelector(".coll-head")) { ul.insertAdjacentHTML("afterbegin", head); ul.querySelector(".back").addEventListener("click", back); ul.querySelector(".addall-open")?.remove(); }
    } catch (e) { ul.innerHTML = `<li class='muted'>${esc(e.message)}</li>`; }
  }

  // Queue every song from an album or playlist (skipping blocked and already-queued songs).
  async function addCollection(c, kind, btn, tracks) {
    if (!guard("la")) return;
    if (!admin && S.ab) { toast("The host turned off adding albums and playlists"); return; }
    btn.disabled = true; const label = btn.textContent; btn.textContent = "Adding…";
    try {
      tracks = tracks || await collectionTracks(c, kind);
      const queued = new Set(plist.slice(upcomingStart()).map((t) => t.uri));
      const seen = new Set();
      let skipped = 0;
      const add = tracks.filter((t) => {
        if (explicitBlocked(t) || queued.has(t.uri) || seen.has(t.uri)) { skipped++; return false; }
        seen.add(t.uri); return true;
      }).slice(0, 100);
      if (!add.length) { toast("Everything in there is already queued"); btn.textContent = label; btn.disabled = false; return; }
      if (PID) {
        await sp(`/playlists/${PID}/items`, { method: "POST", body: JSON.stringify({ uris: add.map((t) => t.uri) }) });
        await loadQueue();
      } else {
        for (const t of add.slice(0, 20)) await sp(`/me/player/queue?uri=${encodeURIComponent(t.uri)}`, { method: "POST" });
      }
      btn.textContent = "✓ Added";
      toast(`Queued ${add.length} songs from "${c.name}"${skipped ? ` (skipped ${skipped})` : ""}`);
      if (!state?.is_playing) setTimeout(() => toast("Queued — press ▶ to start the music"), 1800);
    } catch (e) { toast(e.message); btn.textContent = label; btn.disabled = false; }
  }

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
    // Already playing the shared queue: re-sending play for the same playlist makes the Echo
    // use its cached copy (without the new song) and just restart the current track.
    // Instead drop the song into Spotify's own up-next and skip to it; the shared queue
    // carries on from where it was once the song ends.
    if (inQueue() && state?.item && onEcho()) {
      await sp(`/me/player/queue?uri=${encodeURIComponent(t.uri)}&` + dev.slice(1), { method: "POST" });
      await sp("/me/player/next" + dev, { method: "POST" });
      manualUntil = Date.now() + 8000;
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
      const meta = await sp(`/playlists/${PID}?fields=snapshot_id,description`);
      snapshot = meta?.snapshot_id || snapshot;
      applySettings(parseSettings(meta?.description));
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
    if (inQueue() && lastQueueUri) { // a force-played song is on: everything after the last queue song is next
      const li = plist.findIndex((t) => t.uri === lastQueueUri);
      if (li >= 0) return li + 1;
    }
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
    const nowT = inQueue() && curIdx >= 0 ? plist[curIdx] : (inQueue() && state?.item?.type === "track" ? state.item : null);
    if (nowT) {
      const t = nowT;
      rows.push(`<li class="playing"><img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>▶ ${esc(t.name)}</div><div class="muted">${esc(artists(t))} • now playing</div></div></li>`);
    }
    // When will each song start? Whatever is on now finishes first (Alexa songs hand back to the queue).
    let wait = state?.item ? Math.max(0, state.item.duration_ms - position()) : 0;
    const editable = can("lq");
    for (let i = start; i < plist.length; i++) {
      const t = plist[i];
      const first = i === start, last = i === plist.length - 1;
      rows.push(`<li><img src="${esc(smallImg(t.album?.images))}" alt="">
        <div class="txt"><div>${i - start + 1}. ${esc(t.name)}</div><div class="muted">${esc(artists(t))} • <span class="eta">${eta(wait)}</span></div></div>
        ${editable ? `<div class="qbtns">
          <button data-op="next" data-i="${i}" title="Play next" ${first ? "disabled" : ""}>⤒</button>
          <button data-op="up" data-i="${i}" title="Move up" ${first ? "disabled" : ""}>↑</button>
          <button data-op="down" data-i="${i}" title="Move down" ${last ? "disabled" : ""}>↓</button>
          <button data-op="del" data-i="${i}" class="del" title="Remove">✕</button>
        </div>` : ""}</li>`);
      wait += t.duration_ms || 0;
    }
    const n = Math.max(0, plist.length - start);
    $("qTotal").textContent = n ? `${n} song${n === 1 ? "" : "s"} • ${longDur(wait)}${state?.is_playing ? ` • ends ~${clock(wait)}` : ""}` : "";
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
    if (!guard("lq")) return;
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

  // ---------- recently played ----------
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`;
  };
  async function loadRecent() {
    const ul = $("recent");
    if (!admin && S.hr) return;
    try {
      const j = await sp("/me/player/recently-played?limit=20");
      const seen = new Set();
      const tracks = (j?.items || []).filter((x) => x.track && !seen.has(x.track.uri) && seen.add(x.track.uri))
        .slice(0, 10).map((x) => ({ ...x.track, _at: x.played_at }));
      renderTracks(ul, tracks, { sub: (t) => ago(t._at), empty: "Nothing yet" });
    } catch (e) {
      ul.innerHTML = /scope|permission|forbidden/i.test(e.message)
        ? "<li class='muted'>The host needs to re-run setup once to turn this on.</li>"
        : `<li class='muted'>${esc(e.message)}</li>`;
    }
  }
  $("recentBtn").addEventListener("click", loadRecent);

  // ---------- host mode ----------
  const sha256 = async (txt) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const HOST_KEY = "auxHost";
  try { admin = !!C.adminHash && localStorage.getItem(HOST_KEY) === C.adminHash; } catch {}

  function applySettings(next) {
    const wasHidden = S.hr;
    const changed = JSON.stringify(next) !== JSON.stringify(S);
    S = next;
    if (!changed) return;
    renderLocks();
    if (wasHidden && !S.hr) loadRecent();
  }

  function renderLocks() {
    // guest-facing banners
    $("hostMsgBanner").classList.toggle("hidden", !S.m);
    $("hostMsgTxt").textContent = S.m;
    const locked = Object.keys(LOCK_NAMES).filter((k) => S[k]);
    const showLock = !admin && locked.length;
    $("lockBanner").classList.toggle("hidden", !showLock);
    if (showLock) $("lockTxt").textContent = locked.length === 4 ? "🔒 The host has locked the controls for now." : `🔒 The host locked ${locked.map((k) => LOCK_NAMES[k]).join(", ")}.`;
    document.querySelectorAll(".controls button").forEach((b) => b.classList.toggle("locked", !can("lp")));
    $("seek").disabled = !state?.item || !can("lp");
    renderVolumeLimit();
    renderAddHint();
    $("recentCard").classList.toggle("hidden", !admin && !!S.hr);
    const noColl = !admin && S.ab;
    document.querySelectorAll('#searchTabs button:not([data-mode="track"])').forEach((b) => b.classList.toggle("hidden", noColl));
    if (noColl && mode !== "track") setMode("track");
    // host panel
    $("admin").classList.toggle("hidden", !admin);
    $("hostBtn").classList.toggle("on", admin);
    $("hostBtn").textContent = admin ? "🔑 Host ✓" : "🔑 Host";
    document.querySelectorAll("#admin [data-set]").forEach((cb) => { cb.checked = !!S[cb.dataset.set]; });
    const all = locked.length === 4;
    $("lockAll").textContent = all ? "🔓 Unlock everything" : "🔒 Lock everything";
    $("lockAll").classList.toggle("on", all);
    if (document.activeElement !== $("capVol")) { $("capVol").value = S.mv; $("capVal").textContent = S.mv + "%"; }
    if (document.activeElement !== $("msgInput")) $("msgInput").value = S.m;
    renderQueue();
  }

  async function saveSettings(patch, msg) {
    if (!admin) return;
    if (!PID) { toast("Host settings need the Aux Queue playlist — re-run setup"); return; }
    try {
      // merge onto the latest saved settings so two hosts don't overwrite each other
      const cur = await sp(`/playlists/${PID}?fields=description`);
      const next = { ...parseSettings(cur?.description), ...patch };
      await sp(`/playlists/${PID}`, { method: "PUT", body: JSON.stringify({ description: serializeSettings(next) }) });
      applySettings(next);
      if (msg) toast(msg);
    } catch (e) { toast("Couldn't save: " + e.message); renderLocks(); }
  }

  $("hostBtn").addEventListener("click", () => {
    if (admin) { $("admin").scrollIntoView({ behavior: "smooth" }); return; }
    const box = $("hostLogin");
    box.classList.toggle("hidden");
    $("hostMsg").textContent = C.adminHash ? "" : "No host password yet. Re-run setup.html and fill in Host password.";
    if (!box.classList.contains("hidden")) $("hostInput").focus();
  });
  $("hostForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!C.adminHash) return;
    if (!crypto.subtle) { $("hostMsg").textContent = "Host login needs the https:// version of the site"; return; }
    const h = await sha256($("hostInput").value);
    if (h !== C.adminHash) { $("hostMsg").textContent = "Wrong password"; return; }
    admin = true;
    try { localStorage.setItem(HOST_KEY, h); } catch {}
    $("hostInput").value = ""; $("hostLogin").classList.add("hidden");
    renderLocks(); loadRecent(); toast("You're the host 🔑");
  });
  $("hostOut").addEventListener("click", () => {
    admin = false;
    try { localStorage.removeItem(HOST_KEY); } catch {}
    renderLocks(); toast("Logged out of host mode");
  });
  document.querySelectorAll("#admin [data-set]").forEach((cb) => cb.addEventListener("change", () =>
    saveSettings({ [cb.dataset.set]: cb.checked ? 1 : 0 }, "Saved")));
  $("lockAll").addEventListener("click", () => {
    const on = Object.keys(LOCK_NAMES).every((k) => S[k]) ? 0 : 1;
    saveSettings({ lp: on, lv: on, la: on, lq: on }, on ? "🔒 Everything locked for guests" : "🔓 Unlocked");
  });
  $("capVol").addEventListener("input", () => { $("capVal").textContent = $("capVol").value + "%"; });
  $("capVol").addEventListener("change", () => saveSettings({ mv: +$("capVol").value }, `Guest volume limit: ${$("capVol").value}%`));
  $("msgForm").addEventListener("submit", (ev) => { ev.preventDefault(); $("msgInput").blur(); saveSettings({ m: $("msgInput").value.trim() }, "Message posted 📣"); });
  $("msgClear").addEventListener("click", () => { $("msgInput").value = ""; saveSettings({ m: "" }, "Message removed"); });
  $("clearQueue").addEventListener("click", async () => {
    const start = upcomingStart();
    const uris = [...new Set(plist.slice(start).map((t) => t.uri))];
    if (!uris.length) { toast("The queue is already empty"); return; }
    if (!confirm(`Remove all ${plist.length - start} upcoming songs from the queue?`)) return;
    try {
      for (let k = 0; k < uris.length; k += 100)
        await sp(`/playlists/${PID}/items`, { method: "DELETE", body: JSON.stringify({ items: uris.slice(k, k + 100).map((uri) => ({ uri })) }) });
      toast("Queue cleared");
    } catch (e) { toast(e.message); }
    loadQueue();
  });

  // ---------- keep it on the Echo ----------
  function renderSpeakerNotice() {
    const other = state?.device && !onEcho();
    $("echoNotice").classList.toggle("hidden", !other);
    if (other) $("echoNoticeTxt").textContent = `Music is playing on "${state.device.name}", not the ${SPEAKER}.`;
  }
  $("moveToEcho").addEventListener("click", async () => {
    if (!guard("lp")) return;
    try {
      await sp("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [await echoId(true)], play: true }) });
      toast(`Moved to the ${SPEAKER}`); setTimeout(refresh, 900);
    } catch (e) { toast(e.message); }
  });

  // ---------- keep screen on (leave one device open as the "host") ----------
  let wake = null, wantWake = false;
  async function setWake(on) {
    wantWake = on;
    try {
      if (on && !document.hidden) wake = await navigator.wakeLock.request("screen");
      if (!on && wake) { await wake.release(); wake = null; }
    } catch { if (on) toast("This browser can't keep the screen on"); }
    $("wakeBtn").textContent = on ? "🔆 Screen stays on" : "💤 Keep screen on";
    $("wakeBtn").classList.toggle("on", on);
    try { localStorage.setItem("auxWake", on ? "1" : ""); } catch {}
  }
  if (!("wakeLock" in navigator)) $("wakeBtn").classList.add("hidden");
  $("wakeBtn").addEventListener("click", () => setWake(!wantWake));
  // the browser drops the lock when the tab is hidden; take it back when it's visible again
  document.addEventListener("visibilitychange", () => { if (!document.hidden && wantWake) setWake(true); });
  try { if (localStorage.getItem("auxWake")) setWake(true); } catch {}

  window.auxDebug = { sp, get state() { return state; }, get plist() { return plist; }, get settings() { return S; }, get admin() { return admin; }, get handoffFor() { return handoffFor; }, onEcho, upcomingStart, inQueue, outsideQueue }; // handy for troubleshooting from the browser console

  // ---------- start ----------
  function start() {
    $("gate").classList.add("hidden");
    $("app").classList.remove("hidden");
    renderLocks();
    refresh(); loadQueue(); loadRecent(); echoId().catch(() => {});
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
