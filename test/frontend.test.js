// Tests for the browser code in public/js. They use a fake DOM and fake API
// responses (test-only), so no browser or real backend is needed.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createFakeDocument, FakeElement, findAll, byTag } = require('./fixtures/fakeDom');

const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');
const SHARE_TOKEN = 'A'.repeat(20) + '_b-' + 'C'.repeat(20); // 43 characters, valid format
const ORIGIN = 'https://timetable.example';

let apiClientModule;
let validation;
let timetableSource;
let comparePage;
let sharePage;
let sharedPage;
let config;

before(async () => {
  const load = (file) => import(path.join(PUBLIC_JS, file).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  apiClientModule = await load('apiClient.mjs');
  validation = await load('validation.mjs');
  timetableSource = await load('timetableSource.mjs');
  comparePage = await load('comparePage.mjs');
  sharePage = await load('sharePage.mjs');
  sharedPage = await load('sharedPage.mjs');
  config = await load('config.mjs');
});

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function recordingFetch(responder) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  return { fetchFn, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function textOf(node) {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

// Text of a table row, with a space between cells (and between parts of a cell).
function rowText(row) {
  return row.children
    .map((cell) => (cell.children.length > 0 ? cell.children.map((part) => part.textContent).join(' ') : cell.textContent))
    .join(' ');
}

// A fake API object for page tests. Each method can be replaced per test.
function fakeApi(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    calls,
    isSignedIn: () => true,
    compare: record('compare', { ok: true, data: { criterion: 'leastGaps', results: [] } }),
    createShare: record('createShare', { ok: true, data: { token: SHARE_TOKEN, expiresAt: '2026-11-30T10:00:00.000Z' } }),
    listShares: record('listShares', { ok: true, data: { shares: [] } }),
    getShare: record('getShare', { ok: false, status: 404, code: 'SHARE_NOT_FOUND', message: 'unavailable' }),
    revokeShare: record('revokeShare', { ok: true, data: {} }),
    downloadCalendar: record('downloadCalendar', { ok: true, data: { blob: new Blob(['BEGIN:VCALENDAR']), fileName: 'Option-A.ics' } }),
    ...overrides
  };
}

function fakeSource(result) {
  return { listSavedTimetables: async () => result };
}

describe('frontend API client', () => {
  test('sends the login token, JSON body and correct path for compare', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, { criterion: 'leastGaps', results: [] }));
    const api = apiClientModule.createApiClient({ baseUrl: '', getToken: () => 'jwt-abc', fetchFn });
    const result = await api.compare(['tt-1', 'tt-2'], 'leastGaps');

    assert.deepEqual(result, { ok: true, data: { criterion: 'leastGaps', results: [] } });
    assert.equal(calls[0].url, '/api/compare');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt-abc');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), { timetableIds: ['tt-1', 'tt-2'], criterion: 'leastGaps' });
  });

  test('uses the share endpoints with an encoded token', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, {}));
    const api = apiClientModule.createApiClient({ getToken: () => 'jwt', fetchFn });
    await api.createShare('tt-1', 7);
    await api.listShares();
    await api.getShare('a/b');
    await api.revokeShare(SHARE_TOKEN);
    assert.deepEqual(calls.map((c) => `${c.options.method} ${c.url}`), [
      'POST /api/shares',
      'GET /api/shares',
      'GET /api/shares/a%2Fb',
      `DELETE /api/shares/${SHARE_TOKEN}`
    ]);
    assert.deepEqual(JSON.parse(calls[0].options.body), { timetableId: 'tt-1', expiresInDays: 7 });
  });

  test('does not call the server when the user is not signed in', async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, {}));
    const api = apiClientModule.createApiClient({ getToken: () => null, fetchFn });
    const result = await api.compare(['tt-1', 'tt-2'], 'leastGaps');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, 'NOT_SIGNED_IN');
    assert.equal(api.isSignedIn(), false);
    assert.equal(calls.length, 0);
  });

  test('turns each error status into a clear message', async () => {
    const cases = [
      [400, 'INVALID_REQUEST', /not valid/],
      [401, 'INVALID_TOKEN', /sign in again/],
      [404, 'TIMETABLE_NOT_FOUND', /could not be found/],
      [404, 'SHARE_NOT_FOUND', /expired or been revoked/],
      [409, 'STALE_TIMETABLE', /outdated/],
      [502, 'TIMETABLE_SERVICE_BAD_RESPONSE', /could not be used/],
      [503, 'AUTH_NOT_CONFIGURED', /Sign-in is not available/],
      [503, 'TIMETABLE_SERVICE_UNAVAILABLE', /not available right now/],
      [503, 'SOMETHING_NEW', /temporarily unavailable/],
      [500, 'INTERNAL_ERROR', /Something went wrong/]
    ];
    for (const [status, code, expected] of cases) {
      const { fetchFn } = recordingFetch(() => jsonResponse(status, { error: { code, message: 'server text' } }));
      const api = apiClientModule.createApiClient({ getToken: () => 'jwt', fetchFn });
      const result = await api.listShares();
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.equal(result.code, code);
      assert.match(result.message, expected, `${status} ${code}`);
    }
  });

  test('keeps backend validation details as plain text', async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse(400, {
      error: { code: 'INVALID_REQUEST', details: [{ code: 'INVALID_EXPIRY', message: 'expiresInDays must be 1 to 30' }, null] }
    }));
    const api = apiClientModule.createApiClient({ getToken: () => 'jwt', fetchFn });
    const result = await api.createShare('tt-1', 99);
    assert.deepEqual(result.details, ['expiresInDays must be 1 to 30']);
  });

  test('handles network failures and non-JSON error bodies', async () => {
    const down = apiClientModule.createApiClient({ getToken: () => 'jwt', fetchFn: async () => { throw new TypeError('fetch failed'); } });
    const result = await down.listShares();
    assert.equal(result.status, 0);
    assert.equal(result.code, 'NETWORK_ERROR');

    const html = apiClientModule.createApiClient({
      getToken: () => 'jwt',
      fetchFn: async () => new Response('<html>Bad gateway</html>', { status: 502 })
    });
    const htmlResult = await html.listShares();
    assert.equal(htmlResult.status, 502);
    assert.match(htmlResult.message, /could not be used/);
  });

  test('downloads the calendar as a file with a safe name', async () => {
    const { fetchFn, calls } = recordingFetch(() => new Response('BEGIN:VCALENDAR\r\n', {
      status: 200,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="Option-A.ics"' }
    }));
    const api = apiClientModule.createApiClient({ getToken: () => 'jwt', fetchFn });
    const result = await api.downloadCalendar(SHARE_TOKEN);
    assert.equal(result.ok, true);
    assert.equal(result.data.fileName, 'Option-A.ics');
    assert.equal(await result.data.blob.text(), 'BEGIN:VCALENDAR\r\n');
    assert.equal(calls[0].url, `/api/shares/${SHARE_TOKEN}/calendar.ics`);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt');

    const odd = apiClientModule.createApiClient({
      getToken: () => 'jwt',
      fetchFn: async () => new Response('x', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="../../evil.sh"' } })
    });
    assert.equal((await odd.downloadCalendar(SHARE_TOKEN)).data.fileName, 'timetable.ics');
  });

  test('uses Mohamed\'s refresh-cookie endpoints and no browser storage for tokens', () => {
    assert.equal(config.appConfig.auth.refreshPath, '/api/auth/refresh');
    assert.equal(config.appConfig.auth.logoutPath, '/api/auth/logout');
    assert.equal(typeof config.appConfig.auth.loginPageUrl, 'string');
    assert.equal(config.TOKEN_STORAGE_KEY, undefined, 'the old sessionStorage token key must be gone');
    assert.equal(config.getStoredAuthToken, undefined, 'the old sessionStorage reader must be gone');
    assert.equal(config.appConfig.timetableListPath, null, 'Yehia list endpoint must stay unconfigured until agreed');
  });

  test('no frontend file reads or writes localStorage or sessionStorage', () => {
    for (const file of fs.readdirSync(PUBLIC_JS)) {
      const code = fs.readFileSync(path.join(PUBLIC_JS, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      assert.ok(!/localStorage|sessionStorage/.test(code), `${file} must not use browser storage`);
    }
  });
});

describe('frontend validation helpers', () => {
  test('timetable selection must be 2 to 5 unique ids', () => {
    assert.match(validation.validateSelection([]), /at least 2/);
    assert.match(validation.validateSelection(['a']), /at least 2/);
    assert.equal(validation.validateSelection(['a', 'b']), null);
    assert.equal(validation.validateSelection(['a', 'b', 'c', 'd', 'e']), null);
    assert.match(validation.validateSelection(['a', 'b', 'c', 'd', 'e', 'f']), /at most 5/);
    assert.match(validation.validateSelection(['a', 'a']), /only be selected once/);
    assert.deepEqual(validation.parseIdList(' tt-1, tt-2 ,,\ntt-3 '), ['tt-1', 'tt-2', 'tt-3']);
  });

  test('only the four ranking criteria are accepted', () => {
    assert.deepEqual(validation.CRITERIA.map((c) => c.value), ['mostFreeDays', 'leastGaps', 'latestStart', 'earliestEnd']);
    assert.equal(validation.isValidCriterion('leastGaps'), true);
    assert.equal(validation.isValidCriterion('cheapest'), false);
    assert.equal(validation.isValidCriterion(''), false);
  });

  test('share expiry must be a whole number of days from 1 to 30', () => {
    for (const ok of ['1', '7', '30', 15, ' 3 ']) {
      assert.equal(validation.validateExpiryDays(ok).ok, true, String(ok));
    }
    for (const bad of ['0', '31', '-1', '1.5', 'abc', '', '1e1', null]) {
      assert.equal(validation.validateExpiryDays(bad).ok, false, String(bad));
    }
    assert.equal(validation.validateExpiryDays('7').days, 7);
  });

  test('share links keep the token in the # part of the address', () => {
    const url = validation.buildShareUrl(SHARE_TOKEN, ORIGIN);
    assert.equal(url, `${ORIGIN}/shared.html#${SHARE_TOKEN}`);
    assert.equal(validation.parseShareToken(`#${SHARE_TOKEN}`), SHARE_TOKEN);
    for (const bad of ['', '#', '#abc', `#${SHARE_TOKEN}x`, '#%E0%A4%A', '#<script>']) {
      assert.equal(validation.parseShareToken(bad), null, bad);
    }
  });

  test('formats minutes and dates for display', () => {
    assert.equal(validation.formatMinutes(0), '0 min');
    assert.equal(validation.formatMinutes(45), '45 min');
    assert.equal(validation.formatMinutes(120), '2 h');
    assert.equal(validation.formatMinutes(150), '2 h 30 min');
    assert.match(validation.formatDateTime('2026-11-30T10:00:00.000Z'), /2026/);
    assert.equal(validation.formatDateTime('not a date'), '');
  });
});

describe('saved timetable source (Yehia dependency)', () => {
  test('reports NOT_CONFIGURED instead of returning sample data', async () => {
    const source = timetableSource.createTimetableSource({ api: fakeApi(), listPath: null });
    const result = await source.listSavedTimetables();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_CONFIGURED');
  });

  test('reads a list when a path is configured and ignores bad items', async () => {
    const api = { request: async () => ({ ok: true, data: { timetables: [{ id: 'tt-1', name: 'A' }, { id: 5 }, null, { id: 'tt-2' }] } }) };
    const source = timetableSource.createTimetableSource({ api, listPath: '/api/timetables' });
    assert.deepEqual(await source.listSavedTimetables(), { ok: true, data: [{ id: 'tt-1', name: 'A' }, { id: 'tt-2', name: '' }] });

    const bad = timetableSource.createTimetableSource({ api: { request: async () => ({ ok: true, data: 'nope' }) }, listPath: '/x' });
    assert.equal((await bad.listSavedTimetables()).code, 'BAD_RESPONSE');
  });
});

function compareElements(doc) {
  const make = (tag) => doc.createElement(tag);
  return {
    form: make('form'),
    status: make('div'),
    picker: make('div'),
    manualField: Object.assign(make('div'), { hidden: true }),
    manualInput: make('input'),
    selectionHint: make('p'),
    criterion: make('select'),
    compareButton: Object.assign(make('button'), { textContent: 'Compare' }),
    results: make('section')
  };
}

const SAVED = [
  { id: 'tt-1', name: 'Option A' },
  { id: 'tt-2', name: 'Option B' },
  { id: 'tt-3', name: 'Option C' },
  { id: 'tt-4', name: 'Option D' },
  { id: 'tt-5', name: 'Option E' },
  { id: 'tt-6', name: 'Option F' }
];

describe('Compare page', () => {
  test('shows a sign-in message and disables Compare when not signed in', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const page = comparePage.createComparePage({ doc, elements, api: fakeApi({ isSignedIn: () => false }), source: fakeSource({ ok: true, data: SAVED }) });
    await page.load();
    assert.match(textOf(elements.status), /not signed in/);
    assert.equal(elements.compareButton.disabled, true);
  });

  test('lists saved timetables and limits the selection to 5', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const page = comparePage.createComparePage({ doc, elements, api: fakeApi(), source: fakeSource({ ok: true, data: SAVED }) });
    await page.load();

    const boxes = byTag(elements.picker, 'input');
    assert.equal(boxes.length, 6);
    for (const box of boxes.slice(0, 5)) {
      box.checked = true;
      box.dispatch('change');
    }
    assert.equal(boxes[5].disabled, true, 'a sixth timetable cannot be ticked');
    assert.match(textOf(elements.selectionHint), /5 selected/);
    boxes[0].checked = false;
    boxes[0].dispatch('change');
    assert.equal(boxes[5].disabled, false);
    assert.deepEqual(page.selectedIds(), ['tt-2', 'tt-3', 'tt-4', 'tt-5']);
  });

  test('offers the four ranking criteria', () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    comparePage.createComparePage({ doc, elements, api: fakeApi(), source: fakeSource({ ok: true, data: [] }) });
    assert.deepEqual(byTag(elements.criterion, 'option').map((o) => o.getAttribute('value')), ['mostFreeDays', 'leastGaps', 'latestStart', 'earliestEnd']);
    assert.equal(elements.criterion.value, 'mostFreeDays');
  });

  test('shows an empty state when there are no saved timetables', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const page = comparePage.createComparePage({ doc, elements, api: fakeApi(), source: fakeSource({ ok: true, data: [] }) });
    await page.load();
    assert.match(textOf(elements.picker), /no saved timetables yet/);
    assert.equal(elements.compareButton.disabled, true);
  });

  test('falls back to typed ids when the timetable list is not connected', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const api = fakeApi();
    const page = comparePage.createComparePage({ doc, elements, api, source: fakeSource({ ok: false, code: 'NOT_CONFIGURED' }) });
    await page.load();
    assert.equal(elements.manualField.hidden, false);
    assert.match(textOf(elements.picker), /not connected yet/);

    elements.manualInput.value = 'tt-1, tt-2';
    elements.criterion.value = 'leastGaps';
    await page.compare();
    assert.deepEqual(api.calls[0], { name: 'compare', args: [['tt-1', 'tt-2'], 'leastGaps'] });
  });

  test('blocks invalid selections before calling the API', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const api = fakeApi();
    const page = comparePage.createComparePage({ doc, elements, api, source: fakeSource({ ok: false, code: 'NOT_CONFIGURED' }) });
    await page.load();

    for (const ids of ['tt-1', 'tt-1, tt-1', 'a, b, c, d, e, f']) {
      elements.manualInput.value = ids;
      await page.compare();
      assert.equal(elements.status.getAttribute('role'), 'alert');
    }
    elements.manualInput.value = 'tt-1, tt-2';
    elements.criterion.value = 'cheapest';
    await page.compare();
    assert.match(textOf(elements.status), /how the timetables should be ranked/);
    assert.equal(api.calls.length, 0);
  });

  test('shows a loading state, then the ranked results', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const pending = deferred();
    const api = fakeApi({ compare: async () => pending.promise });
    const page = comparePage.createComparePage({ doc, elements, api, source: fakeSource({ ok: true, data: SAVED }) });
    await page.load();
    const boxes = byTag(elements.picker, 'input');
    boxes[0].checked = true;
    boxes[1].checked = true;
    elements.criterion.value = 'leastGaps';

    const running = page.compare();
    assert.equal(elements.compareButton.disabled, true);
    assert.equal(elements.compareButton.textContent, 'Comparing…');
    assert.equal(elements.results.getAttribute('aria-busy'), 'true');

    pending.resolve({
      ok: true,
      data: {
        criterion: 'leastGaps',
        results: [
          { timetableId: 'tt-2', name: 'Option B', rank: 1, metrics: { freeDays: 3, totalGapMinutes: 0, earliestStart: '09:00', latestEnd: '13:30' } },
          { timetableId: 'tt-1', name: null, rank: 2, metrics: { freeDays: 1, totalGapMinutes: 120, earliestStart: '09:00', latestEnd: '14:00' } }
        ]
      }
    });
    await running;

    assert.equal(elements.compareButton.disabled, false);
    assert.equal(elements.compareButton.textContent, 'Compare');
    assert.match(textOf(elements.results), /Ranked by: Least total gaps/);
    const rows = byTag(byTag(elements.results, 'tbody')[0], 'tr');
    assert.equal(rows.length, 2);
    assert.equal(rowText(rows[0]), '#1 Option B tt-2 3 0 min 09:00 13:30');
    assert.equal(rowText(rows[1]), '#2 tt-1 tt-1 1 2 h 09:00 14:00');
    assert.equal(rows[0].className, 'best');
    assert.match(textOf(elements.status), /Compared 2 timetables/);
  });

  test('shows API errors such as stale timetables or an unavailable service', async () => {
    for (const [status, code, expected] of [[409, 'STALE_TIMETABLE', /outdated/], [503, 'TIMETABLE_SERVICE_UNAVAILABLE', /not available/], [502, 'TIMETABLE_SERVICE_BAD_RESPONSE', /could not be used/]]) {
      const doc = createFakeDocument();
      const elements = compareElements(doc);
      const message = apiClientModule.friendlyMessage(status, code);
      const api = fakeApi({ compare: async () => ({ ok: false, status, code, message }) });
      const page = comparePage.createComparePage({ doc, elements, api, source: fakeSource({ ok: false, code: 'NOT_CONFIGURED' }) });
      await page.load();
      elements.manualInput.value = 'tt-1, tt-2';
      await page.compare();
      assert.match(textOf(elements.status), expected);
      assert.equal(elements.status.getAttribute('role'), 'alert');
      assert.equal(elements.results.children.length, 0);
    }
  });

  test('shows timetable names containing HTML as plain text', async () => {
    const doc = createFakeDocument();
    const elements = compareElements(doc);
    const evil = '<img src=x onerror=alert(1)>';
    const page = comparePage.createComparePage({ doc, elements, api: fakeApi(), source: fakeSource({ ok: true, data: [{ id: 'tt-1', name: evil }] }) });
    await page.load();
    assert.match(elements.picker.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(byTag(elements.picker, 'img').length, 0);
  });
});

