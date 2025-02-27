const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

exports.isAuthenticated = async (req, res, next) => {
  try {
    let token;


    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1];
    } else if (req.cookies && req.cookies.jwt) { 
      token = req.cookies.jwt;
    }

    if (!token) {
      return res.status(401).json({ message: "You are not logged in! Please log in." });
    }


    const decoded = jwt.verify(token, process.env.JWT_SECRET);


    const currentUser = await User.getUserById(decoded.user_id);

    if (!currentUser) {
      return res.status(401).json({ message: "User no longer exists." });
    }
  
    req.user = currentUser; 
    next(); 
  } catch (err) {
    res.status(401).json({ message: "Invalid token. Please log in again." });
  }
};
