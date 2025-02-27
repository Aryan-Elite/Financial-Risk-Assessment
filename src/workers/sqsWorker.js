require("dotenv").config({ path: __dirname + "/../../.env" });
const AWS = require("aws-sdk");
const dynamoDB = require("../config/db");
const { v4: uuidv4 } = require("uuid");

const sqs = new AWS.SQS({ region: process.env.AWS_REGION });
const QUEUE_URL = process.env.SQS_QUEUE_URL;
const DLQ_URL = process.env.SQS_DLQ_URL;

if (!QUEUE_URL || !DLQ_URL) {
    console.error("❌ ERROR: SQS_QUEUE_URL or SQS_DLQ_URL is missing in .env file");
    process.exit(1);
}

// ✅ Function to Process Financial Data from SQS and Insert into DynamoDB
async function processFinancialData(records, batchId) {
    let successfulRecords = 0;
    let failedRecords = 0;

    console.log(`📌 Processing batch: ${batchId}, Records: ${records.length}`);

    const transactItems = records.map(record => ({
        Put: {
            TableName: process.env.DYNAMODB_FINANCIAL_TABLE,
            Item: {
                id: record.recordId || uuidv4(),
                batch_id: batchId,
                ...record,
                createdAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(company_id) AND attribute_not_exists(reporting_period)"
        }
    }));

    try {
        await dynamoDB.transactWrite({ TransactItems: transactItems }).promise();
        successfulRecords = records.length;
        console.log(`✅ Batch ${batchId} processed successfully!`);
    } catch (error) {
        console.error(`❌ Transaction failed for batch ${batchId}:`, error.message);
        failedRecords = records.length;

        for (const record of records) {
            await sqs.sendMessage({
                QueueUrl: DLQ_URL,
                MessageBody: JSON.stringify(record),
            }).promise();
        }
    }

    // ✅ Ensure batch exists before updating
    const batchExists = await dynamoDB.get({
        TableName: process.env.DYNAMODB_BATCH_TABLE,
        Key: { batch_id: batchId }
    }).promise();

    if (batchExists.Item) {
        // ✅ Update batch status in DynamoDB
        await dynamoDB.update({
            TableName: process.env.DYNAMODB_BATCH_TABLE,
            Key: { batch_id: batchId },
            UpdateExpression: "SET successful_records = :s, failed_records = :f, #s = :status",
            ExpressionAttributeValues: {
                ":s": successfulRecords,
                ":f": failedRecords,
                ":status": "Completed"
            },
            ExpressionAttributeNames: { "#s": "status" }
        }).promise();
    }
}

// ✅ Poll SQS Queue for Messages
async function pollQueue() {
    console.log("🔍 Starting SQS Worker...");

    const params = {
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
    };

    while (true) {
        try {
            const response = await sqs.receiveMessage(params).promise();

            if (!response.Messages || response.Messages.length === 0) {
                continue;
            }

            for (const message of response.Messages) {
                const records = JSON.parse(message.Body);
                const batchId = records[0]?.batch_id;
                await processFinancialData(records, batchId);

                await sqs.deleteMessage({
                    QueueUrl: QUEUE_URL,
                    ReceiptHandle: message.ReceiptHandle,
                }).promise();
            }
        } catch (error) {
            console.error("❌ Error processing SQS messages:", error.message);
        }
    }
}

pollQueue();


