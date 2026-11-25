// Starts the right page in the browser, based on <body data-page="...">.
import { appConfig } from './config.mjs';
import { createApiClient } from './apiClient.mjs';
import { createAuthSession, mountAccountControl } from './authSession.mjs';
import { createTimetableSource } from './timetableSource.mjs';
import { createComparePage } from './comparePage.mjs';
import { createSharePage } from './sharePage.mjs';
import { createSharedPage } from './sharedPage.mjs';

const byId = (id) => document.getElementById(id);

function saveFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Restore the session from Mohamed's refresh cookie before the page decides
// whether the user is signed in. The access token stays in memory only.
const session = createAuthSession({
  refreshPath: appConfig.auth.refreshPath,
  logoutPath: appConfig.auth.logoutPath
});
await session.restore();
mountAccountControl({
  doc: document,
  nav: document.querySelector('.site-header nav'),
  session,
  loginPageUrl: appConfig.auth.loginPageUrl,
  navigate: (url) => window.location.assign(url)
});

const api = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  getToken: session.getToken,
  refreshSession: session.refresh
});
const source = createTimetableSource({ api, listPath: appConfig.timetableListPath });
const page = document.body.getAttribute('data-page');

if (page === 'compare') {
  createComparePage({
    doc: document,
    api,
    source,
    elements: {
      form: byId('compare-form'),
      status: byId('compare-status'),
      picker: byId('timetable-picker'),
      manualField: byId('manual-field'),
      manualInput: byId('manual-ids'),
      selectionHint: byId('selection-hint'),
      criterion: byId('criterion'),
      compareButton: byId('compare-button'),
      results: byId('compare-results')
    }
  }).load();
} else if (page === 'share') {
  createSharePage({
    doc: document,
    api,
    source,
    // The folder these pages are served from (for example
    // "https://host/compare-share" behind a shared gateway), so share links
    // point at this service's shared.html and not at another service's root.
    origin: new URL('.', window.location.href).href.replace(/\/$/, ''),
    copyText: (text) => navigator.clipboard.writeText(text),
    confirmAction: (message) => window.confirm(message),
    elements: {
      form: byId('share-form'),
      createStatus: byId('create-status'),
      selectField: byId('select-field'),
      timetableSelect: byId('share-timetable'),
      manualField: byId('manual-field'),
      manualInput: byId('manual-id'),
      pickerNote: byId('picker-note'),
      expiryInput: byId('expiry-days'),
      createButton: byId('create-button'),
      newLink: byId('new-link'),
      listStatus: byId('list-status'),
      sharesList: byId('shares-list')
    }
  }).load();
} else if (page === 'shared') {
  createSharedPage({
    doc: document,
    api,
    hash: window.location.hash,
    saveFile,
    elements: {
      status: byId('shared-status'),
      details: byId('shared-details'),
      title: byId('shared-title'),
      meta: byId('shared-meta'),
      schedule: byId('shared-schedule'),
      downloadButton: byId('download-button'),
      downloadStatus: byId('download-status')
    }
  }).load();
}
