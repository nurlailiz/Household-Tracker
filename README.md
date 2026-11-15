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
- run `npm run deploy` (see below), which publishes the rules and the app together.

Even if someone finds the app's address, they can't sign up (step 3). Even a signed-in account that isn't one of yours can't read or change anything (step 5).

## Putting the app online (Firebase Hosting, free)

On a computer with Node.js installed, from this folder:

```bash
npx firebase-tools login
```

```bash
npm run deploy
```

Your app will be at **https://household-tracker-ea124.web.app**. Open it on both phones and use **Add to Home Screen** to get an app icon.

To try it on your own computer first, run `npm start` and open http://localhost:3000. It uses the same live database.

## Files

- `public/`: the app (plain HTML/CSS/JS, no build step)
  - `firebase-config.js`: your Firebase project config. These values are public by design; security comes from steps 3 and 5.
  - `app.js`: the screens plus Firestore sync and sign-in
- `firestore.rules`: who may read and write data
- `firebase.json`, `.firebaserc`: settings for Firebase Hosting and deploy
- `serve.js`: tiny local web server for `npm start`
