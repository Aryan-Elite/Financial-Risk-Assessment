require("dotenv").config();
const dynamoDB = require("../config/db"); 
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const TABLE_NAME = process.env.DYNAMODB_USERS_TABLE; 

const User = {
  // Create a new user
  async createUser({ name, email, phone, password }) {
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const user = {
      user_id: uuidv4(),
      name,
      email,
      phone,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
    };

    const params = {
      TableName: TABLE_NAME,
      Item: user,
    };

    await dynamoDB.put(params).promise();
    return user;
  },

  // Find user by email
  async getUserByEmail(email) {
    const params = {
      TableName: TABLE_NAME,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email,
      },
    };

    const result = await dynamoDB.query(params).promise();
    return result.Items.length > 0 ? result.Items[0] : null;
  },

  // Find user by ID
  async getUserById(user_id) {
    const params = {
      TableName: TABLE_NAME,
      Key: { user_id },
    };

    const result = await dynamoDB.get(params).promise();
    return result.Item || null;
  },
};

module.exports = User;
