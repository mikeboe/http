import { useRef } from 'preact/hooks';

/**
 * For edits to a map that may be absent on disk when the model shows it empty. The returned
 * function says whether the map exists (so a sub-key can be set) and, from then on, treats it as
 * existing: a second quick edit before the state comes back must not replace the whole map again.
 */
export function useMapExists(count: number): () => boolean {
  const created = useRef(false);
  if (count > 0) created.current = false;
  return () => {
    const exists = count > 0 || created.current;
    created.current = true;
    return exists;
  };
}
