// TEST-ONLY in-memory share store. It copies the behaviour of the DynamoDB
// store in src/shareStore.js (never overwrite a token, conditional revoke),
// but nothing in the real server uses it.

const { ShareStoreError } = require('../../src/shareStore');

function createFakeShareStore() {
  const items = new Map();
  let failing = false;

  function checkFailure(operation) {
    if (failing) {
      throw new ShareStoreError(operation, new Error('simulated database outage'));
    }
  }

  return {
    items,
    setFailing(value) {
      failing = value;
    },

    async createShare(record) {
      checkFailure('createShare');
      if (items.has(record.token)) {
        return false;
      }
      items.set(record.token, structuredClone(record));
      return true;
    },

    async getShare(token) {
      checkFailure('getShare');
      const item = items.get(token);
      return item ? structuredClone(item) : null;
    },

    async listSharesByOwner(ownerId) {
      checkFailure('listSharesByOwner');
      return [...items.values()].filter((item) => item.ownerId === ownerId).map((item) => structuredClone(item));
    },

    async revokeShare(token, ownerId, nowIso) {
      checkFailure('revokeShare');
      const item = items.get(token);
      if (!item || item.ownerId !== ownerId || item.revokedAt || !(item.expiresAt > nowIso)) {
        return false;
      }
      item.revokedAt = nowIso;
      return true;
    }
  };
}

module.exports = { createFakeShareStore };
