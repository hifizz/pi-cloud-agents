import { cx } from "../../../lib/cx";

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block size-2.5 animate-spin rounded-full border-[1.5px] border-warn/30 border-t-warn", className)} />;
}
