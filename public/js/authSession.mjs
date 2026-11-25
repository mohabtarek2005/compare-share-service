// The signed-in session, following Mohamed's refresh-cookie flow.
//
// - The access token (a JWT) lives only in this module's memory. It is never
//   written to localStorage or sessionStorage, so a script injected into the
//   page cannot read a stored copy, and closing the tab ends it.
// - The refresh token is an HttpOnly cookie that JavaScript cannot read at all.
//   The browser sends it to /api/auth/refresh by itself (same origin).
// - Refresh is "single-flight": if several requests need a new token at the
//   same moment they share ONE refresh call. Mohamed's refresh tokens rotate on
//   every use, so parallel refresh calls could look like token reuse and end
//   the session.

export function createAuthSession({ refreshPath, logoutPath, fetchFn = (...args) => globalThis.fetch(...args) }) {
  let accessToken = null;
  let refreshing = null;

  async function doRefresh() {
    try {
      const response = await fetchFn(refreshPath, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      });
      if (!response.ok) {
        accessToken = null;
        return false;
      }
      const body = await response.json();
      const token = body && typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
      accessToken = token !== '' ? token : null;
      return accessToken !== null;
    } catch {
      // Network problem or a body that is not JSON: treat as signed out.
      accessToken = null;
      return false;
    }
  }

  // Resolves to true when a fresh access token is available.
  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  // Ends the session on the server (the refresh cookie is revoked there) and
  // forgets the access token here, even if the server cannot be reached.
  async function signOut() {
    try {
      await fetchFn(logoutPath, { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Nothing else to do: the local token is cleared below either way.
    } finally {
      accessToken = null;
    }
  }

  return {
    getToken: () => accessToken,
    isSignedIn: () => accessToken !== null,
    restore: refresh,
    refresh,
    signOut
  };
}

// Adds "Sign in" or "Sign out" to the existing page navigation.
// Signing in always happens on Mohamed's login page.
export function mountAccountControl({ doc, nav, session, loginPageUrl, navigate }) {
  if (!nav) {
    return null;
  }
  let control;
  if (session.isSignedIn()) {
    control = doc.createElement('button');
    control.type = 'button';
    control.className = 'nav-button';
    control.textContent = 'Sign out';
    control.addEventListener('click', async () => {
      control.disabled = true;
      await session.signOut();
      navigate(loginPageUrl);
    });
  } else {
    control = doc.createElement('a');
    control.href = loginPageUrl;
    control.textContent = 'Sign in';
  }
  nav.append(control);
  return control;
}