function shareElements(doc) {
  const make = (tag) => doc.createElement(tag);
  return {
    form: make('form'),
    createStatus: make('div'),
    selectField: make('div'),
    timetableSelect: make('select'),
    manualField: Object.assign(make('div'), { hidden: true }),
    manualInput: make('input'),
    pickerNote: make('p'),
    expiryInput: Object.assign(make('input'), { value: '7' }),
    createButton: Object.assign(make('button'), { textContent: 'Create share link' }),
    newLink: make('div'),
    listStatus: make('div'),
    sharesList: make('div')
  };
}

function buildSharePage(overrides = {}) {
  const doc = createFakeDocument();
  const elements = shareElements(doc);
  const copied = [];
  const api = overrides.api || fakeApi();
  const page = sharePage.createSharePage({
    doc,
    elements,
    api,
    source: overrides.source || fakeSource({ ok: true, data: SAVED.slice(0, 2) }),
    origin: ORIGIN,
    copyText: overrides.copyText || (async (text) => copied.push(text)),
    confirmAction: overrides.confirmAction || (() => true)
  });
  return { doc, elements, api, page, copied };
}

const ACTIVE_SHARE = {
  token: SHARE_TOKEN,
  timetableId: 'tt-1',
  timetableName: 'Option A',
  createdAt: '2026-11-23T10:00:00.000Z',
  expiresAt: '2026-11-30T10:00:00.000Z',
  sharePath: `/api/shares/${SHARE_TOKEN}`
};

