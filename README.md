# Our Home — Household Tracker

A shared web app for two people, built on **Firebase**. You each sign in with a **username and password**, and everything syncs live between your phones. It keeps working offline and catches up when you're back online. **Only your two accounts can get in.**

## Modules

### 🏠 Home
The first screen: an overview of everything.
- **🐾 Cats · next up:** the next five cat dates (vet visits, vaccines, deworm, weigh-ins…). Tap one to open that cat.
- **💰 This month:** each person's income, spending and what's left. Tap a person to open their Money tab.
- **🛒 To buy:** the shopping list, which you can tick off right there, plus anything **⚠️ expiring soon**.

**Who changed what:** every cat record, weight, meal, date, income, spending and grocery item shows who added it or last updated it, and when (for example *Updated by Husband · 5m ago*). Edit forms show the full history. The 🕘 button lists recent activity from both of you across all modules.

### ⚙️ Settings · Household
- **👨‍👩‍🐈 Household** lists everyone in the home: the two of you, each with a role, and every cat (🐱 Cat). Tap a cat to open it.
- Each of you sets **your own role** (Wife, Husband, Partner or Other); the app doesn't let you change the other person's. Roles also show next to your names on Home and in Money.
- Each person appears after they've signed in once.

### 🐱 Cats
- **Profiles** for multiple cats: photo, breed, sex, birthday (age worked out for you), colour, microchip and notes
- **🩺 Health** on each profile:
  - **FIV/FeLV** result and test date (a profile field; edit it with **Edit**)
  - **Vaccination** status, e.g. *1st dose done* or *Fully vaccinated*, with last and next dates. It's worked out from the Vaccination entries in Important dates: a note saying *final*, *fully*, *complete* or *booster* means fully vaccinated, otherwise the dose number in the note ("Vaccine 2", "dose 3") or the number of shots. You can also set it by hand in **Edit**.
  - **Last deworm** and **last deflea**, with next due dates, taken from Important dates (*Deworm + flea* counts for both).
- **All cats overview**: one combined weight graph (one coloured line per cat) and a card for each cat with latest weight, next due date and meal times
- **Weight log** with a graph for each cat and the change since the last weigh-in
- **Feeding schedule** ordered by time
- **Important dates** (vaccination, deflea, deworm, vet visit…). Add a *next due* date and it appears under **Coming up** in the **All cats** overview 30 days before. It turns amber 14 days out and red when overdue.

**Importing records:** ⚙️ Settings → **📥 Import cat records** takes an import file (`.json`), shows a preview, then saves it under your name. Cats are matched by name, and anything already in the app is skipped, so importing the same file twice is safe. Keep import files out of this repo, because it's public.

### 💰 Money
- Tabs for **Mine**, **your partner's** and **👫 Both**. Each income or spending entry belongs to one of you; pick **Whose** in the form, which defaults to the tab you're on.
- Month by month: add **income** and **spending** with a category and date
- Income, spent and what's left, plus a breakdown of where the money went by category. **Both** also shows each person's balance.
- Each person is added to the tabs the first time they sign in. Entries from before this change belong to whoever added them.
- **Copy last month's income** with one tap; the currency symbol is set in ⚙️ Settings

### 🛒 Grocery
- Type what ran out and tap **Add**. Today's date is saved automatically.
- Tick an item when it's bought and it moves to **🏠 In stock**, showing who bought it. You can also add items straight to In stock with **＋ Add**.
- Give an in-stock item an optional **expiry date** with **＋ Expiry**, or by tapping the item. From the day before it expires, it shows in **⚠️ Expiring soon** at the top of the Grocery tab, and a red count appears on the Grocery tab button.
- Ran out? Tap the tick on an in-stock item to put it back on the shopping list. To remove something used up or thrown away, tap it and choose **Remove**.

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

## Version

The app's version shows at the bottom of every screen (e.g. **V1.0**). It's set in `public/version.js` and goes up by 0.1 with every change (1.0 → 1.1 → … → 1.9 → 2.0). If the number at the bottom hasn't changed after an update, your phone is still using a saved older copy. Go to **⚙️ Settings → 🔄 Refresh app**: it checks the latest version, downloads fresh copies of the app's files and reloads (your data isn't affected).

## Files

- `public/`: the app (plain HTML/CSS/JS, no build step)
  - `version.js`: the version number shown at the bottom of the app
  - `firebase-config.js`: your Firebase project config. These values are public by design; security comes from steps 3 and 5.
  - `app.js`: the screens plus Firestore sync and sign-in
- `firestore.rules`: who may read and write data
- `firebase.json`, `.firebaserc`: Firebase CLI settings (only needed if you deploy rules from the command line)
- `.github/workflows/pages.yml`: automatic deploy to GitHub Pages
- `serve.js`: tiny local web server for `npm start`
