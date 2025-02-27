const express = require("express");
const router = express.Router();
const financialController = require("../controllers/financialController");
const authController = require("../controllers/authcontroller");

router.post("/uploadFinancialData", authController.isAuthenticated,financialController.uploadFinancialData);

router.get("/getRiskAssessment", authController.isAuthenticated,financialController.getRiskAssessment);

module.exports = router; 
