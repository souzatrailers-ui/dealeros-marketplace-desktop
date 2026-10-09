# Releasing DealerOS Marketplace (Windows)

Installer: Electron Builder, NSIS, x64, unsigned for the pilot.
App id `ai.dealeros.marketplace`, product name **DealerOS Marketplace**, icon `build/icon.ico` (the DealerOS "D" trailer mark from `app/static/dealeros-logo.png`).

## One-time: create the update repo (not done yet; do it by hand)
1. On GitHub, under the org **souzatrailers-ui**, create the repo **dealeros-marketplace-desktop**.
   Make it **public**. electron-updater reads releases without a token only from a public repo. The code in it is just this
   desktop client: no secrets, no customer data. To keep the code private, use a private source repo plus a
   separate public "releases-only" repo, and set `build.publish[0].repo` to that repo.
2. Copy the contents of this `desktop/` folder to the repo root, including `.github/workflows/build-windows.yml`, then commit and push to `main`.
3. Settings → Actions → General → Workflow permissions: **Read and write** (lets the workflow create releases with `GITHUB_TOKEN`).

## Every release
1. Bump `"version"` in `package.json` (e.g. 1.0.1).
2. `git tag v1.0.1 && git push origin main --tags`
3. The **Build Windows installer** workflow runs on `windows-latest`: `npm ci`, `npm test`, then `electron-builder --win nsis --x64 --publish always`.
   It uploads `DealerOS-Marketplace-Setup-1.0.1.exe`, `.blockmap` and `latest.yml` to a GitHub Release.
4. Installed apps check for updates at startup and every 4 hours, download in the background, and install when the rep quits the app.
   Pushes and PRs without a tag only build the installer as a workflow artifact and publish nothing.

## Local build (Linux)
`sudo apt install wine64 wine32:i386` (needed to stamp the icon/version into the .exe), then `npm ci && npm run dist:win`.
Output: `dist/DealerOS-Marketplace-Setup-<version>.exe`.

## Unsigned installer → SmartScreen
Windows shows "Windows protected your PC". Click **More info**, then **Run anyway**. After the pilot, buy an OV/EV code-signing
certificate and set `CSC_LINK` / `CSC_KEY_PASSWORD` secrets in the workflow. With EV signing, the warning is gone immediately.

## Runtime notes
- Chrome: the app drives the rep's installed **Google Chrome** (Playwright `channel: "chrome"`, or the exe found in Program Files / LocalAppData).
  If Chrome is missing, the app shows a bilingual "install Chrome" dialog with a download button.
- Tray: closing the window keeps the app in the tray. Tray menu: Open, Sync leads now, Start with Windows, Open logs folder, Quit.
- Start with Windows is optional (tray menu or Account tab) and launches hidden (`--hidden`).
- Logs: `%APPDATA%\DealerOS Marketplace\logs\dealeros-marketplace-YYYY-MM-DD.log`, kept 14 days, tokens masked.
- Crash safety: single instance lock, global exception logging, renderer auto-reload. Jobs left in POSTING are recovered by the server after its timeout.
