const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./ui-tests",
  timeout: 30000,
  fullyParallel: false,
  reporter: [["line"]],
  use: { baseURL: "http://127.0.0.1:4173", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node ui-server.js", url: "http://127.0.0.1:4173", reuseExistingServer: true },
  projects: [
    { name:"desktop-1440", use:{ viewport:{width:1440,height:900} } },
    { name:"tablet-1024", use:{ viewport:{width:1024,height:768} } },
    { name:"mobile-390", use:{ ...devices["Pixel 5"], viewport:{width:390,height:844} } },
  ],
});
