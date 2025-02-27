const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");

// Import Routes
const userRouter = require("./routes/userRoute");
const financialRouter = require("./routes/financialRoute");

// Initialize Express App
const app = express();

// Security Middleware
app.use(helmet()); // Sets security headers

// Rate Limiting (Max 100 requests per minute per IP)
const limiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use(limiter);

// Other Middleware
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Define Routes
app.use("/api/v1/user", userRouter);
app.use("/api/v1/finance", financialRouter);

// Health Check Route
app.get("/", (req, res) => {
  res.send("🚀 Financial Risk API is running...");
});

module.exports = app;
