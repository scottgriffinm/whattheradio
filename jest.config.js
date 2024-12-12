module.exports = {
    testEnvironment: "node",
    setupFiles: ["dotenv/config"],
    testTimeout: 30000, // 30 seconds timeout for tests that involve external services
  };