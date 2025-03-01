const Redis = require("ioredis");

const redis = new Redis({
  host: '127.0.0.1', // Forces local Redis
  port: 6379
});




redis.on("connect", () => {
    console.log("Connected to Redis Cloud!");
    // console.log('Redis is connected to:', redis.options.host, 'on port:', redis.options.port);

});

redis.on("error", (err) => {
    console.error("❌ Redis Error:", err);
});

module.exports = redis;
