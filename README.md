# Our Home — Household Tracker

A shared web app for two people, built on **Firebase**. You each sign in with a **username and password**, and everything syncs live between your phones. It keeps working offline and catches up when you're back online. **Only your two accounts can get in.**

## Modules

### 🐱 Cats
- **Profiles** for multiple cats: photo, breed, sex, birthday (age worked out for you), colour, microchip and notes
- **Weight log** with a trend chart and the change since the last weigh-in
- **Feeding schedule** ordered by time
- **Important dates** (vaccination, deflea, deworm, vet visit…). Add a *next due* date and it appears under **Coming up** 30 days before. It turns amber 14 days out and red when overdue.

### 💰 Money
- Month by month: add **income** and **spending** with a category and date
- Income, spent and what's left, plus a breakdown of where the money went by category
- **Copy last month's income** with one tap; the currency symbol is set in ⚙️ Settings

### 🛒 Grocery
- Type what ran out and tap **Add**. Today's date is saved automatically.
- Tick an item when it's bought; untick it to put it back. **Clear all** empties the bought list.

---

## One-time setup (Firebase console)

Open https://console.firebase.google.com and choose **household-tracker-ea124**.

### 1. Turn on username/password sign-in
**Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**

### 2. Create your two accounts
**Authentication → Users → Add user**, twice:

| Username you'll type in the app | Email to enter in Firebase |
|---|---|
| `yourname` | `yourname@household-tracker-ea124.firebaseapp.com` |
| `husbandname` | `husbandname@household-tracker-ea124.firebaseapp.com` |

Pick any usernames you like (lowercase, no spaces) and a strong password for each. The app adds the `@household-tracker-ea124.firebaseapp.com` part for you, so on the login screen you just type `yourname`. No emails are ever sent to these addresses.

### 3. Block anyone else from signing up
**Authentication → Settings → User actions**: **untick "Enable create (sign-up)"** and **"Enable delete"**, then **Save**.
After this, new accounts can only be created by you in the console.

### 4. Create the database
**Build → Firestore Database → Create database → Start in production mode**, then pick a location near you.

### 5. Lock the database to your two accounts
Open `firestore.rules` and replace `USERNAME_1` and `USERNAME_2` with your two usernames from step 2.
Then either:
- copy the whole file into **Firestore Database → Rules** and click **Publish**, or
- run `npx firebase-tools deploy --only firestore:rules` from a computer with Node.js.

Even if someone finds the app's address, they can't sign up (step 3). Even a signed-in account that isn't one of yours can't read or change anything (step 5).

## Putting the app online: GitHub Pages (free, no keys)

`.github/workflows/pages.yml` publishes the `public/` folder to GitHub Pages **every time something is pushed or merged to `main`**. You can also run it by hand: **Actions → Deploy to GitHub Pages → Run workflow**.

The app lives at **https://nurlailiz.github.io/Household-Tracker/**. Open it on both phones and use **Add to Home Screen** to get an app icon.

### One-time setup

1. **Create `main`:** on GitHub, open the branch dropdown, type `main`, and create it. Then make it the default branch under **Settings → General → Default branch**.
2. **Turn on Pages:** go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. **Allow sign-in from GitHub Pages:** in the Firebase console, go to **Authentication → Settings → Authorized domains → Add domain** and enter `nurlailiz.github.io`.
4. **Publish the database rules** (setup step 5): paste `firestore.rules` into **Firestore Database → Rules → Publish**.
   GitHub Pages only hosts the app; it doesn't touch Firebase. So whenever you change `firestore.rules`, paste it into the console again.

To try it on your own computer, run `npm start` and open http://localhost:3000. It uses the same live database.

## Files

- `public/`: the app (plain HTML/CSS/JS, no build step)
  - `firebase-config.js`: your Firebase project config. These values are public by design; security comes from steps 3 and 5.
  - `app.js`: the screens plus Firestore sync and sign-in
- `firestore.rules`: who may read and write data
- `firebase.json`, `.firebaserc`: Firebase CLI settings (only needed if you deploy rules from the command line)
- `.github/workflows/pages.yml`: automatic deploy to GitHub Pages
- `serve.js`: tiny local web server for `npm start`