describe('Share page', () => {
  test('shows a sign-in message when not signed in', async () => {
    const { elements, page, api } = buildSharePage({ api: fakeApi({ isSignedIn: () => false }) });
    await page.load();
    assert.match(textOf(elements.createStatus), /not signed in/);
    assert.equal(elements.createButton.disabled, true);
    assert.equal(api.calls.length, 0);
  });

  test('fills the timetable list and shows the empty share list', async () => {
    const { elements, page } = buildSharePage();
    await page.load();
    assert.deepEqual(byTag(elements.timetableSelect, 'option').map((o) => o.textContent), ['Choose a timetable', 'Option A', 'Option B']);
    assert.match(textOf(elements.sharesList), /no active share links/);
  });

  test('rejects an invalid expiry before calling the API', async () => {
    const { elements, page, api } = buildSharePage();
    await page.load();
    elements.timetableSelect.value = 'tt-1';
    for (const value of ['0', '31', '2.5', '']) {
      elements.expiryInput.value = value;
      await page.createShare();
      assert.match(textOf(elements.createStatus), /from 1 to 30/);
    }
    elements.timetableSelect.value = '';
    elements.expiryInput.value = '7';
    await page.createShare();
    assert.match(textOf(elements.createStatus), /Choose the timetable/);
    assert.equal(api.calls.filter((c) => c.name === 'createShare').length, 0);
  });

  test('creates a link, shows it, lets the user copy it and refreshes the list', async () => {
    let shares = [];
    const api = fakeApi({
      createShare: async (...args) => {
        api.calls.push({ name: 'createShare', args });
        shares = [ACTIVE_SHARE];
        return { ok: true, data: { token: SHARE_TOKEN, timetableId: 'tt-1', expiresAt: ACTIVE_SHARE.expiresAt } };
      },
      listShares: async () => ({ ok: true, data: { shares } })
    });
    const { elements, page, copied } = buildSharePage({ api });
    await page.load();
    elements.timetableSelect.value = 'tt-1';
    elements.expiryInput.value = '7';
    await page.createShare();

    assert.deepEqual(api.calls.find((c) => c.name === 'createShare').args, ['tt-1', 7]);
    assert.match(textOf(elements.createStatus), /Share link created/);
    const linkInput = byTag(elements.newLink, 'input')[0];
    assert.equal(linkInput.value, `${ORIGIN}/shared.html#${SHARE_TOKEN}`);

    const copyButton = byTag(elements.newLink, 'button')[0];
    await copyButton.click();
    assert.deepEqual(copied, [`${ORIGIN}/shared.html#${SHARE_TOKEN}`]);
    assert.equal(copyButton.textContent, 'Copied');

    assert.equal(byTag(elements.sharesList, 'li').length, 1);
    assert.match(textOf(elements.sharesList), /Option A/);
  });

  test('shows create errors such as a stale timetable', async () => {
    const api = fakeApi({ createShare: async () => ({ ok: false, status: 409, code: 'STALE_TIMETABLE', message: apiClientModule.friendlyMessage(409, 'STALE_TIMETABLE') }) });
    const { elements, page } = buildSharePage({ api });
    await page.load();
    elements.timetableSelect.value = 'tt-1';
    await page.createShare();
    assert.match(textOf(elements.createStatus), /outdated/);
    assert.equal(elements.newLink.children.length, 0);
    assert.equal(elements.createButton.disabled, false);
  });

  test('revokes a link after confirmation and refreshes the list', async () => {
    let shares = [ACTIVE_SHARE];
    const api = fakeApi({
      listShares: async () => ({ ok: true, data: { shares } }),
      revokeShare: async (token) => {
        api.calls.push({ name: 'revokeShare', args: [token] });
        shares = [];
        return { ok: true, data: { token } };
      }
    });
    const { elements, page } = buildSharePage({ api });
    await page.load();
    const revokeButton = findAll(elements.sharesList, (n) => n.tagName === 'BUTTON' && n.textContent === 'Revoke')[0];
    await revokeButton.click();

    assert.deepEqual(api.calls.find((c) => c.name === 'revokeShare').args, [SHARE_TOKEN]);
    assert.match(textOf(elements.listStatus), /was revoked/);
    assert.match(textOf(elements.sharesList), /no active share links/);
  });

  test('does nothing if the user cancels the revoke', async () => {
    const api = fakeApi({ listShares: async () => ({ ok: true, data: { shares: [ACTIVE_SHARE] } }) });
    const { elements, page } = buildSharePage({ api, confirmAction: () => false });
    await page.load();
    const revokeButton = findAll(elements.sharesList, (n) => n.tagName === 'BUTTON' && n.textContent === 'Revoke')[0];
    await revokeButton.click();
    assert.equal(api.calls.filter((c) => c.name === 'revokeShare').length, 0);
  });

  test('explains when a link was already revoked (404)', async () => {
    const api = fakeApi({
      listShares: async () => ({ ok: true, data: { shares: [ACTIVE_SHARE] } }),
      revokeShare: async () => ({ ok: false, status: 404, code: 'SHARE_NOT_FOUND', message: 'unavailable' })
    });
    const { elements, page } = buildSharePage({ api });
    await page.load();
    await findAll(elements.sharesList, (n) => n.textContent === 'Revoke' && n.tagName === 'BUTTON')[0].click();
    assert.match(textOf(elements.listStatus), /already revoked or has expired/);
  });

  test('shows an error when share storage is unavailable', async () => {
    const api = fakeApi({ listShares: async () => ({ ok: false, status: 503, code: 'SHARE_STORAGE_UNAVAILABLE', message: apiClientModule.friendlyMessage(503, 'SHARE_STORAGE_UNAVAILABLE') }) });
    const { elements, page } = buildSharePage({ api });
    await page.load();
    assert.match(textOf(elements.listStatus), /cannot be loaded right now/);
    assert.equal(elements.listStatus.getAttribute('role'), 'alert');
  });

  test('shows timetable names containing HTML as plain text in the list', async () => {
    const evil = '<script>alert(1)</script>';
    const api = fakeApi({ listShares: async () => ({ ok: true, data: { shares: [{ ...ACTIVE_SHARE, timetableName: evil }] } }) });
    const { elements, page } = buildSharePage({ api });
    await page.load();
    assert.ok(elements.sharesList.textContent.includes(evil));
    assert.equal(byTag(elements.sharesList, 'script').length, 0);
  });

  test('falls back to typing a timetable id when the list is not connected', async () => {
    const { elements, page, api } = buildSharePage({ source: fakeSource({ ok: false, code: 'NOT_CONFIGURED' }) });
    await page.load();
    assert.equal(elements.manualField.hidden, false);
    assert.equal(elements.selectField.hidden, true);
    elements.manualInput.value = ' tt-9 ';
    await page.createShare();
    assert.deepEqual(api.calls.find((c) => c.name === 'createShare').args, ['tt-9', 7]);
  });
});

