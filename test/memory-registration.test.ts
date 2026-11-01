import { describe, expect, it } from "vitest";
import { AssistantServices } from "../src/assistant/services.ts";

describe("assistant memory registration", () => {
  it("does not expose the retired memory tool", () => {
    const services = new AssistantServices({ cwd: process.cwd(), dataDir: process.cwd(), sessionsRoot: process.cwd(), ownerOpenId: "ou_test", notifyTask: async () => {}, openShell: async () => { throw new Error("not used"); } });
    expect(services.tools().map((tool) => tool.name)).not.toContain("memory");
  });
});
