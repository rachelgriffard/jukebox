// Shared helpers for every page
(function () {
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (_) { return null; }
  }
  function randomId(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let clientId = store("jb-client");
  if (!clientId) { clientId = randomId(8); store("jb-client", clientId); }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function thumb(id) { return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`; }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  function renderQueue(el, state, opts) {
    const { canVote, canRemove } = opts;
    if (!state.queue.length) {
      el.innerHTML = `<li class="empty">Nothing queued yet. Add a song and it jumps to the top.</li>`;
      return;
    }
    el.innerHTML = state.queue.map((q, i) => {
      const mine = q.votes[clientId] || 0;
      const removable = canRemove || q.addedById === clientId;
      return `<li class="song${i === 0 ? " next" : ""}">
        <div class="sel" title="Selection ${esc(q.sel)}">${esc(q.sel)}</div>
        <img src="${thumb(q.videoId)}" alt="" loading="lazy">
        <div class="info">
          <div class="t">${esc(q.title)}</div>
          <div class="by">${i === 0 ? "Up next · " : ""}added by ${esc(q.addedBy)}${removable ? ` · <button class="link-btn" data-remove="${q.id}">remove</button>` : ""}</div>
        </div>
        <div class="voter">
          ${canVote ? `<button aria-label="Upvote" class="${mine === 1 ? "on-up" : ""}" data-vote="1" data-id="${q.id}">▲</button>` : "<span></span>"}
          <span class="n" aria-label="Score">${q.score > 0 ? "+" : ""}${q.score}</span>
          ${canVote ? `<button aria-label="Downvote" class="${mine === -1 ? "on-down" : ""}" data-vote="-1" data-id="${q.id}">▼</button>` : "<span></span>"}
        </div>
      </li>`;
    }).join("");
  }

  function renderNow(el, state) {
    const n = state.nowPlaying;
    if (!n) { el.innerHTML = `<p class="muted">Silence. Be the first to pick a song.</p>`; return; }
    el.innerHTML = `<div class="now">
      <img src="${thumb(n.videoId)}" alt="">
      <div>
        <div class="small muted"><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>Now playing · ${esc(n.sel)}</div>
        <div class="title">${esc(n.title)}</div>
        <div class="small muted">picked by ${esc(n.addedBy)}</div>
      </div>
    </div>`;
  }

  // Wires up the "add a song" box. Works with pasted links, plus search when the server has a key.
  function wireAdd(socket, getState, getName) {
    const form = document.getElementById("add-form");
    const input = document.getElementById("add-input");
    const results = document.getElementById("results");
    const hint = document.getElementById("add-hint");

    function add(payload) {
      socket.emit("add", { ...payload, name: getName(), clientId }, (res) => {
        if (res?.error) return toast(res.error);
        toast(`Added as selection ${res.sel}`);
        input.value = ""; results.innerHTML = "";
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      const looksLikeLink = /youtu\.?be/i.test(val);
      if (looksLikeLink || !getState()?.searchEnabled) return add({ input: val });
      results.innerHTML = `<li class="muted small">Searching…</li>`;
      try {
        const r = await fetch("/api/search?q=" + encodeURIComponent(val));
        const j = await r.json();
        if (j.error) { results.innerHTML = ""; return toast(j.error); }
        if (!j.results.length) { results.innerHTML = `<li class="muted small">No results. Try different words.</li>`; return; }
        results.innerHTML = j.results.map((x) => `<li><button type="button" data-pick='${esc(JSON.stringify(x))}'>
          <img src="${thumb(x.videoId)}" alt=""><span><strong>${esc(x.title)}</strong><br><span class="small muted">${esc(x.channel)}</span></span>
        </button></li>`).join("");
      } catch (_) { results.innerHTML = ""; toast("Search failed. Paste a YouTube link instead."); }
    });
    results.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (b) add(JSON.parse(b.dataset.pick));
    });
    return function updateHint(state) {
      input.placeholder = state.searchEnabled ? "Search YouTube or paste a link" : "Paste a YouTube link";
      hint.textContent = state.searchEnabled
        ? `Search by song or artist, or paste a link. You can have ${state.rules.MAX_SONGS_PER_GUEST} songs waiting at once.`
        : `In YouTube, tap Share, copy the link, and paste it here. You can have ${state.rules.MAX_SONGS_PER_GUEST} songs waiting at once.`;
    };
  }

  window.JB = { clientId, store, randomId, esc, thumb, toast, renderQueue, renderNow, wireAdd };
})();
