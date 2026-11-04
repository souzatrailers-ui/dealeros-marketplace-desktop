# Releasing DealerOS Marketplace (Windows + Mac)

Source of truth: this folder in DealerOS-AI. Installers are published as GitHub Releases (tag `vX.Y.Z`) on the
**public** releases repo `souzatrailers-ui/dealeros-marketplace-desktop`. Two things read that repo's latest release:
- DealerOS web → Marketplace → **Get the app** (`GET /api/marketplace-app/latest`, cached 10 min; download buttons go
  through `/api/marketplace-app/download/{windows|mac}`, login required).
- Installed apps: Windows self-updates with electron-updater (`latest.yml`); unsigned Mac builds show a
  "new version available" notification (`src/update-check.js`).

## One-time setup
Add a repository secret **MARKETPLACE_RELEASE_TOKEN** on DealerOS-AI (Settings → Secrets and variables → Actions):
a fine-grained token with **Contents: Read and write** on `souzatrailers-ui/dealeros-marketplace-desktop` only.
(The default `GITHUB_TOKEN` cannot write to another repo.)

## 1.0.18
Lead sync was saving the Marketplace **chat list** as messages on one lead named "Facebook buyer".
The inbox scraper now reads only the open conversation, keeps a thread id per buyer, and skips
chat-list names. The server rejects that junk even from an older app, and does not insert the
same message again on every poll when Facebook gives no timestamp.

Shipping is the same path as every release below. Merging `1.0.18` does not by itself publish
an installer. After it is on main, tag `marketplace-v1.0.18` and push the tag. The release
workflow template is `ci/marketplace-release.yml` (it is not in `.github/workflows` in this
repo, so a tag alone does not build). Copy that template to
`.github/workflows/marketplace-release.yml`, or publish installers already built with
`scripts/publish_marketplace_release.sh`. Either path creates release `v1.0.18` on
`souzatrailers-ui/dealeros-marketplace-desktop`. DealerOS **Marketplace → Get the app**
shows it within 10 minutes. Windows apps already on **1.0.17** take it from electron-updater
(check at launch and every 4 hours, install on quit). Versions **1.0.10 through 1.0.16** still
need the one-time manual 1.0.17 install before that updater works. Unsigned Mac builds do not
self-install; `src/update-check.js` notifies and the download is on Get the app.

## 1.0.14
Scheduled work (the sold-listing check, which opens Facebook Marketplace's selling page every few
minutes, plus posting and lead reading) now reuses **one Chrome window per rep**. 1.0.13 closed the
Playwright handle after every pass and the next pass launched a new window. On Mac that close often
left the old window up, so windows piled up (one every couple of minutes, 400+ on a Mac Studio).
A pass still running blocks the next one. Extra tabs are closed down to 3. Quit, sign-out, and
switching to another rep still close that rep's Chrome, and a leftover process for the app's own
profile is killed so it cannot sit beside a new window.

## Every release
1. Bump `"version"` in `package.json` (e.g. 1.0.14), merge to main.
2. `git tag marketplace-v1.0.14 && git push origin marketplace-v1.0.14`
3. Workflow **DealerOS Marketplace app release** (`.github/workflows/marketplace-release.yml`; template in `ci/marketplace-release.yml`, copy it there once) checks the tag matches
   the version, runs `npm test`, builds Windows on `windows-latest` and Mac (arm64) on `macos-14`, then publishes
   release `v1.0.14` with the .exe, .dmg, blockmaps and `latest*.yml`. DealerOS shows it within 10 minutes.

## Publishing installers built locally
`scripts/publish_marketplace_release.sh 1.0.14 path/to/dist` (from the DealerOS-AI root; needs `gh` with write
access). Never upload a build named `*flagged*`.

## Local build
Windows on Linux: `sudo apt install wine64 wine32:i386`, then `npm ci && npm run dist:win`. Mac: `npm ci && npm run dist:mac` on a Mac.

### Install 1.0.14 on a Mac
The DMG has to be built on a Mac (Apple Silicon for the arm64 build the Mac Studio uses). From
`desktop_apps/dealeros-marketplace-desktop`, with Google Chrome installed:

```
npm ci
npm test
npm run dist:mac
```

That writes `dist/DealerOS-Marketplace-1.0.14-mac-arm64.dmg`. Quit DealerOS Marketplace (menu-bar
icon → Quit) so the old copy stops opening windows. Open the DMG, drag **DealerOS Marketplace**
into Applications, replacing the old app. First launch of an unsigned build: right-click the app
→ Open. The Facebook login stays in `~/Library/Application Support/DealerOS Marketplace` (the
installer does not delete it). The next selling-page check reuses one Chrome window.

## Unsigned installer → SmartScreen
Windows shows "Windows protected your PC". Click **More info**, then **Run anyway**. After the pilot, buy an OV/EV code-signing
certificate and set `CSC_LINK` / `CSC_KEY_PASSWORD` secrets in the workflow. With EV signing, the warning is gone immediately.

## Windows auto-update while the installer is unsigned
electron-updater checks the downloaded exe against `publisherName` stored in the installed app (`app-update.yml`). That name is written at build time when `win.signtoolOptions.publisherName` is set, or when `win.verifyUpdateCodeSignature` is left on. There is no certificate yet, so a publisher name makes every later update fail after the download: "New version … is not signed by the application owner".

`npm run dist:win` and `npm run release:win` load `electron-builder.config.js`. With `CSC_LINK` and `WIN_CSC_LINK` unset, the Windows build sets `verifyUpdateCodeSignature` to false and does not set `publisherName`. The running app also sets `autoUpdater.disableWebInstaller` to true (that flag is not an electron-builder option). A 404 for an older `.blockmap` only means the differential download fell back to the full installer. When the download finishes, the app shows "Update downloaded" and installs it the next time you quit.

When a certificate is bought, set `CSC_LINK` and `CSC_KEY_PASSWORD` and build with the same scripts. The config then sets `publisherName` to `DealerOS AI` and turns `verifyUpdateCodeSignature` back on.

Versions **1.0.10 through 1.0.16** already have the publisher check inside the installed app. They cannot update themselves to a later unsigned build. Install **1.0.17 by hand once**. Builds after that can update from 1.0.17 without a certificate.

## Runtime notes
- Chrome: the app drives the rep's installed **Google Chrome** (Playwright `channel: "chrome"`, or the exe found in Program Files / LocalAppData).
  If Chrome is missing, the app shows a bilingual "install Chrome" dialog with a download button.
- Tray: closing the window keeps the app in the tray. Tray menu: Open, Sync leads now, Start with Windows, Open logs folder, Quit.
- Start with Windows is optional (tray menu or Account tab) and launches hidden (`--hidden`).
- Logs: `%APPDATA%\DealerOS Marketplace\logs\dealeros-marketplace-YYYY-MM-DD.log`, kept 14 days, tokens masked.
- Crash safety: single instance lock, global exception logging, renderer auto-reload. Jobs left in POSTING are recovered by the server after its timeout.

## 1.0.10 build note
rcedit under wine 10 fails ("Unable to commit changes"), so `build.win.signAndEditExecutable` is `false`. Nothing stamps the exe after the pack step. CI on windows-latest has a working rcedit; turn `signAndEditExecutable` back on when `CSC_LINK` is set.
