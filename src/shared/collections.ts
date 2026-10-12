/** Deletes the oldest entry of an insertion-ordered Map (its first key). Used to keep in-memory tables bounded. */
export function deleteOldest<K, V>(map: Map<K, V>): void {
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}
