// Crowd Jukebox server
// Rooms live in memory. Restarting the server clears them.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const YT_API_KEY = process.env.YT_API_KEY || ""; // optional, enables in-app search

// ---- Tunable rules ----
const MAX_SONGS_PER_GUEST = 3;   // songs one person can have waiting in the queue
const REMOVE_AT_SCORE = -3;      // a song this unpopular gets dropped
const SKIP_VOTES_NEEDED = 3;     // guests needed to skip the current song
const ROOM_IDLE_HOURS = 12;      // empty rooms are cleaned up after this

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/host/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));
app.get("/r/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "room.html")));

// ---------- Rooms ----------
const rooms = new Map();

function makeCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function newRoom(hostKey) {
  const code = makeCode();
  const room = {
    code,
    hostKey,
    queue: [],
    nowPlaying: null,
    history: [],
    skipVotes: new Set(),
    counter: 0,
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

// Classic jukebox selection codes: A1-A9, B1-B9 ...
function selectionCode(n) {
  const letter = String.fromCharCode(65 + (Math.floor(n / 9) % 26));
  return letter + ((n % 9) + 1);
}

function score(item) {
  let s = 0;
  for (const v of Object.values(item.votes)) s += v;
  return s;
}

function sortQueue(room) {
  room.queue.sort((a, b) => score(b) - score(a) || a.addedAt - b.addedAt);
}

function publicState(room) {
  return {
    code: room.code,
    nowPlaying: room.nowPlaying && {
      ...room.nowPlaying,
      votes: undefined,
      skipVotes: room.skipVotes.size,
      skipNeeded: SKIP_VOTES_NEEDED,
    },
    queue: room.queue.map((q) => ({
      id: q.id,
      sel: q.sel,
      videoId: q.videoId,
      title: q.title,
      channel: q.channel,
      addedBy: q.addedBy,
      addedById: q.addedById,
      score: score(q),
      votes: q.votes,
    })),
    history: room.history.slice(-5).reverse(),
    rules: { MAX_SONGS_PER_GUEST, REMOVE_AT_SCORE, SKIP_VOTES_NEEDED },
    searchEnabled: Boolean(YT_API_KEY),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  io.to(room.code).emit("state", publicState(room));
}

function playNext(room) {
  if (room.nowPlaying) {
    room.history.push({ title: room.nowPlaying.title, addedBy: room.nowPlaying.addedBy, sel: room.nowPlaying.sel });
  }
  sortQueue(room);
  room.nowPlaying = room.queue.shift() || null;
  room.skipVotes = new Set();
  broadcast(room);
}

// ---------- YouTube helpers ----------
function parseVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith("http") ? s : "https://" + s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host === "youtube.com") {
      if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch (_) {}
  return null;
}

async function lookupTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, channel: j.author_name };
  } catch (_) {
    return null;
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Search costs 100 of YouTube's 10,000 free daily quota units, so cache results.
const searchCache = new Map();
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!YT_API_KEY) return res.status(400).json({ error: "Search is off. Paste a YouTube link instead." });
  if (!q) return res.json({ results: [] });
  const key = q.toLowerCase();
  if (searchCache.has(key)) return res.json({ results: searchCache.get(key) });
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({
      part: "snippet", type: "video", videoEmbeddable: "true",
      maxResults: "8", q, key: YT_API_KEY,
    }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (!r.ok) {
      const quota = JSON.stringify(j).includes("quota");
      return res.status(502).json({ error: quota ? "Search is out of quota for today. Paste a YouTube link instead." : "Search failed. Paste a YouTube link instead." });
    }
    const results = (j.items || []).map((it) => ({
      videoId: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
    }));
    searchCache.set(key, results);
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: "Search failed. Paste a YouTube link instead." });
  }
});

