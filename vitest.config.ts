import { defineConfig } from "vitest/config";

export default defineConfig({
  // This is a personal desktop service: unrestricted file workers compete for
  // filesystem/crypto resources and make short polling tests flaky on Windows.
  test: { include: ["test/**/*.test.ts"], maxWorkers: 2 },
});