function sharedElements(doc) {
  const make = (tag) => doc.createElement(tag);
  return {
    status: make('div'),
    details: Object.assign(make('article'), { hidden: true }),
    title: make('h1'),
    meta: make('p'),
    schedule: make('div'),
    downloadButton: Object.assign(make('button'), { textContent: 'Download calendar (.ics)' }),
    downloadStatus: make('div')
  };
}

const SHARED_DATA = {
  timetable: {
    id: 'tt-1',
    name: 'Option A',
    sections: [
      { sectionId: 'MATH201-L1', courseCode: 'MATH201', type: 'LECTURE', meetings: [{ day: 'MON', startTime: '10:00', endTime: '11:30' }] },
      { sectionId: 'CS101-L1', courseCode: 'CS101', type: 'LECTURE', meetings: [{ day: 'TUE', startTime: '09:00', endTime: '10:30' }, { day: 'SUN', startTime: '09:00', endTime: '10:30' }] }
    ]
  },
  createdAt: '2026-11-23T10:00:00.000Z',
  expiresAt: '2026-11-30T10:00:00.000Z'
};

function buildSharedPage({ api = fakeApi(), hash = `#${SHARE_TOKEN}` } = {}) {
  const doc = createFakeDocument();
  const elements = sharedElements(doc);
  const saved = [];
  const page = sharedPage.createSharedPage({ doc, elements, api, hash, saveFile: (blob, name) => saved.push({ blob, name }) });
  return { elements, page, api, saved };
}

