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

## Photos

**Take photo** opens a camera inside the app, with a square frame. What is inside the frame is exactly what gets saved, so nothing is cut off afterwards. Tap the big round button to take the shot, then **Use photo** or **Retake**. The buttons at the sides open your photo library and flip between the front and back cameras. If your phone has a flash light, a lightning button appears at the top.

**Choose photo** opens your photo library, and then a crop screen. A square frame sits over your photo: drag the photo to choose the part you want, pinch to zoom (or double-tap), and tap **Use photo**. The dark area outside the frame is what gets cut off. Your original photo is never changed.

The first time you take a photo, Chrome asks to allow the camera. If you say no, the app tells you and offers your phone's own camera app instead. Photos are shrunk to about 1280px before saving.

## Backups

Your cheeses live only in your phone's browser storage. If you clear site data, delete the app, or lose the phone, they are gone. Back up now and then.

**Export:** Settings (gear icon) → **Export backup**. This makes one file with every entry and every photo (photos are stored inside as base64 text). A **Backup ready** sheet opens. Tap **Share or save…**, then choose **Save to Files**, iCloud Drive, Google Drive or similar. The shared copy is called `cheese-backup-YYYY-MM-DD.txt`, because Android refuses to share `.json` files; the contents are identical. If the share menu isn't available, tap **Download file** to save `cheese-backup-YYYY-MM-DD.json` instead.

**Import:** Settings → **Import backup**, then pick the file (the `.txt` or the `.json`). You are shown what is in it and asked to confirm. Importing **replaces everything** currently in the app. Files that aren't Cheese backups are rejected and nothing changes.

Settings shows how long ago your last backup was and turns yellow after 14 days. The app also asks the browser to protect its storage from being cleared automatically; Settings shows whether that was granted. Adding the app to your home screen makes that more likely.

## Updating the app

After changing any file, edit `VERSION` at the top of `sw.js` (for example `v3` to `v4`). Phones that have the app installed notice the new version when they open it or come back to it, download it, and reload into it automatically. If you are in the middle of editing a cheese, the reload waits until you have finished. You'll see "Updated to the latest version" afterwards.

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
