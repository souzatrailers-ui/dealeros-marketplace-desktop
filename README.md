# DealerOS Marketplace: Windows desktop app (scaffold 0.1.0)

This is an Electron app with Playwright. It posts the DealerOS-approved queue to Facebook Marketplace. All code is original; nothing is copied from fbMarkett.

- **No cookie import.** Each Facebook account gets its own persistent browser profile in `%APPDATA%\DealerOS Marketplace\profiles\account-<id>`. The salesperson clicks **Log in to Facebook** once, and the session stays in that profile. By default it uses the installed Google Chrome (`channel: "chrome"`).
- The queue and counters (QUEUE / PROCESSED / POSTED / SOLD) come from DealerOS (`/api/public/marketplace-ext/*`, per-user token encrypted with Windows DPAPI via `safeStorage`). Mock mode uses public Souza inventory.
- **Auto-post:** random times inside business hours, a daily cap per account, and a minimum gap between posts (`src/scheduler.js`, `src/rules.js`).
- Each run handles delisting sold units first, then RENEW and REPOST per the renew method, then new posts. If a checkpoint is detected, posting pauses and a Windows notification appears.
- **Groups:** the "List in more places" checkboxes. Groups Facebook doesn't offer (approval needed or closed) are skipped.
- Auto publish is OFF by default. The app fills the form and waits, the rep publishes in the window, then pastes the URL into the app.
- **Auto-update:** electron-updater using GitHub releases (`souzatrailers-ui/dealeros-marketplace-desktop`, private; repo not created yet).

## Dev
```
npm install
npm test                       # rules: slots, renew methods, description rules
CHROME_PATH=<chrome> npm run mock-run   # end-to-end against mock/fake-marketplace.html, never facebook.com
npm start                      # Electron UI (mock mode on by default)
npm run dist:win               # NSIS installer (needs code-signing cert for SmartScreen)
```
