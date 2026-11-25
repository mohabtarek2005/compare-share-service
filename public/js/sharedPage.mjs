import { el, showStatus, clearStatus, setBusy } from './dom.mjs';
import { parseShareToken, formatDateTime } from './validation.mjs';

const DAY_ORDER = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_NAMES = { SUN: 'Sunday', MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday' };

// Read-only page for a shared timetable. The token comes from the "#" part of
// the address. saveFile(blob, fileName) starts the browser download.
export function createSharedPage({ doc, elements, api, hash, saveFile }) {
  const e = elements;
  const token = parseShareToken(hash);

  function showUnavailable(message) {
    e.details.hidden = true;
    showStatus(e.status, doc, 'error', message);
  }

  function renderTimetable(share) {
    const timetable = share.timetable;
    e.title.textContent = timetable.name || 'Shared timetable';
    e.meta.textContent = `Read-only copy. Available until ${formatDateTime(share.expiresAt)}.`;

    const meetings = [];
    for (const section of timetable.sections) {
      for (const meeting of section.meetings) {
        meetings.push({ ...meeting, courseCode: section.courseCode, type: section.type, sectionId: section.sectionId });
      }
    }
    meetings.sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || a.startTime.localeCompare(b.startTime));

    const header = el(doc, 'tr', {}, ['Day', 'Time', 'Course', 'Type', 'Section']
      .map((title) => el(doc, 'th', { text: title, attrs: { scope: 'col' } })));
    const rows = meetings.map((m) => el(doc, 'tr', {}, [
      el(doc, 'td', { text: DAY_NAMES[m.day] || m.day }),
      el(doc, 'td', { text: `${m.startTime}–${m.endTime}` }),
      el(doc, 'td', { text: m.courseCode }),
      el(doc, 'td', { text: m.type }),
      el(doc, 'td', { text: m.sectionId })
    ]));
    e.schedule.replaceChildren(
      el(doc, 'div', { className: 'table-wrap' }, [
        el(doc, 'table', { className: 'results-table' }, [el(doc, 'thead', {}, [header]), el(doc, 'tbody', {}, rows)])
      ])
    );
    e.details.hidden = false;
  }

  async function load() {
    e.details.hidden = true;
    if (!token) {
      showUnavailable('This share link is not valid. Check that you copied the whole link.');
      return;
    }
    if (!api.isSignedIn()) {
      showStatus(e.status, doc, 'info', 'Sign in through the Class Timetable Builder login to view this shared timetable.');
      return;
    }
    showStatus(e.status, doc, 'loading', 'Loading the shared timetable…');
    const result = await api.getShare(token);
    if (!result.ok) {
      showUnavailable(result.message);
      return;
    }
    clearStatus(e.status);
    renderTimetable(result.data);
  }

  async function download() {
    clearStatus(e.downloadStatus);
    setBusy(e.downloadButton, true, 'Preparing download…');
    const result = await api.downloadCalendar(token);
    setBusy(e.downloadButton, false);
    if (!result.ok) {
      showStatus(e.downloadStatus, doc, 'error', result.message);
      return;
    }
    saveFile(result.data.blob, result.data.fileName);
    showStatus(e.downloadStatus, doc, 'success', 'Calendar file downloaded. Open it to add the classes to your calendar.');
  }

  e.downloadButton.addEventListener('click', download);

  return { load, download, token };
}
