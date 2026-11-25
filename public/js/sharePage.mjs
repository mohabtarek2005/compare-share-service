import { el, showStatus, clearStatus, setBusy } from './dom.mjs';
import { MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS, validateExpiryDays, buildShareUrl, formatDateTime } from './validation.mjs';

// Share page: create a link, copy it, list active links and revoke them.
// Browser features (clipboard, confirm, page origin) are passed in so the
// page can be tested without a real browser.
export function createSharePage({ doc, elements, api, source, origin, copyText, confirmAction }) {
  const e = elements;
  let manualMode = false;

  e.expiryInput.setAttribute('min', MIN_EXPIRY_DAYS);
  e.expiryInput.setAttribute('max', MAX_EXPIRY_DAYS);

  function chosenTimetableId() {
    return (manualMode ? e.manualInput.value : e.timetableSelect.value).trim();
  }

  function showManualEntry(message) {
    manualMode = true;
    e.manualField.hidden = false;
    e.selectField.hidden = true;
    e.pickerNote.textContent = message;
  }

  async function loadTimetables() {
    const result = await source.listSavedTimetables();
    if (result.ok) {
      manualMode = false;
      e.manualField.hidden = true;
      e.selectField.hidden = false;
      const options = result.data.map((tt) => el(doc, 'option', { text: tt.name || tt.id, attrs: { value: tt.id } }));
      e.timetableSelect.replaceChildren(el(doc, 'option', { text: 'Choose a timetable', attrs: { value: '' } }), ...options);
      e.timetableSelect.value = '';
      e.pickerNote.textContent = result.data.length === 0 ? 'You have no saved timetables yet.' : '';
    } else if (result.code === 'NOT_CONFIGURED') {
      showManualEntry('Your saved timetable list is not connected yet. Type the id of the timetable to share.');
    } else {
      showManualEntry('Your saved timetables could not be loaded. You can still type a timetable id.');
    }
  }

  function linkRow(label, url) {
    const input = el(doc, 'input', { className: 'link-output', attrs: { type: 'text', readonly: 'readonly', 'aria-label': label } });
    input.value = url;
    const button = el(doc, 'button', { className: 'button secondary', text: 'Copy link', attrs: { type: 'button' } });
    button.addEventListener('click', () => copyLink(url, button));
    return el(doc, 'div', { className: 'link-row' }, [input, button]);
  }

  async function copyLink(url, button) {
    try {
      await copyText(url);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed: select the link and copy it';
    }
  }

  async function createShare() {
    clearStatus(e.createStatus);
    const timetableId = chosenTimetableId();
    if (!timetableId) {
      showStatus(e.createStatus, doc, 'error', 'Choose the timetable you want to share.');
      return;
    }
    const expiry = validateExpiryDays(e.expiryInput.value);
    if (!expiry.ok) {
      showStatus(e.createStatus, doc, 'error', expiry.message);
      return;
    }

    setBusy(e.createButton, true, 'Creating link…');
    const result = await api.createShare(timetableId, expiry.days);
    setBusy(e.createButton, false);
    if (!result.ok) {
      e.newLink.replaceChildren();
      showStatus(e.createStatus, doc, 'error', result.message, result.details || []);
      return;
    }

    const url = buildShareUrl(result.data.token, origin);
    showStatus(e.createStatus, doc, 'success', `Share link created. It works until ${formatDateTime(result.data.expiresAt)}.`);
    e.newLink.replaceChildren(linkRow('New share link', url));
    await loadShares();
  }

  async function revoke(share, button) {
    if (!confirmAction('Revoke this share link? People who have it will no longer be able to open it.')) {
      return;
    }
    setBusy(button, true, 'Revoking…');
    const result = await api.revokeShare(share.token);
    setBusy(button, false);
    if (result.ok) {
      showStatus(e.listStatus, doc, 'success', 'The share link was revoked.');
    } else if (result.status === 404) {
      showStatus(e.listStatus, doc, 'info', 'This link was already revoked or has expired.');
    } else {
      showStatus(e.listStatus, doc, 'error', result.message);
      return;
    }
    await loadShares({ keepStatus: true });
  }

  async function loadShares({ keepStatus = false } = {}) {
    if (!keepStatus) clearStatus(e.listStatus);
    e.sharesList.setAttribute('aria-busy', 'true');
    e.sharesList.replaceChildren(el(doc, 'p', { className: 'muted', text: 'Loading your share links…' }));
    const result = await api.listShares();
    e.sharesList.setAttribute('aria-busy', 'false');

    if (!result.ok) {
      e.sharesList.replaceChildren();
      showStatus(e.listStatus, doc, 'error', result.message);
      return;
    }
    if (result.data.shares.length === 0) {
      e.sharesList.replaceChildren(el(doc, 'p', { className: 'muted', text: 'You have no active share links.' }));
      return;
    }
    const items = result.data.shares.map((share) => {
      const revokeButton = el(doc, 'button', { className: 'button danger', text: 'Revoke', attrs: { type: 'button' } });
      revokeButton.addEventListener('click', () => revoke(share, revokeButton));
      return el(doc, 'li', { className: 'share-item' }, [
        el(doc, 'div', { className: 'share-info' }, [
          el(doc, 'span', { className: 'choice-name', text: share.timetableName || share.timetableId }),
          el(doc, 'span', { className: 'muted', text: `Expires ${formatDateTime(share.expiresAt)}` })
        ]),
        linkRow(`Share link for ${share.timetableName || share.timetableId}`, buildShareUrl(share.token, origin)),
        revokeButton
      ]);
    });
    e.sharesList.replaceChildren(el(doc, 'ul', { className: 'share-list' }, items));
  }

  async function load() {
    if (!api.isSignedIn()) {
      showStatus(e.createStatus, doc, 'info', 'You are not signed in. Sign in through the Class Timetable Builder login to share your timetables.');
      e.createButton.disabled = true;
      e.sharesList.replaceChildren();
      return;
    }
    e.createButton.disabled = false;
    await Promise.all([loadTimetables(), loadShares()]);
  }

  e.form.addEventListener('submit', (event) => {
    event.preventDefault();
    createShare();
  });

  return { load, createShare, loadShares };
}
