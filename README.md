# Financial Risk Assessment API

## Overview
The **Financial Risk Assessment API** is designed to manage financial data uploads, assess risk levels, and facilitate user authentication.

## Tech Stack
- **Backend**: Node.js, Express.js
- **Database**: DynamoDB
- **Messaging**: AWS SQS 
- **Cache**: Redis
- **Authentication**: JWT

## Setup Instructions
### 1. Clone the repository
```sh
git clone https://github.com/Aryan-Elite/financial-risk-api.git
cd financial-risk-api
```

### 2. Install dependencies
```sh
npm install
```

### 3. Configure environment variables
Create a `.env` file in the root directory and add:
```env
PORT=3000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secret_key
REDIS_URL=your_redis_url
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=your_region
```

### 4. Run the server
```sh
npm start
```

## API Endpoints

### **Authentication Routes**
#### **Register a user**
```http
POST /api/v1/user/register
```
**Request Body:**
```json
{
  "name": "John Doe",
  "email": "johndoe@example.com",
  "password": "securepassword",
   "phone" : 123456789
}
```

#### **Login user**
```http
POST /api/v1/user/login
```
**Request Body:**
```json
{
  "email": "johndoe@example.com",
  "password": "securepassword"
}
```

#### **Logout user**
```http
POST /api/v1/user/logout
```

#### **Get user details**
```http
GET /api/user
```
**Headers:**
```http
Authorization: Bearer <your_jwt_token>
```

### **Financial Data Processing Routes**
#### **Upload financial data**
```http
POST /api/v1/finance/uploadFinancialData
```
**Request Body:** (JSON file or CSV upload supported)
```json
[
  {
    "company_id": "C12345",
    "company_name": "TechCorp Ltd.",
    "reporting_period": "2023-Q4",
    "industry_sector": "Technology",
    "total_assets": 5000000,
    "total_liabilities": 2000000,
    "revenue": 1500000,
    "net_profit": 300000,
    "cash_flow": 500000
  },
  {
    "company_id": "F78901",
    "company_name": "FinBank Inc.",
    "reporting_period": "2023-Q3",
    "industry_sector": "Finance",
    "total_assets": 10000000,
    "total_liabilities": 8000000,
    "revenue": 3000000,
    "net_profit": 600000,
    "cash_flow": 700000
  },
  {
    "company_id": "R45678",
    "company_name": "RetailMart LLC",
    "reporting_period": "2023-Q2",
    "industry_sector": "Retail",
    "total_assets": 3000000,
    "total_liabilities": 1000000,
    "revenue": 1200000,
    "net_profit": 100000,
    "cash_flow": 400000
  }
]

```

#### **Get risk assessment**
```http
GET /api/v1/finance/getRiskAssessment
```
**Query Params:**
```http
?reporting_period=Q1-2025
?company_id=C12345
```

#### **Check batch processing status**
```http
GET /api/v1/finance/batch-status
```

