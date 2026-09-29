# Crowd Jukebox

A shared YouTube jukebox. One screen plays the music. Everyone else scans a QR code, adds songs from their phone, and votes on what plays next.

## How it works

- **Host screen** (`/host/CODE`): plays the video, shows the QR code, the queue and recent songs. Has Skip and Pause.
- **Guest page** (`/r/CODE`): add songs, upvote or downvote, vote to skip.
- Each song gets a jukebox selection number (A1, A2 … B1) so people can shout "play B4!"

Queue rules (change them at the top of `server.js`):

| Rule | Default |
|---|---|
| Songs one guest can have waiting | 3 |
| Score at which a song is removed | −3 |
| Guest votes needed to skip the current song | 3 |

Adding a song counts as your upvote. Highest score plays next; ties go to whoever added first. Videos that YouTube won't let play outside its site are skipped automatically.

## Run it on your computer

1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000 and click **Start a jukebox**. Click **Start the music** once so the browser allows sound.

**Letting friends on the same Wi-Fi join:** the QR code points at whatever address the host page was opened with, and "localhost" only works on your own computer. Find your computer's local IP (on Mac: System Settings → Wi-Fi → Details; on Windows: run `ipconfig`), then open the host page at something like `http://192.168.1.23:3000` instead. The QR code will then work for phones on the same Wi-Fi.

## Put it online (free, about 10 minutes)

The easiest route is [Render](https://render.com):

1. Put this folder in a GitHub repository.
2. On Render, choose **New → Web Service** and pick the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. You get a link like `https://your-jukebox.onrender.com` that anyone can open.

On Render's free plan the server sleeps after about 15 minutes with no visitors and takes around 30 seconds to wake. Open the host page a minute before the party. Rooms are kept in memory, so a restart or sleep clears the queue.

## Optional: in-app search

Without a key, guests paste YouTube links (Share → Copy link). To let them search by song name instead:

1. Go to https://console.cloud.google.com, create a project, and enable **YouTube Data API v3**.
2. Create an API key under **Credentials**.
3. Set it as an environment variable named `YT_API_KEY` (on Render: your service → Environment). Locally: `YT_API_KEY=yourkey npm start`.

The free allowance covers roughly 100 searches a day. Repeated searches are cached, and pasting links always works even when search runs out.

## Ideas for next steps (good prompts for your AI helper)

- "Let the host set a password so only invited people can add songs."
- "Save rooms to a database so they survive a restart."
- "Add a 'banned songs' list the host can manage."
- "Show a big 'Up next' banner on the host screen 15 seconds before a song ends."

## Files

- `server.js` — rooms, queue, voting and search, all in one file
- `public/index.html` — start or join a jukebox
- `public/host.html` — the player screen
- `public/room.html` — the guest page
- `public/common.js`, `public/style.css` — shared code and styling
