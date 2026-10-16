import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SpaceInfo } from "../types";

/** GET /api/space once. `failed` is true when the request errored. */
export function useSpace(): { space?: SpaceInfo; failed: boolean } {
  const [space, setSpace] = useState<SpaceInfo>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .space()
      .then((s) => alive && setSpace(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);
  return { space, failed };
}
