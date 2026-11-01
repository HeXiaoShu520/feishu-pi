/** Exhaust discovery pages with a bound and cycle detection; never silently drop later tools. */
export async function collectPages<Page extends { nextCursor?: string }, Item>(
  read: (cursor: string | undefined) => Promise<Page>,
  items: (page: Page) => Item[],
  signal?: AbortSignal,
): Promise<Item[]> {
  const result: Item[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let count = 0; count < 100; count++) {
    signal?.throwIfAborted();
    const page = await read(cursor);
    result.push(...items(page));
    cursor = page.nextCursor;
    if (!cursor) return result;
    if (seen.has(cursor)) throw new Error("MCP 服务返回重复分页游标");
    seen.add(cursor);
  }
  throw new Error("MCP 发现结果超过 100 页，请缩小服务范围");
}
