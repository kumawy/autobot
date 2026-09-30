/** Lazily scan ordered queue pages so blocked customers cannot starve later ones. */
export async function* queuePages<T extends { sequence: bigint }>(
  read: (after?: bigint) => Promise<T[]>,
): AsyncGenerator<T> {
  let after: bigint | undefined;
  while (true) {
    const page = await read(after);
    if (page.length === 0) return;
    for (const item of page) yield item;
    after = page.at(-1)!.sequence;
  }
}
