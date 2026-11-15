// Firebase web config. These values are not secret: they identify the project.
// Access is protected by Firebase Authentication plus the rules in firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyCjVoSpKaNceRWQZQGikLnaPI6IdCht0q0',
  authDomain: 'household-tracker-ea124.firebaseapp.com',
  projectId: 'household-tracker-ea124',
  storageBucket: 'household-tracker-ea124.firebasestorage.app',
  messagingSenderId: '89776885352',
  appId: '1:89776885352:web:47ae9bda57038fe82235dd',
};

// Usernames typed on the login screen become "<username>@<USERNAME_DOMAIN>" Firebase accounts.
// When creating the two users in the Firebase console, use emails like:
//   yourname@household-tracker-ea124.firebaseapp.com
export const USERNAME_DOMAIN = 'household-tracker-ea124.firebaseapp.com';