describe('Shared timetable page', () => {
  test('rejects a missing or malformed token without calling the API', async () => {
    for (const hash of ['', '#abc', '#<b>hi</b>']) {
      const { elements, page, api } = buildSharedPage({ hash });
      await page.load();
      assert.match(textOf(elements.status), /not valid/);
      assert.equal(elements.details.hidden, true);
      assert.equal(api.calls.length, 0);
    }
  });

  test('asks the user to sign in', async () => {
    const { elements, page } = buildSharedPage({ api: fakeApi({ isSignedIn: () => false }) });
    await page.load();
    assert.match(textOf(elements.status), /Sign in/);
  });

  test('shows a clear message when the link is unavailable', async () => {
    const api = fakeApi({ getShare: async () => ({ ok: false, status: 404, code: 'SHARE_NOT_FOUND', message: apiClientModule.friendlyMessage(404, 'SHARE_NOT_FOUND') }) });
    const { elements, page } = buildSharedPage({ api });
    await page.load();
    assert.match(textOf(elements.status), /expired or been revoked/);
    assert.equal(elements.details.hidden, true);
  });

  test('shows the shared timetable sorted by day and time', async () => {
    const api = fakeApi({ getShare: async (token) => (token === SHARE_TOKEN ? { ok: true, data: SHARED_DATA } : { ok: false }) });
    const { elements, page } = buildSharedPage({ api });
    await page.load();
    assert.equal(elements.details.hidden, false);
    assert.equal(elements.title.textContent, 'Option A');
    assert.match(elements.meta.textContent, /Available until .*2026/);
    const rows = byTag(byTag(elements.schedule, 'tbody')[0], 'tr').map(rowText);
    assert.deepEqual(rows, [
      'Sunday 09:00–10:30 CS101 LECTURE CS101-L1',
      'Monday 10:00–11:30 MATH201 LECTURE MATH201-L1',
      'Tuesday 09:00–10:30 CS101 LECTURE CS101-L1'
    ]);
  });

  test('shows course data containing HTML as plain text', async () => {
    const data = structuredClone(SHARED_DATA);
    data.timetable.name = '<img src=x onerror=alert(1)>';
    data.timetable.sections[0].courseCode = '<script>bad()</script>';
    const { elements, page } = buildSharedPage({ api: fakeApi({ getShare: async () => ({ ok: true, data }) }) });
    await page.load();
    assert.equal(elements.title.textContent, '<img src=x onerror=alert(1)>');
    assert.ok(elements.schedule.textContent.includes('<script>bad()</script>'));
    assert.equal(byTag(elements.schedule, 'script').length + byTag(elements.schedule, 'img').length, 0);
  });

  test('downloads the calendar file through the API', async () => {
    const api = fakeApi({ getShare: async () => ({ ok: true, data: SHARED_DATA }) });
    const { elements, page, saved } = buildSharedPage({ api });
    await page.load();
    await elements.downloadButton.click();
    assert.deepEqual(api.calls.find((c) => c.name === 'downloadCalendar').args, [SHARE_TOKEN]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'Option-A.ics');
    assert.match(textOf(elements.downloadStatus), /downloaded/);
    assert.equal(elements.downloadButton.disabled, false);
  });

  test('shows an error when the calendar cannot be downloaded', async () => {
    const api = fakeApi({
      getShare: async () => ({ ok: true, data: SHARED_DATA }),
      downloadCalendar: async () => ({ ok: false, status: 503, code: 'CALENDAR_NOT_CONFIGURED', message: apiClientModule.friendlyMessage(503, 'CALENDAR_NOT_CONFIGURED') })
    });
    const { elements, page, saved } = buildSharedPage({ api });
    await page.load();
    await elements.downloadButton.click();
    assert.equal(saved.length, 0);
    assert.match(textOf(elements.downloadStatus), /Calendar download is not available/);
  });
});

