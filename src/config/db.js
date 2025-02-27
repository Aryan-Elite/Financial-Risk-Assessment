require("dotenv").config({ path: __dirname + "/../../.env" });  // Load from root
const AWS = require("aws-sdk");
require("aws-sdk/lib/maintenance_mode_message").suppress = true;


// console.log(process.env.AWS_REGION);

// Configure AWS SDK with credentials
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Create DynamoDB DocumentClient
const dynamoDB = new AWS.DynamoDB.DocumentClient();

module.exports = dynamoDB;
