// Stands in for what the store would hold.
type Item = string;

/**
 * Three items, as `count` asks.
 * @standsIn store.ts
 * @realIn T2
 */
export const fakeItems = (count: number): Item[] => ["a", "b", "c"].slice(0, count);
