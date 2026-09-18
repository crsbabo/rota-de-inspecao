// Compatibility entry point for existing installations that previously
// registered sw.js. New clients register firebase-messaging-sw.js directly.
// Both paths now execute the same combined cache + FCM worker implementation.
importScripts('./firebase-messaging-sw.js');
