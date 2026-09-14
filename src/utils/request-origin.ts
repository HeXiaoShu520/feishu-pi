/**
 * 本机配置服务的请求来源防护。
 *
 * 配置服务绑定 127.0.0.1，但浏览器里的恶意网页仍可向 http://127.0.0.1:3456 发起
 * 跨源表单 POST（urlencoded 属于"简单请求"，不触发 CORS 预检），从而重写 .env——
 * 例如把模型 Base URL 指向攻击者服务器，窃取后续所有对话与密钥。
 *
 * 防护规则：写请求携带 Origin 头时，必须是本机来源（localhost / 127.0.0.1 / [::1]）；
 * 无 Origin 视为非浏览器客户端（curl、同源脚本），放行。浏览器对跨源 POST 一定会
 * 携带 Origin，因此该检查能挡住跨源表单/拉取攻击，且不影响正常使用。
 */

/** 本机来源判定（主机名为 localhost / 127.0.0.1 / [::1] 即视为本机）。 */
function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * 判断一个写请求是否允许执行。
 * @param origin 请求的 Origin 头（浏览器跨源/同源 POST 均会携带；curl 等通常不带）
 * @returns true=放行（无 Origin，或 Origin 指向本机）
 */
export function isLocalWriteAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false; // Origin 存在但无法解析：按跨源恶意请求拒绝
  }
}
