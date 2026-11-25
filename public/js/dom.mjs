// Safe DOM helpers. Text always goes through textContent (never through HTML
// parsing), so names or ids that contain HTML are shown as plain text.

export function el(doc, tag, { className, text, attrs } = {}, children = []) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [name, value] of Object.entries(attrs || {})) {
    node.setAttribute(name, String(value));
  }
  if (children.length > 0) node.append(...children);
  return node;
}

// Shows a status message. kind: 'info', 'loading', 'success' or 'error'.
// Errors use role="alert" so screen readers announce them straight away.
export function showStatus(container, doc, kind, text, details = []) {
  container.hidden = false;
  container.className = `status status-${kind}`;
  container.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const children = [el(doc, 'p', { text })];
  if (details.length > 0) {
    children.push(el(doc, 'ul', {}, details.map((detail) => el(doc, 'li', { text: detail }))));
  }
  container.replaceChildren(...children);
}

export function clearStatus(container) {
  container.hidden = true;
  container.replaceChildren();
}

// Disables a button and swaps its label while work is running.
export function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.setAttribute('data-label', button.textContent);
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.getAttribute('data-label') || button.textContent;
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
}
