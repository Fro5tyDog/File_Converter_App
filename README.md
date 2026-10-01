# Convert: on-device media converter

Converts photos, videos and audio entirely on the device. Nothing gets uploaded.

| From | To |
|---|---|
| HEIC / HEIF (iPhone photos), PNG, JPG, WEBP, BMP, AVIF | PNG, JPG, WEBP, GIF |
| Several images | One animated GIF |
| MOV, MP4, M4V, WEBM, MKV, AVI, 3GP… | MP4 (fast, lossless repackage), MP4 H.264 (max compatibility), MOV, WEBM, GIF, MP3, M4A, WAV |
| GIF | MP4, WEBM, PNG, JPG, WEBP |
| MP3, M4A, AAC, WAV, OGG, FLAC, CAF… | MP3, M4A, WAV |

It runs in three ways, all from one codebase:

1. **GitHub Pages website.** You can open it in any browser or add it to the Home Screen. It updates through a service worker.
2. **iPhone app.** An unsigned `.ipa` that you sideload with SideStore or Sideloadly.
3. **Android app.** A `.apk` that you install directly.

The installed apps **update themselves from your GitHub Pages site**, so you don't have to re-sideload after a code change.

---

## How the pieces fit

```
push to main ──► pages.yml ──► GitHub Pages
                                 ├─ the web app
                                 ├─ update.json            ◄── installed apps check this
                                 └─ updates/app-1.0.N.zip  ◄── …and download this

run native.yml ─► Release "Convert 1.0.N"
                    ├─ Convert.ipa  → SideStore / Sideloadly
                    └─ Convert.apk  → Android
```

- **Version numbers are automatic:** `1.0.<number of commits>`. Each push gets a higher number, and you never bump anything by hand.
- **Web side:** each deploy ships a new `sw.js`. When the app is next opened, the new version installs in the background and you get a "Reload" prompt.
- **App side:** on launch and whenever the app comes back to the foreground, it fetches `update.json`. If the version there is newer, it downloads the zip and shows "Update ready → Restart". The [Capgo updater](https://github.com/Cap-go/capacitor-updater) handles this in self-hosted mode (free, with no Capgo account or cloud). If a new bundle fails to start, the plugin rolls back to the previous one.

## First-time setup

1. Create a new GitHub repo and upload everything in this folder.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`, or run **Actions → Deploy web app + update bundle → Run workflow**.
   Your site goes live at `https://<user>.github.io/<repo>/`.
4. Go to **Actions → Build iOS + Android apps → Run workflow**. It takes about 10 minutes and then creates a Release containing `Convert.ipa` and `Convert.apk`.
5. **iPhone:** download `Convert.ipa` from the release and open it in SideStore (or drag it into Sideloadly).
   **Android:** download and open `Convert.apk`.

From then on, just push code. The website updates, and the installed apps pick up the change the next time they're opened.

**Custom domain?** Set a repository variable `PAGES_URL` (Settings → Secrets and variables → Actions → Variables), e.g. `https://convert.example.com/`. The build then uses it for the update URL.

## When do I need to rebuild the app (re-sideload)?

You only need to rebuild when the **native shell** changes:
- adding, removing or upgrading Capacitor plugins (`package.json`)
- the app name, ID or icon (`capacitor.config.json`, `assets/`)
- `scripts/ios-plist.sh`

The native workflow runs on its own when those files change. Everything in `www/` (HTML/CSS/JS, conversion logic, UI) arrives through the self-updater.

## Develop locally

```bash
npm install
npm run build     # → build/www
npm run serve     # → http://localhost:8080
```

## Notes and limits

- **Video uses ffmpeg compiled to WebAssembly** (single-threaded, ~30 MB). The apps bundle it. The website downloads it the first time you convert a video, and *Settings → Make available offline* caches it ahead of time.
- **MOV → MP4 "fast"** only repackages the streams, so it finishes in seconds with no quality loss. Pick **MP4 · H.264** if a device can't play iPhone HEVC video. Re-encoding is slow on a phone, so use *Options → Resolution* (720p) and *Length* to keep it quick.
- **Memory:** very large videos (around 1 GB or more) can exceed what a browser or webview allows. Trim them first, or convert to a lower resolution.
- **HEIC:** iPhones and Safari decode HEIC natively. Other browsers fall back to the bundled `heic2any` decoder.
- **WEBP on iPhone:** Safari can't encode WebP from a canvas, so the app uses ffmpeg for that automatically.
- **Saving on iPhone:** *Save / Share* opens the share sheet, where you choose *Save Image*, *Save Video* or *Save to Files*.
- **Android APK** is a debug build. Its signing key changes on each CI run, so installing a newly built APK means uninstalling the old one first. Self-updates aren't affected by this.
