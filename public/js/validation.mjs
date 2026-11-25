// Checks done in the browser before calling the API. The backend repeats
// every check, so these only give faster, friendlier feedback.

export const MIN_TIMETABLES = 2;
export const MAX_TIMETABLES = 5;
export const MIN_EXPIRY_DAYS = 1;
export const MAX_EXPIRY_DAYS = 30;

export const CRITERIA = [
  { value: 'mostFreeDays', label: 'Most free days' },
  { value: 'leastGaps', label: 'Least total gaps' },
  { value: 'latestStart', label: 'Latest earliest start' },
  { value: 'earliestEnd', label: 'Earliest latest end' }
];

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidCriterion(value) {
  return CRITERIA.some((criterion) => criterion.value === value);
}

// Splits typed ids such as "tt-1, tt-2" into a clean list.
export function parseIdList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

// Returns an error message, or null when the selection is fine.
export function validateSelection(ids) {
  if (ids.length < MIN_TIMETABLES) {
    return `Select at least ${MIN_TIMETABLES} timetables to compare.`;
  }
  if (ids.length > MAX_TIMETABLES) {
    return `You can compare at most ${MAX_TIMETABLES} timetables.`;
  }
  if (new Set(ids).size !== ids.length) {
    return 'Each timetable can only be selected once.';
  }
  return null;
}

// Returns { ok: true, days } or { ok: false, message }.
export function validateExpiryDays(value) {
  const text = String(value).trim();
  const days = Number(text);
  if (!/^\d+$/.test(text) || days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
    return { ok: false, message: `Choose a whole number of days from ${MIN_EXPIRY_DAYS} to ${MAX_EXPIRY_DAYS}.` };
  }
  return { ok: true, days };
}

// The share token goes in the "#" part of the address. Browsers do not send
// that part to servers or in the Referer header, so it stays out of logs.
export function buildShareUrl(shareToken, origin) {
  return `${origin}/shared.html#${encodeURIComponent(shareToken)}`;
}

export function parseShareToken(hash) {
  let token = String(hash || '').replace(/^#/, '');
  try {
    token = decodeURIComponent(token);
  } catch {
    return null;
  }
  return SHARE_TOKEN_PATTERN.test(token) ? token : null;
}

export function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function formatDateTime(isoText) {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
