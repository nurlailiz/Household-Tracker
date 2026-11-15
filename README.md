# Our Home — Household Tracker

A small shared web app for two people. Both partners sign in with their own name and **one shared password**, and both see the same data. Changes on one phone show up on the other within a few seconds.

## Modules

### 🐱 Cats
- **Profiles** for multiple cats: photo, name, breed, sex, birthday (age is worked out for you), colour, microchip and notes
- **Weight log** with a trend chart and the change since the last weigh-in
- **Feeding schedule**: meals ordered by time, with food, amount and notes
- **Important dates**: vaccination, deflea, deworm, vet visits, grooming, medication and more. Give a date a *next due* date and it appears under **Coming up** 30 days before it's due. It turns amber 14 days out and red once it's overdue.

### 💰 Money
- Browse month by month (‹ ›)
- Add **income** and **spending**, each with an amount, description, category and date
- See income, spent and what's left, a progress bar, and a breakdown of where the money went by category
- **Copy last month's income** with one tap when you start a new month
- Each entry shows who added it. Set the currency symbol (for example `$`, `RM`, `£`) in ⚙️ Settings.

### 🛒 Grocery
- Type what ran out and tap **Add**. Today's date is saved automatically.
- Tick an item when it's bought; it moves to **Bought**. Untick it to put it back on the list.
- Tap an item to edit its name, quantity, note or date. **Clear all** empties the bought list.

## Running it

You need Node.js 18 or newer. There are no packages to install.

```bash
APP_PASSWORD="choose-a-shared-password" npm start
```

Then open http://localhost:3000. On a phone, use **Add to Home Screen** to get an app icon.

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | *(none)* | Shared password. **Set this.** Without it, anyone who can reach the app can use it. |
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `./data/db.json` | Where all data is stored (one JSON file) |
| `SESSION_SECRET` | derived from password | Optional extra secret for signing logins |
| `COOKIE_SECURE` | — | Set to `1` to force secure cookies (set automatically behind an HTTPS proxy) |

## Sharing it with your partner (hosting)

Both phones need to reach the same server, so the app has to run somewhere with **persistent storage** for `DATA_FILE`:

- **A home computer or Raspberry Pi** plus [Tailscale](https://tailscale.com): private, free and simple. Install Tailscale on the server and both phones, then open `http://<server-name>:3000`.
- **A cloud host with a persistent volume**, such as Fly.io, Railway or Render (paid disk), using the included `Dockerfile`. Mount the volume at `/data` and set `APP_PASSWORD`.
  > ⚠️ Free tiers without a disk wipe the data on every restart or redeploy.

**Backups:** all data lives in one file (`data/db.json`). Copy it somewhere safe now and then.

## Development

```bash
npm test
```

- `server.js`: HTTP server, JSON API, validation, login and storage
- `public/`: the web app (plain HTML/CSS/JS, no build step)
- `test/`: API tests
