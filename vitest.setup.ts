import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Tests never touch real storage: refunds stay in memory.
for (const name of [
  "BLOB_READ_WRITE_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
])
  delete process.env[name];

afterEach(() => {
  cleanup();
});
