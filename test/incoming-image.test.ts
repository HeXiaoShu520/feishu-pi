import { afterEach, describe, expect, it, vi } from "vitest";
import { LarkTransport } from "../src/feishu/lark-transport.ts";
import { UNAVAILABLE_STICKER_MESSAGE, VISIBLE_IMAGE_MESSAGE, VISIBLE_STICKER_MESSAGE } from "../src/feishu/sticker-message.ts";

import * as stickerCache from "../src/feishu/sticker-cache.ts";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const processImages = vi.fn(async () => [{ data: new Uint8Array([1, 2]), mimeType: "image/png", savedPath: "test-dir/images/p.png" }]);
  const transport = new LarkTransport({ appId: "app", appSecret: "secret", botOpenId: "ou_bot", ownerOpenId: "ou_owner",
    client: {} as never, sessions: { dirFor: vi.fn(async () => "test-dir") } as never });
  const internal = transport as unknown as {
    getChatModeCached(): Promise<string>;
    larkCli: { getUserProfile(): Promise<object> };
    imageProcessor: { processImages: typeof processImages };
    dispatchMessage(message: unknown): Promise<void>;
  };
  internal.getChatModeCached = async () => "p2p";
  internal.larkCli.getUserProfile = async () => ({ name: "测试用户" });
  internal.imageProcessor = { processImages };
  const received = vi.fn(async (_message: unknown) => {});
  transport.onMessage(received);
  const base = { chatId: "oc_chat", senderId: "ou_owner", messageId: "om_msg", chatType: "p2p",
    resources: [], mentions: [], mentionedBot: false };
  return { internal, received, processImages, base };
}

describe("入站图片可见性", () => {
  it("按本条消息的完整 key 读取缓存，重复消息也正常附图", async () => {
    const load = vi.spyOn(stickerCache, "loadCachedSticker").mockResolvedValue({ data: new Uint8Array([3, 4]), mimeType: "image/png" });
    const { internal, received, processImages, base } = setup();
    for (const messageId of ["om_first", "om_repeat"]) {
      await internal.dispatchMessage({ ...base, messageId, content: '<sticker key="v3_exact"/>', rawContentType: "sticker",
        resources: [{ type: "sticker", fileKey: "v3_exact" }], raw: { message: { content: '{"file_key":"v3_exact"}' } } });
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith(undefined, "v3_exact", expect.stringMatching(/images$/), expect.any(Number));
    expect(processImages).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(2);
    for (const [message] of received.mock.calls) expect(message).toEqual(expect.objectContaining({ text: VISIBLE_STICKER_MESSAGE,
      images: [expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([3, 4]) })] }));
  });

  it("正常图片真正传给模型，而非没有文字的提醒", async () => {
    const { internal, received, base } = setup();
    await internal.dispatchMessage({ ...base, content: "[image]", rawContentType: "image",
      resources: [{ type: "image", fileKey: "img_key" }] });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ text: VISIBLE_IMAGE_MESSAGE,
      images: [expect.objectContaining({ mimeType: "image/png" })] }));
  });

  it("收藏表情不走无效图片下载，也不假装看懂", async () => {
    const { internal, received, processImages, base } = setup();
    await internal.dispatchMessage({ ...base, content: '<sticker key="native_key"/>', rawContentType: "sticker",
      resources: [{ type: "sticker", fileKey: "native_key" }],
      raw: { message: { content: '{"file_key":"native_key"}' } } });
    expect(processImages).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ text: UNAVAILABLE_STICKER_MESSAGE, images: undefined }));
  });

  it("普通图片下载失败也必须明确告诉模型没看到", async () => {
    const { internal, received, processImages, base } = setup();
    processImages.mockResolvedValueOnce([]);
    await internal.dispatchMessage({ ...base, content: "[image]", rawContentType: "image",
      resources: [{ type: "image", fileKey: "img_missing" }] });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("无法查看画面"), images: undefined }));
  });
});
