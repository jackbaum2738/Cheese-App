# Cheese

A personal cheese journal for your phone. Log the cheeses you've tried (with photos, notes and stars) and keep a list of the ones you want to try. It installs like an app, works offline, and everything stays on your phone.

No accounts, no server, no tracking. It is plain HTML, CSS and JavaScript with no build step.

## Turn on GitHub Pages

1. Make sure the code is on the `main` branch (merge the working branch into `main` first).
2. On GitHub, open the repo and tap **Settings**.
3. In the left menu tap **Pages**.
4. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
5. Under **Branch**, choose **main** and the **/ (root)** folder, then tap **Save**.
6. Wait a minute or two and refresh the page. A banner shows your address:
   `https://<your-username>.github.io/<repo-name>/`

Open that address on your phone.

## Add it to your home screen

**iPhone (Safari)**
1. Open the address in Safari (it must be Safari).
2. Tap the **Share** button (the square with an arrow).
3. Scroll down and tap **Add to Home Screen**, then **Add**.

**Android (Chrome)**
1. Open the address in Chrome.
2. Tap **Install** on the card in the app, or open the **⋮** menu and tap **Install app** (sometimes called **Add to Home screen**).

It then opens full screen with its own cheese wedge icon, and keeps working without signal.

## Backups

Your cheeses live only in your phone's browser storage. If you clear site data, delete the app, or lose the phone, they are gone. Back up now and then.

**Export:** Settings (gear icon) → **Export backup**. This makes one file, `cheese-backup-YYYY-MM-DD.json`, with every entry and every photo (photos are stored inside as base64 text). On a phone a share sheet opens, so choose **Save to Files**, iCloud Drive, Google Drive or similar. If the share sheet doesn't work, use **Download backup as a file instead**.

**Import:** Settings → **Import backup**, then pick the file. You are shown what is in it and asked to confirm. Importing **replaces everything** currently in the app. Files that aren't Cheese backups are rejected and nothing changes.

Settings shows how long ago your last backup was and turns yellow after 14 days. The app also asks the browser to protect its storage from being cleared automatically; Settings shows whether that was granted. Adding the app to your home screen makes that more likely.

## Updating the app

After changing any file, edit `VERSION` at the top of `sw.js` (for example `v1` to `v2`) so phones fetch the new files. Open the app once to pick up the update, and a second time to see it.

## Files

| File | What it does |
| --- | --- |
| `index.html` | App shell and icons |
| `styles.css` | Colours, layout, light and dark mode |
| `app.js` | Storage (IndexedDB), screens, photos, backup and restore |
| `sw.js` | Offline support |
| `manifest.webmanifest` | Name, colours and icons for installing |
| `icons/` | App icons (`icon.svg` is the source for the PNGs) |

## Try it on a computer

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Service workers only run on `localhost` or over HTTPS, so opening `index.html` as a file won't enable offline mode.
