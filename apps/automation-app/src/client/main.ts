// The browser's entry point moved to `client/src/app.tsx`, where the React application
// that both halves render lives (DEC-APP-06, revised). This file stays because it is one
// of the directories `infra/tests/no-firestore-sdk-in-frontend.sh` scans: the control is
// "no datastore SDK reaches the browser", and a scan root that quietly disappeared would
// leave a place for one to reappear.
//
// DEV-13: no database SDK is ever imported here, or anywhere else the browser loads.
export {};