describe('frontend files and serving', () => {
  test('the fake DOM refuses innerHTML, so the tests above prove it is not used', () => {
    const node = new FakeElement('div');
    assert.throws(() => { node.innerHTML = '<b>x</b>'; }, /must not be used/);
  });

  test('no unsafe HTML-writing APIs appear in the frontend code', () => {
    for (const file of fs.readdirSync(PUBLIC_JS)) {
      const code = fs.readFileSync(path.join(PUBLIC_JS, file), 'utf8');
      assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file);
    }
  });

  test('HTML pages have no inline scripts or styles and no secrets', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    for (const file of ['index.html', 'share.html', 'shared.html']) {
      const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|\sstyle=|\son[a-z]+=/i, file);
      assert.doesNotMatch(html, /eyJ[A-Za-z0-9_-]{10,}|Bearer |password/i, file);
    }
  });

  test('the server serves the pages with security headers', async (t) => {
    const { createApp } = require('../src/app');
    const app = createApp({ logError: () => {} });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await page.text(), /Compare timetables/);

    const script = await fetch(`${base}/js/apiClient.mjs`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    for (const file of ['share.html', 'shared.html', 'css/styles.css']) {
      assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
    }
    // API protection is unchanged: no login, no access.
    assert.equal((await fetch(`${base}/api/shares`)).status, 503);
  });
});
