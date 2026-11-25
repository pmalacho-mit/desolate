// Code under test that the tests also call: not a harness, though they import it as a type.
export const save = (items: string[], item: string): string[] => [...items, item];

/** The items kept so far. */
export const load = (): string[] => [];
