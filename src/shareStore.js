const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand
} = require('@aws-sdk/lib-dynamodb');

// Thrown when the database cannot be reached or answers with an error.
// The routes turn it into a 503 without showing the real message to the client.
class ShareStoreError extends Error {
  constructor(operation, cause) {
    super(`Share storage failed during ${operation}`);
    this.name = 'ShareStoreError';
    this.cause = cause;
  }
}

const OWNER_INDEX_NAME = 'ownerId-index';

// DynamoDB storage for share links.
//
// Table (partition key "token"):
//   token       random share token
//   ownerId     the user who created the link (also the key of the ownerId-index GSI)
//   timetableId the shared timetable
//   snapshot    read-only copy of the timetable taken when the link was created
//   createdAt   ISO time
//   expiresAt   ISO time, checked by the application on every read
//   expiresAtEpoch  same time in seconds, usable for DynamoDB TTL clean-up
//   revokedAt   ISO time, only present once the link is revoked
function createDynamoShareStore({ tableName, documentClient }) {
  async function run(operation, command) {
    try {
      return await documentClient.send(command);
    } catch (err) {
      if (err && err.name === 'ConditionalCheckFailedException') {
        return null;
      }
      throw new ShareStoreError(operation, err);
    }
  }

  // Returns false if the token already exists, so nothing is ever overwritten.
  async function createShare(record) {
    const result = await run('createShare', new PutCommand({
      TableName: tableName,
      Item: record,
      ConditionExpression: 'attribute_not_exists(#token)',
      ExpressionAttributeNames: { '#token': 'token' }
    }));
    return result !== null;
  }

  async function getShare(token) {
    const result = await run('getShare', new GetCommand({
      TableName: tableName,
      Key: { token },
      ConsistentRead: true
    }));
    return (result && result.Item) || null;
  }

  async function listSharesByOwner(ownerId) {
    const items = [];
    let startKey;
    do {
      const result = await run('listSharesByOwner', new QueryCommand({
        TableName: tableName,
        IndexName: OWNER_INDEX_NAME,
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: { ':ownerId': ownerId },
        ExclusiveStartKey: startKey
      }));
      items.push(...result.Items);
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  // One conditional update, so the owner check and the revoke happen together
  // and two requests cannot both succeed. Returns false when the link does not
  // exist, belongs to someone else, is already revoked or has expired.
  async function revokeShare(token, ownerId, nowIso) {
    const result = await run('revokeShare', new UpdateCommand({
      TableName: tableName,
      Key: { token },
      UpdateExpression: 'SET revokedAt = :now',
      ConditionExpression:
        'attribute_exists(#token) AND ownerId = :ownerId AND attribute_not_exists(revokedAt) AND expiresAt > :now',
      ExpressionAttributeNames: { '#token': 'token' },
      ExpressionAttributeValues: { ':ownerId': ownerId, ':now': nowIso }
    }));
    return result !== null;
  }

  return { createShare, getShare, listSharesByOwner, revokeShare };
}

// Builds the real store from environment variables. Throws if the settings are
// missing, so the server refuses to start instead of falling back to memory.
// AWS credentials are NOT read here; the AWS SDK finds them itself
// (environment variables, AWS profile, or the Lambda role).
function createShareStoreFromEnv(env = process.env) {
  const tableName = env.SHARE_TABLE_NAME;
  const region = env.AWS_REGION;
  if (!tableName || !region) {
    throw new Error('SHARE_TABLE_NAME and AWS_REGION must be set');
  }
  const clientOptions = { region };
  if (env.DYNAMODB_ENDPOINT) {
    clientOptions.endpoint = env.DYNAMODB_ENDPOINT; // e.g. a local AWS emulator such as Floci
  }
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(clientOptions), {
    marshallOptions: { removeUndefinedValues: true }
  });
  return createDynamoShareStore({ tableName, documentClient });
}

module.exports = {
  ShareStoreError,
  OWNER_INDEX_NAME,
  createDynamoShareStore,
  createShareStoreFromEnv
};
