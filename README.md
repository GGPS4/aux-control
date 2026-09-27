# Aux Control

**Live:** https://ggps4.github.io/aux-control/

A small website that lets friends control the Spotify playing on my Echo Plus. Open the link on a phone and you can search for songs, add them to a shared queue, skip, go back, change the volume and read along with the lyrics. Friends don't need a Spotify account or a login.

It runs entirely in the browser on GitHub Pages. There is no server.

## What it does

- **Now playing.** Album art, title, artist and a live progress bar for whatever is on the Echo.
- **Controls.** Back, restart, play/pause and skip, all sent straight to the Echo.
- **Volume.** A slider covering the speaker's full range, plus a **MAX** button.
- **Add a song.** Search Spotify, then tap a song to play it now or tap **≡+** to add it to the queue. Playing a song now slots it in right after the current one, so nothing already queued gets lost.
- **Shared queue.** Everyone's songs go into one queue (a private Spotify playlist behind the scenes). Move songs up, down or straight to next, or remove them. Songs that have played drop off, so the list only shows what's coming.
- **Alexa requests.** If someone says "Alexa, play…", that song is allowed to finish, then the Echo goes back to the shared queue on its own.
- **More like this.** Suggests songs similar to what's playing, using Deezer's artist radio matched back to Spotify.
- **Lyrics.** Pulled from lrclib.net. Synced lyrics highlight and scroll along with the song; otherwise the plain lyrics are shown.
- **Stays on the Echo.** If the music ends up on another device, a banner offers to move it back.
- **Keep screen on.** Leave one phone or laptop open with this switched on and it keeps watching for Alexa requests so it can hand back to the queue.
- **Access code.** Optional. Friends enter it once and their browser remembers it.

## Setup (owner only, once)

Requires Spotify Premium, since Spotify only allows playback control for Premium accounts.

1. Open `https://<your-username>.github.io/<repo>/setup.html`.
2. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) (Web API) and set its Redirect URI to the one the setup page shows.
3. Enter the Client ID, Client secret, a site name and an optional access code, then log in with Spotify. Setup creates a private "Aux Queue" playlist (or reuses the existing one).
4. Copy the generated text into `config.js`, commit, and share `https://<your-username>.github.io/<repo>/` with friends.

If the Echo doesn't show up, say "Alexa, play Spotify" once so it registers as a Spotify Connect device. By default the site looks for a speaker named "Echo Plus"; set `speakerName` in `config.js` to use a different one.

## Notes

- Spotify refresh tokens expire about 6 months after you log in. Re-run `setup.html` when that happens.
- Developer-mode Spotify apps allow up to 5 users, but friends don't log in, so only you count.
- The keys in `config.js` are public. Anyone with the link (or who reads the source) can control your playback. Set an access code and don't post the link publicly. If it gets abused, rotate the Client secret in the Spotify dashboard and re-run setup.

## Tech

Plain HTML, CSS and JavaScript with no build step. It talks to the Spotify Web API directly from the browser, refreshing the access token from the stored refresh token. The page checks playback every 4 seconds and the queue every 12. Suggestions come from the Deezer API and lyrics from lrclib.net, and neither needs a key.

```
index.html   the remote: now playing, controls, volume, search, queue, lyrics
app.js       Spotify API calls, shared queue, Alexa hand-off, suggestions, lyrics, wake lock
style.css    styling
setup.html   owner-only Spotify login that generates config.js
config.js    site name, Spotify keys, queue playlist and access code
```

To run it locally, serve the folder with any static server (`python3 -m http.server`). For troubleshooting, `window.auxDebug` in the browser console exposes the player state and queue.
