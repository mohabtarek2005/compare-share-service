// Frontend settings and integration assumptions.
// Change these when the team agrees on the shared frontend and gateway.

export const appConfig = {
  // Same origin as the page (the Compare & Share API is reached through the
  // same origin as these files).
  apiBaseUrl: '',

  // CONFIRMED (Yehia commit 01c6397): GET /api/timetables lists the signed-in
  // student's saved timetables as [{ id, ownerId, name, createdAt, sectionIds, stale }].
  // It must be reachable on the same origin as these pages (shared gateway or
  // the local preview proxy); the request carries the same in-memory token.
  timetableListPath: '/api/timetables',

  // Sign-in uses Mohamed's Catalogue & Accounts service (CONFIRMED contract,
  // mohamed/docs/api-contract.md v1.8 and mohamed/frontend/assets/api.js):
  //   - login happens on HIS login page, never here;
  //   - the refresh token is an HttpOnly "__Secure-refresh" cookie with
  //     Path=/api/auth and SameSite=Strict, so these pages must be served from
  //     the SAME ORIGIN as /api/auth (one gateway in front of both services);
  //   - POST /api/auth/refresh turns that cookie into a 2-hour access token,
  //     which is kept in memory only (never localStorage or sessionStorage).
  auth: {
    refreshPath: '/api/auth/refresh',
    logoutPath: '/api/auth/logout',
    // UNCONFIRMED (gateway layout is a team decision): where Mohamed's login
    // page is reachable on the shared origin. In the local preview his pages
    // are served at the root, so his login page is /index.html.
    loginPageUrl: '/index.html'
  }
};
