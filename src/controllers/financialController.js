const AWS = require("aws-sdk");
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const lambda = new AWS.Lambda();
const sqs = new AWS.SQS();
const { v4: uuidv4 } = require("uuid");
const redis = require("../config/redis");
exports.uploadFinancialData = async (req, res) => {
    try {
        const records = req.body;
        if (!Array.isArray(records) || records.length === 0) {
            return res.status(400).json({ message: "Invalid input. Expecting an array of records." });
        }
   console.log('Records in body are ',records);
   
        // ✅ Generate a unique batch ID
        const batchId = `batch-${Date.now()}`;

        // ✅ Store batch metadata in DynamoDB
        const batchMetadata = {
            batch_id: batchId,
            total_records: records.length,
            successful_records: 0,
            failed_records: 0,
            status: "Processing",
            created_at: new Date().toISOString(),
        };

        await dynamoDB.put({
            TableName: process.env.DYNAMODB_BATCH_TABLE,
            Item: batchMetadata
        }).promise();

        // ✅ Attach batch_id to each record
        const enrichedRecords = records.map(record => ({
            ...record,
            batch_id: batchId
        }));
        console.log('enriched ',enrichedRecords);
        

        // ✅ Send records to SQS
        await sqs.sendMessage({
            QueueUrl: process.env.SQS_QUEUE_URL,
            MessageBody: JSON.stringify(enrichedRecords),
        }).promise();

        res.status(202).json({
            message: "Data queued for processing.",
            batch_id: batchId,
            status_endpoint: `/api/v1/finance/batch-status?batch_id=${batchId}`
        });

    } catch (error) {
        res.status(500).json({ message: "Failed to queue data.", error: error.message });
    }
};

exports.getBatchStatus = async (req, res) => {
    const { batch_id } = req.query;
    if (!batch_id) {
        return res.status(400).json({ message: "Batch ID is required." });
    }

    const params = {
        TableName: process.env.DYNAMODB_BATCH_TABLE,
        Key: { batch_id }
    };

    const result = await dynamoDB.get(params).promise();

    if (!result.Item) {
        return res.status(404).json({ message: "Batch not found." });
    }

    res.json(result.Item);
};



exports.getRiskAssessment = async (req, res) => {
    try {
        const { company_id, reporting_period, industry_sector } = req.query;

        if (!company_id && !reporting_period && !industry_sector) {
            return res.status(400).json({ message: "At least one filter is required." });
        }

        let params = {
            TableName: process.env.DYNAMODB_FINANCIAL_TABLE,
            ExpressionAttributeValues: {}
        };

        let result;

        // ✅ Case 1: Search by `company_id` (Primary Key)
        if (company_id) {
            params.KeyConditionExpression = "company_id = :company_id";
            params.ExpressionAttributeValues[":company_id"] = company_id;

            if (reporting_period) {
                params.KeyConditionExpression += " AND reporting_period = :reporting_period";
                params.ExpressionAttributeValues[":reporting_period"] = reporting_period;
            }

            result = await dynamoDB.query(params).promise();
        }

        // ✅ Case 2: Search by `industry_sector` (Using GSI)
        else if (industry_sector && !reporting_period) {
            params.IndexName = "IndustrySectorIndex";  // ✅ Ensure this matches the index name
            params.KeyConditionExpression = "industry_sector = :industry_sector";
            params.ExpressionAttributeValues = { ":industry_sector": industry_sector };            
            result = await dynamoDB.query(params).promise();
        }

        // ✅ Case 3: Search by `reporting_period` (Fallback to scan)
        else if (reporting_period && !industry_sector) {
            params.FilterExpression = "reporting_period = :reporting_period";
            params.ExpressionAttributeValues[":reporting_period"] = reporting_period;

            result = await dynamoDB.scan(params).promise();
        }

        // ✅ Case 4: Search by `reporting_period` AND `industry_sector`
        else if (industry_sector && reporting_period) {
            params.IndexName = "IndustrySectorIndex";  // ✅ Use the GSI
            params.KeyConditionExpression = "industry_sector = :industry_sector";
            params.FilterExpression = "reporting_period = :reporting_period";
            params.ExpressionAttributeValues[":industry_sector"] = industry_sector;
            params.ExpressionAttributeValues[":reporting_period"] = reporting_period;

            result = await dynamoDB.query(params).promise();
        }

        if (!result || !result.Items || result.Items.length === 0) {
            return res.status(404).json({ message: "No records found." });
        }

        console.log("📌 Records fetched from DB:", result.Items);

        // ✅ Invoke Lambda for Risk Calculation
        const lambdaParams = {
            FunctionName: process.env.LAMBDA_RISK_FUNCTION,  // Lambda function name
            InvocationType: "RequestResponse",
            Payload: JSON.stringify({ records: result.Items })  // ✅ Send records to Lambda
        };

        const lambdaResponse = await lambda.invoke(lambdaParams).promise();
        const enrichedRecords = JSON.parse(lambdaResponse.Payload);

        // ✅ Return Enriched Data
        return res.json({ message: "Risk assessment completed.", data: JSON.parse(enrichedRecords.body) });

    } catch (error) {
        console.error("❌ Error fetching risk assessment:", error);
        return res.status(500).json({ message: "Server error.", error: error.message });
    }
};
