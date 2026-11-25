import { el, showStatus, clearStatus, setBusy } from './dom.mjs';
import {
  CRITERIA,
  MAX_TIMETABLES,
  isValidCriterion,
  parseIdList,
  validateSelection,
  formatMinutes
} from './validation.mjs';

// Compare page. `elements` are the page's DOM nodes (see index.html), so the
// same code can be tested with a fake document.
export function createComparePage({ doc, elements, api, source }) {
  const e = elements;
  let manualMode = false;
  let checkboxes = [];

  for (const criterion of CRITERIA) {
    e.criterion.append(el(doc, 'option', { text: criterion.label, attrs: { value: criterion.value } }));
  }
  e.criterion.value = CRITERIA[0].value;

  function selectedIds() {
    if (manualMode) return parseIdList(e.manualInput.value);
    return checkboxes.filter((box) => box.checked).map((box) => box.value);
  }

  // At most 5 boxes can be ticked: the others are disabled once 5 are chosen.
  function updateSelection() {
    const count = selectedIds().length;
    if (!manualMode) {
      for (const box of checkboxes) {
        box.disabled = !box.checked && count >= MAX_TIMETABLES;
      }
    }
    e.selectionHint.textContent = `${count} selected (choose 2 to 5).`;
  }

  function showManualEntry(message) {
    manualMode = true;
    e.manualField.hidden = false;
    e.picker.replaceChildren(el(doc, 'p', { className: 'muted', text: message }));
    updateSelection();
  }

  function renderPicker(timetables) {
    checkboxes = [];
    const items = timetables.map((timetable) => {
      const id = `tt-option-${checkboxes.length}`;
      const box = el(doc, 'input', { attrs: { type: 'checkbox', id } });
      box.type = 'checkbox';
      box.value = timetable.id;
      box.addEventListener('change', updateSelection);
      checkboxes.push(box);
      return el(doc, 'li', { className: 'choice' }, [
        box,
        el(doc, 'label', { attrs: { for: id } }, [
          el(doc, 'span', { className: 'choice-name', text: timetable.name || timetable.id }),
          el(doc, 'span', { className: 'choice-id', text: timetable.id })
        ])
      ]);
    });
    e.picker.replaceChildren(el(doc, 'ul', { className: 'choice-list' }, items));
    updateSelection();
  }

  async function load() {
    clearStatus(e.status);
    e.results.replaceChildren();
    if (!api.isSignedIn()) {
      showStatus(e.status, doc, 'info', 'You are not signed in. Sign in through the Class Timetable Builder login to compare your timetables.');
      e.compareButton.disabled = true;
      return;
    }
    e.compareButton.disabled = false;
    e.picker.replaceChildren(el(doc, 'p', { className: 'muted', text: 'Loading your saved timetables…' }));

    const result = await source.listSavedTimetables();
    if (result.ok && result.data.length === 0) {
      e.picker.replaceChildren(el(doc, 'p', { className: 'muted', text: 'You have no saved timetables yet. Generate and save timetables first.' }));
      e.compareButton.disabled = true;
    } else if (result.ok) {
      renderPicker(result.data);
    } else if (result.code === 'NOT_CONFIGURED') {
      showManualEntry('Your saved timetable list is not connected yet. Type the ids of the timetables you want to compare.');
    } else {
      showStatus(e.status, doc, 'error', result.message);
      showManualEntry('Your saved timetables could not be loaded. You can still type timetable ids.');
    }
  }

  function renderResults(data) {
    const criterionLabel = (CRITERIA.find((c) => c.value === data.criterion) || {}).label || data.criterion;
    const header = el(doc, 'tr', {}, ['Rank', 'Timetable', 'Free days', 'Total gaps', 'Earliest start', 'Latest end']
      .map((title) => el(doc, 'th', { text: title, attrs: { scope: 'col' } })));
    const rows = data.results.map((result) => {
      const m = result.metrics;
      return el(doc, 'tr', { className: result.rank === 1 ? 'best' : '' }, [
        el(doc, 'td', { text: `#${result.rank}` }),
        el(doc, 'th', { attrs: { scope: 'row' } }, [
          el(doc, 'span', { className: 'choice-name', text: result.name || result.timetableId }),
          el(doc, 'span', { className: 'choice-id', text: result.timetableId })
        ]),
        el(doc, 'td', { text: String(m.freeDays) }),
        el(doc, 'td', { text: formatMinutes(m.totalGapMinutes) }),
        el(doc, 'td', { text: m.earliestStart || '—' }),
        el(doc, 'td', { text: m.latestEnd || '—' })
      ]);
    });
    e.results.replaceChildren(
      el(doc, 'h2', { text: `Ranked by: ${criterionLabel}` }),
      el(doc, 'div', { className: 'table-wrap' }, [
        el(doc, 'table', { className: 'results-table' }, [el(doc, 'thead', {}, [header]), el(doc, 'tbody', {}, rows)])
      ])
    );
  }

  async function compare() {
    clearStatus(e.status);
    const ids = selectedIds();
    const selectionError = validateSelection(ids);
    if (selectionError) {
      showStatus(e.status, doc, 'error', selectionError);
      return;
    }
    if (!isValidCriterion(e.criterion.value)) {
      showStatus(e.status, doc, 'error', 'Choose how the timetables should be ranked.');
      return;
    }

    setBusy(e.compareButton, true, 'Comparing…');
    e.results.setAttribute('aria-busy', 'true');
    const result = await api.compare(ids, e.criterion.value);
    setBusy(e.compareButton, false);
    e.results.setAttribute('aria-busy', 'false');

    if (!result.ok) {
      e.results.replaceChildren();
      showStatus(e.status, doc, 'error', result.message, result.details || []);
      return;
    }
    renderResults(result.data);
    showStatus(e.status, doc, 'success', `Compared ${result.data.results.length} timetables.`);
  }

  e.manualInput.addEventListener('input', updateSelection);
  e.form.addEventListener('submit', (event) => {
    event.preventDefault();
    compare();
  });

  return { load, compare, selectedIds };
}
