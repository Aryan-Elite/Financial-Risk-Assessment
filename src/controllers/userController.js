const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/userModel");

// Function to generate JWT token
const signToken = (user_id) => {
  return jwt.sign({ user_id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

// Function to create and send JWT token
const createSendToken = (user, statusCode, res) => {
  
  const token = signToken(user.user_id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ), 
    httpOnly: true,
  };
  res.cookie("jwt", token, cookieOptions);
  
  delete user.password;

  res.status(statusCode).json({
    status: "success",
    token,
    data: { user },
  });
};

// Register a new user
exports.register = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "Please provide all fields." });
    }

    const existingUser = await User.getUserByEmail(email);


    if (existingUser) {
      return res.status(400).json({ message: "User already exists." });
    }

    const newUser = await User.createUser({ name, email, phone, password });
    // console.log(newUser);
    
    createSendToken(newUser, 201, res);
  } catch (error) {
    res.status(500).json({ message: "Registration failed.", error });
  }
};

// Login user
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Please provide email and password." });
    }

    const user = await User.getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid Email or Password." });
    }

    createSendToken(user, 200, res);
  } catch (error) {
    res.status(500).json({ message: "Login failed.", error });
  }
};

// Get user profile
exports.getUser = async (req, res) => {
    try {
      const user = await User.getUserById(req.user.user_id);
      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }
  
      delete user.password; // Remove sensitive data
      res.status(200).json({ status: "success", data: { user } });
    } catch (error) {
      res.status(500).json({ message: "Error retrieving user.", error });
    }
  };
  
  exports.login = async (req, res) => {
    try {
      const { email, password } = req.body;
  
      if (!email || !password) {
        return res.status(400).json({ message: "Please provide email and password." });
      }
  
      const user = await User.getUserByEmail(email);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ message: "Invalid Email or Password." });
      }
  
      createSendToken(user, 200, res);
    } catch (error) {
      res.status(500).json({ message: "Login failed.", error });
    }
  };

  exports.logout = async (req, res, next) => {
    res.status(200)
      .cookie('jwt', '', {
        httpOnly: true,
        expires: new Date(Date.now()),
      })
      .json({
        status: 'success',
        message: 'Logged Out Successfully.',
      });
  };