// ---------- Realtime ----------
io.on("connection", (socket) => {
  let room = null;
  let isHost = false;

  socket.on("create-room", ({ hostKey }, reply) => {
    if (typeof hostKey !== "string" || hostKey.length < 8) return reply?.({ error: "Bad host key." });
    const r = newRoom(hostKey);
    reply?.({ code: r.code });
  });

  socket.on("join", ({ code, hostKey }, reply) => {
    const r = rooms.get(String(code || "").toUpperCase());
    if (!r) return reply?.({ error: "That jukebox doesn't exist. Check the code, or it may have closed." });
    room = r;
    isHost = Boolean(hostKey) && hostKey === r.hostKey;
    socket.join(r.code);
    reply?.({ ok: true, isHost, state: publicState(r) });
  });

  socket.on("add", async ({ input, videoId, title, channel, name, clientId }, reply) => {
    if (!room) return reply?.({ error: "Join a jukebox first." });
    const id = videoId && /^[\w-]{11}$/.test(videoId) ? videoId : parseVideoId(input);
    if (!id) return reply?.({ error: "That doesn't look like a YouTube link. Copy the link from the Share button and try again." });
    if (!clientId) return reply?.({ error: "Missing guest id. Refresh the page." });

    const already = room.queue.find((q) => q.videoId === id) || (room.nowPlaying && room.nowPlaying.videoId === id);
    if (already) return reply?.({ error: "That song is already in the queue. Upvote it instead." });

    const mine = room.queue.filter((q) => q.addedById === clientId).length;
    if (!isHost && mine >= MAX_SONGS_PER_GUEST) {
      return reply?.({ error: `You already have ${MAX_SONGS_PER_GUEST} songs waiting. Add more once one plays.` });
    }

    let meta = title ? { title, channel } : await lookupTitle(id);
    if (!meta) meta = { title: "YouTube video " + id, channel: "" };

    const item = {
      id: Math.random().toString(36).slice(2, 10),
      sel: selectionCode(room.counter++),
      videoId: id,
      title: String(meta.title).slice(0, 150),
      channel: String(meta.channel || "").slice(0, 80),
      addedBy: String(name || "Someone").slice(0, 24),
      addedById: clientId,
      addedAt: Date.now(),
      votes: { [clientId]: 1 }, // adding counts as your upvote
    };
    room.queue.push(item);
    sortQueue(room);
    if (!room.nowPlaying) playNext(room);
    else broadcast(room);
    reply?.({ ok: true, sel: item.sel });
  });

  socket.on("vote", ({ itemId, value, clientId }) => {
    if (!room || !clientId) return;
    const item = room.queue.find((q) => q.id === itemId);
    if (!item) return;
    const v = value > 0 ? 1 : value < 0 ? -1 : 0;
    if (v === 0 || item.votes[clientId] === v) delete item.votes[clientId]; // tap again to undo
    else item.votes[clientId] = v;
    if (score(item) <= REMOVE_AT_SCORE) room.queue = room.queue.filter((q) => q !== item);
    sortQueue(room);
    broadcast(room);
  });

  socket.on("vote-skip", ({ clientId }) => {
    if (!room || !room.nowPlaying || !clientId) return;
    if (room.skipVotes.has(clientId)) room.skipVotes.delete(clientId);
    else room.skipVotes.add(clientId);
    if (room.skipVotes.size >= SKIP_VOTES_NEEDED) playNext(room);
    else broadcast(room);
  });

  socket.on("remove", ({ itemId, clientId }) => {
    if (!room) return;
    const item = room.queue.find((q) => q.id === itemId);
    if (!item) return;
    if (isHost || item.addedById === clientId) {
      room.queue = room.queue.filter((q) => q !== item);
      broadcast(room);
    }
  });

  // Host-only controls
  socket.on("ended", ({ videoId }) => {
    if (!room || !isHost) return;
    if (room.nowPlaying && room.nowPlaying.videoId === videoId) playNext(room);
  });
  socket.on("skip", () => { if (room && isHost) playNext(room); });
});

// Clean up idle rooms
setInterval(() => {
  const cutoff = Date.now() - ROOM_IDLE_HOURS * 3600 * 1000;
  for (const [code, r] of rooms) {
    const listeners = io.sockets.adapter.rooms.get(code)?.size || 0;
    if (listeners === 0 && r.lastActive < cutoff) rooms.delete(code);
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Crowd Jukebox running at http://localhost:${PORT}`);
  console.log(YT_API_KEY ? "YouTube search: on" : "YouTube search: off (guests paste links). Set YT_API_KEY to turn it on.");
});

module.exports = { parseVideoId, selectionCode };
