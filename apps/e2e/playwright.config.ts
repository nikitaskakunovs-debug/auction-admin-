import { defineConfig } from "@playwright/test";

const API_URL = "http://localhost:4000";
const WEB_URL = "http://localhost:3000";

const serverEnv = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://auction:auction@localhost:5432/auction",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  // Non-production: dev JWT secret + VIES simulate; scheduler stays ON so
  // auctions actually close during the win→pay journey.
  NODE_ENV: "test",
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false, // shared DB + a live scheduler; keep specs serial
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: WEB_URL,
    trace: "on-first-retry",
    // Local runs point at the pre-installed system Chromium; CI installs its own.
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : {}),
  },
  webServer: [
    {
      command: "node dist/index.js",
      cwd: "../api",
      url: `${API_URL}/api/health`,
      env: serverEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      command: "npx next start --port 3000",
      cwd: "../web",
      url: WEB_URL,
      env: {
        API_URL,
        NEXT_PUBLIC_API_URL: API_URL,
        NEXT_PUBLIC_SITE_URL: WEB_URL,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
    },
  ],
});
