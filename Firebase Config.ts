// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDhTvQfTPV_oUwl-HjJRQhmqo32qsVTLak",
  authDomain: "friendsync-6f2fc.firebaseapp.com",
  projectId: "friendsync-6f2fc",
  storageBucket: "friendsync-6f2fc.firebasestorage.app",
  messagingSenderId: "80374262111",
  appId: "1:80374262111:web:bc7c1d26e204588edbeeea",
  measurementId: "G-Q0Q02DZ381"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);