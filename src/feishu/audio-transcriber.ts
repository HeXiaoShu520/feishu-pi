/** 飞书未附 speech_to_text 时，使用显式配置的 OpenAI 兼容语音转写接口。 */
export interface AudioTranscriptionOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export async function transcribeAudio(data: Buffer, options: AudioTranscriptionOptions): Promise<string | undefined> {
  if (!options.baseUrl || !options.apiKey || !options.model) return undefined;
  const form = new FormData();
  form.set("model", options.model);
  form.set("file", new Blob([new Uint8Array(data)], { type: "audio/ogg" }), "feishu-voice.ogg");
  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`语音转写接口返回 HTTP ${response.status}`);
  const body = await response.json() as { text?: unknown };
  return typeof body.text === "string" && body.text.trim() ? body.text.trim() : undefined;
}
