require("dotenv").config({ path: __dirname + "/../../.env" });  // Load from root
const app = require("./app");
const connectDB = require("../src/config/db");


// Start the server
const PORT = process.env.PORT || 5000;
// console.log(process.env.PORT);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

