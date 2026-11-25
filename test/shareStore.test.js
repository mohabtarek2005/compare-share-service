// Tests the DynamoDB share store with a MOCK document client. They check the
// commands that would be sent to DynamoDB; they do not talk to a real database.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createDynamoShareStore,
  createShareStoreFromEnv,
  ShareStoreError,
  OWNER_INDEX_NAME
} = require('../src/shareStore');

function createMockClient(answer) {
  const sent = [];
  return {
    sent,
    send: async (command) => {
      sent.push({ type: command.constructor.name, input: command.input });
      return answer(command, sent.length);
    }
  };
}

function conditionalFailure() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

describe('DynamoDB share store (mock client)', () => {
  test('createShare uses a conditional put so a token is never overwritten', async () => {
    const client = createMockClient(() => ({}));
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });
    const record = { token: 'abc', ownerId: 'student-a' };

    assert.equal(await store.createShare(record), true);
    assert.equal(client.sent[0].type, 'PutCommand');
    assert.deepEqual(client.sent[0].input, {
      TableName: 'share_links',
      Item: record,
      ConditionExpression: 'attribute_not_exists(#token)',
      ExpressionAttributeNames: { '#token': 'token' }
    });
  });

  test('createShare returns false when the token already exists', async () => {
    const client = createMockClient(() => {
      throw conditionalFailure();
    });
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });
    assert.equal(await store.createShare({ token: 'abc' }), false);
  });

  test('getShare does a consistent read and returns null when missing', async () => {
    const client = createMockClient((command, count) => (count === 1 ? { Item: { token: 'abc' } } : {}));
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });

    assert.deepEqual(await store.getShare('abc'), { token: 'abc' });
    assert.equal(await store.getShare('missing'), null);
    assert.equal(client.sent[0].type, 'GetCommand');
    assert.deepEqual(client.sent[0].input, { TableName: 'share_links', Key: { token: 'abc' }, ConsistentRead: true });
  });

  test('listSharesByOwner queries the ownerId index and follows every page', async () => {
    const client = createMockClient((command, count) =>
      count === 1
        ? { Items: [{ token: 't1' }], LastEvaluatedKey: { token: 't1' } }
        : { Items: [{ token: 't2' }] }
    );
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });

    assert.deepEqual(await store.listSharesByOwner('student-a'), [{ token: 't1' }, { token: 't2' }]);
    assert.equal(client.sent.length, 2);
    assert.equal(client.sent[0].type, 'QueryCommand');
    assert.equal(client.sent[0].input.IndexName, OWNER_INDEX_NAME);
    assert.equal(client.sent[0].input.KeyConditionExpression, 'ownerId = :ownerId');
    assert.deepEqual(client.sent[0].input.ExpressionAttributeValues, { ':ownerId': 'student-a' });
    assert.deepEqual(client.sent[1].input.ExclusiveStartKey, { token: 't1' });
  });

  test('revokeShare checks owner, revoked and expiry in the same conditional update', async () => {
    const client = createMockClient(() => ({}));
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });
    const now = '2026-11-23T10:00:00.000Z';

    assert.equal(await store.revokeShare('abc', 'student-a', now), true);
    const { type, input } = client.sent[0];
    assert.equal(type, 'UpdateCommand');
    assert.equal(input.UpdateExpression, 'SET revokedAt = :now');
    assert.equal(
      input.ConditionExpression,
      'attribute_exists(#token) AND ownerId = :ownerId AND attribute_not_exists(revokedAt) AND expiresAt > :now'
    );
    assert.deepEqual(input.ExpressionAttributeValues, { ':ownerId': 'student-a', ':now': now });
  });

  test('revokeShare returns false when the condition fails', async () => {
    const client = createMockClient(() => {
      throw conditionalFailure();
    });
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });
    assert.equal(await store.revokeShare('abc', 'student-b', '2026-11-23T10:00:00.000Z'), false);
  });

  test('other database errors become a ShareStoreError without the original message', async () => {
    const client = createMockClient(() => {
      throw new Error('secret connection detail');
    });
    const store = createDynamoShareStore({ tableName: 'share_links', documentClient: client });

    for (const call of [
      () => store.createShare({ token: 'abc' }),
      () => store.getShare('abc'),
      () => store.listSharesByOwner('student-a'),
      () => store.revokeShare('abc', 'student-a', 'now')
    ]) {
      await assert.rejects(call, (err) => {
        assert.ok(err instanceof ShareStoreError);
        assert.doesNotMatch(err.message, /secret connection detail/);
        return true;
      });
    }
  });

  test('refuses to build the real store without table and region settings', () => {
    assert.throws(() => createShareStoreFromEnv({}), /SHARE_TABLE_NAME and AWS_REGION must be set/);
    assert.throws(() => createShareStoreFromEnv({ SHARE_TABLE_NAME: 'share_links' }), /must be set/);
    assert.throws(() => createShareStoreFromEnv({ AWS_REGION: 'us-east-1' }), /must be set/);
  });

  test('builds the real store from settings without connecting yet', () => {
    const store = createShareStoreFromEnv({
      SHARE_TABLE_NAME: 'share_links',
      AWS_REGION: 'us-east-1',
      DYNAMODB_ENDPOINT: 'http://localhost:4566'
    });
    assert.equal(typeof store.createShare, 'function');
    assert.equal(typeof store.revokeShare, 'function');
  });
});
