# Aux Control

A tiny website that lets friends control the Spotify playing on my Alexa/Echo: add to queue, skip, restart, go back, play/pause, and switch speakers.

Hosted free on GitHub Pages. No server.

## Setup (once)
1. Open `https://<your-username>.github.io/<repo>/setup.html`.
2. Follow the steps: create a Spotify developer app, paste the redirect URI it shows, then log in.
3. Copy the generated text into `config.js` in this repo and commit.
4. Share `https://<your-username>.github.io/<repo>/` with friends.

## Notes
- Needs Spotify Premium (Spotify only allows playback control for Premium).
- Spotify developer-mode apps allow up to 5 users, but friends don't log in, so only you count.
- Spotify refresh tokens expire about 6 months after you log in. Re-run setup.html then.
- The keys in `config.js` are public. Anyone with the link (or who reads the source) can control your playback. Use the access code and don't post the link publicly. If it gets abused, rotate the Client secret in the Spotify dashboard and re-run setup.
- If your Echo doesn't show under "Speaker", say "Alexa, play Spotify" once so it registers as a Spotify Connect device.
