import { defineConfig } from "vitest/config";
import path from "path";

// Vitest config kept separate from vite.config.ts so the test runner doesn't
// pull in the SWC React plugin (unneeded for the current logic-level tests).
// jsdom gives us localStorage + window.location, which shenmayApi.ts touches.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
  },
});
