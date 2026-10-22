import { useRef } from 'preact/hooks';

/**
 * For edits to a map that may be absent on disk (`present` comes from the host's state). The returned
 * function says whether the map exists (so a sub-key can be set) and, from then on, treats it as
 * existing: a second quick edit before the state comes back must not replace the whole map again.
 */
export function useMapExists(present: boolean): () => boolean {
  const created = useRef(false);
  if (present) created.current = false;
  return () => {
    const exists = present || created.current;
    created.current = true;
    return exists;
  };
}
