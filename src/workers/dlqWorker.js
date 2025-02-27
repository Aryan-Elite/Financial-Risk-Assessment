require("dotenv").config({ path: __dirname + "/../../.env" }); // Load environment variables
const AWS = require("aws-sdk");
const dynamoDB = require("../config/db");
const sqs = new AWS.SQS();

const DLQ_URL = process.env.SQS_DLQ_URL; // Dead Letter Queue URL

if (!DLQ_URL) {
    console.error("❌ ERROR: SQS_DLQ_URL is missing in .env file");
    process.exit(1);
}

// ✅ Function to Check if Record Exists in DynamoDB
async function recordExists(company_id, reporting_period) {
    const params = {
        TableName: process.env.DYNAMODB_FINANCIAL_TABLE,
        Key: { company_id, reporting_period }
    };

    const result = await dynamoDB.get(params).promise();
    return result.Item ? true : false;
}

// ✅ Function to Process a Single Failed Record
async function processFailedRecord(record, receiptHandle) {
    try {
        // 🔍 **Check if record already exists before retrying**
        const exists = await recordExists(record.company_id, record.reporting_period);
        if (exists) {
            console.log(`⚠️ Skipping record (Already exists in DB): ${record.company_id} - ${record.reporting_period}`);

            // ✅ DELETE from DLQ because it already exists in DB
            await sqs.deleteMessage({
                QueueUrl: DLQ_URL,
                ReceiptHandle: receiptHandle,
            }).promise();
            console.log(`🗑️ Deleted duplicate record from DLQ: ${record.company_id} - ${record.reporting_period}`);
            
            return true; // Mark as successful to remove from DLQ
        }

        // ✅ Insert the record into DynamoDB
        const putParams = {
            TableName: process.env.DYNAMODB_FINANCIAL_TABLE,
            Item: {
                id: record.recordId || `dlq-${Date.now()}`, // Ensure unique ID
                ...record,
                createdAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(company_id) AND attribute_not_exists(reporting_period)"
        };

        await dynamoDB.put(putParams).promise();
        console.log(`✅ Successfully reprocessed failed record: ${record.company_id} - ${record.reporting_period}`);

        // ✅ DELETE from DLQ after successful processing
        await sqs.deleteMessage({
            QueueUrl: DLQ_URL,
            ReceiptHandle: receiptHandle,
        }).promise();
        console.log(`🗑️ Deleted successfully processed record from DLQ: ${record.company_id} - ${record.reporting_period}`);
        
        return true; // Successfully inserted

    } catch (error) {
        console.error(`❌ Failed again: ${error.message}`);
        return false; // Still failed
    }
}

// ✅ Poll the DLQ for Messages and Retry Processing
async function pollDLQ() {
    console.log("🔍 Starting DLQ Worker...");

    const params = { QueueUrl: DLQ_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 5 };

    while (true) {
        try {
            const response = await sqs.receiveMessage(params).promise();

            if (!response.Messages || response.Messages.length === 0) {
                continue; // No messages, keep polling
            }

            for (const message of response.Messages) {
                const record = JSON.parse(message.Body);
                const receiptHandle = message.ReceiptHandle; // ✅ Store message handle

                const success = await processFailedRecord(record, receiptHandle);

                if (!success) {
                    console.error(`⚠️ Record still failed. Keeping it in DLQ: ${record.company_id} - ${record.reporting_period}`);
                }
            }
        } catch (error) {
            console.error("❌ Error processing DLQ messages:", error.message);
        }
    }
}

// ✅ Start Polling DLQ in Background
pollDLQ();
