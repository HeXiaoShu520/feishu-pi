import { describe, expect, it } from "vitest";
import { toggleTrailingBlankLine } from "../src/utils/restart-toggle.ts";

describe("toggleTrailingBlankLine", () => {
  it("少于三个末尾空行时增加一个", () => {
    const result = toggleTrailingBlankLine("main();");

    expect(result.action).toBe("added");
    expect(result.before).toBe(0);
    expect(result.after).toBe(1);
    expect(result.content).toBe("main();\n");
  });

  it("末尾已有三个空行时删除一个", () => {
    const result = toggleTrailingBlankLine("main();\n\n\n");

    expect(result.action).toBe("removed");
    expect(result.before).toBe(3);
    expect(result.after).toBe(2);
    expect(result.content).toBe("main();\n\n");
  });

  it("保留 CRLF 换行风格", () => {
    const result = toggleTrailingBlankLine("main();\r\n\r\n");

    expect(result.content).toBe("main();\r\n\r\n\r\n");
    expect(result.after).toBe(3);
  });
});
