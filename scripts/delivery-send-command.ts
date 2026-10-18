import { readFileSync } from 'node:fs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { parseWagerCommand } from '../src/application/messaging/wager-command';
const file = process.argv[2];
if (!file) throw new Error('Usage: bun run scripts/delivery-send-command.ts <json-file>');
const body = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const envelope = JSON.parse(body);
parseWagerCommand(body, { MessageGroupId: envelope.data.walletId, MessageDeduplicationId: envelope.commandId });
const endpoint = process.env.DELIVERY_SQS_ENDPOINT ?? 'http://127.0.0.1:45693';
const client = new SQSClient({ endpoint, useQueueUrlAsEndpoint: false, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
try {
  const result = await client.send(new SendMessageCommand({ QueueUrl: `${endpoint}/queue/us-east-1/000000000000/wager-transactions.fifo`,
    MessageBody: body, MessageGroupId: envelope.data.walletId, MessageDeduplicationId: envelope.commandId ?? crypto.randomUUID() }));
  // External envelopes may use fresh transport dedup IDs to exercise persistent Inbox.
  console.log(JSON.stringify({ transportMessageId: result.MessageId, envelopeMessageId: envelope.messageId ?? envelope.commandId }));
} finally { client.destroy(); }
