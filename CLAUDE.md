# Our Home — notes for Claude

A shared household app (cats, money, groceries) for two people, built as a static site in `public/`. There's no build step. The app talks directly to Firebase: Auth for username/password sign-in, Firestore for live data. It's hosted on GitHub Pages: every push to `main` deploys `public/` via `.github/workflows/pages.yml`.

## Versioning (required)

- The version is in `public/version.js` (`APP_VERSION`) and is shown at the bottom of every screen.
- **Every change you ship must bump it by 0.1**: 1.0 → 1.1 → 1.2 … → 1.9 → 2.0. Bump it once per delivered change or request, in the same commit as the change.
- Mention the new version number to the user when you report the change.

## Working on it

- Run locally with `npm start` (static server on http://localhost:3000). It uses the live Firebase project.
- Firestore rules are in `firestore.rules`. Changing them means the user must paste the rules into the Firebase console again. Avoid new collections unless needed, and tell the user if a rules change is required.
- Keep personal data (import files, owner names, addresses) out of the repo: it's public.
