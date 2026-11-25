// TEST-ONLY minimal DOM, so the page scripts can be tested in Node without a
// browser or extra packages. Setting innerHTML (or similar) throws on purpose:
// the pages must only use textContent and safe DOM methods.

class FakeText {
  constructor(text) {
    this.textContent = String(text);
    this.children = [];
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = {};
    this.ownText = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.type = '';
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value);
  }

  set innerHTML(value) {
    throw new Error('innerHTML must not be used');
  }

  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML must not be used');
  }

  append(...nodes) {
    for (const node of nodes) {
      this.children.push(typeof node === 'string' ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  // Fires an event and returns the results of the listeners (they may be promises).
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    return (this.listeners[type] || []).map((listener) => listener(event));
  }

  async click() {
    if (!this.disabled) {
      await Promise.all(this.dispatch('click'));
    }
  }
}

function createFakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text)
  };
}

// Every element under root (depth first) that matches the test.
function findAll(root, matches) {
  const found = [];
  for (const child of root.children || []) {
    if (child instanceof FakeElement && matches(child)) found.push(child);
    found.push(...findAll(child, matches));
  }
  return found;
}

const byTag = (root, tag) => findAll(root, (node) => node.tagName === tag.toUpperCase());

module.exports = { createFakeDocument, FakeElement, findAll, byTag };
