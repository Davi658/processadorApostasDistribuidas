#!/bin/sh
set -eu
export AWS_PAGER=""
endpoint="${SQS_ENDPOINT:-http://localstack:4566}"
sqs() { aws --endpoint-url "$endpoint" --region us-east-1 sqs "$@"; }

# CreateQueue is idempotent for matching attributes; SetQueueAttributes also
# reconciles redrive settings on an already existing queue.
for name in wager-transactions-dlq.fifo wager-transactions.fifo wager-events.fifo; do
  sqs create-queue --queue-name "$name" \
    --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null
done
dlq_url=$(sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
dlq_arn=$(sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
main_url=$(sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
printf '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"%s\",\"maxReceiveCount\":\"5\"}"}\n' "$dlq_arn" >/tmp/redrive.json
sqs set-queue-attributes --queue-url "$main_url" --attributes file:///tmp/redrive.json
for name in wager-transactions-dlq.fifo wager-transactions.fifo wager-events.fifo; do
  url=$(sqs get-queue-url --queue-name "$name" --query QueueUrl --output text)
  printf '%s\n' "$url"
  sqs get-queue-attributes --queue-url "$url" --attribute-names All
done
