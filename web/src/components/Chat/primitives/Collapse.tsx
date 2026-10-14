import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { cx } from "../../../lib/cx";

type Phase = "closed" | "opening" | "open" | "closing";

// `transitionend` drives the phase changes, so slow frames (busy main thread, background window) never cut an
// animation short. The timer is only a safety net for when no transition runs (reduced motion, display:none ancestors).
const SAFETY_MS = 700;
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Height-animated disclosure. Animates `grid-template-rows` 0fr <-> 1fr (no JS measuring, no per-frame JS).
 * - Children are only mounted while open or while the close animation runs, so collapsed rows cost nothing.
 * - While animating, `contain: layout paint` + overflow clip keep reflow inside this subtree; both are dropped
 *   once fully open so hover buttons, tooltips and focus rings can overflow the box.
 * - Never waits on requestAnimationFrame: the 0fr start state is flushed with a forced style recalc in a layout effect.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const [settled, setSettled] = useState(open);
  const ref = useRef<HTMLDivElement>(null);

  // Derived during render so the very first painted frame is already in the right state.
  if (open && (phase === "closed" || phase === "closing")) setPhase(phase === "closed" ? "opening" : "open");
  if (!open && (phase === "open" || phase === "opening")) setPhase("closing");

  useLayoutEffect(() => {
    if (phase !== "opening") return;
    ref.current?.getBoundingClientRect(); // commit the collapsed (0fr) style as the transition's start value
    setPhase("open");
  }, [phase]);

  useEffect(() => {
    if (phase !== "open" && phase !== "closing") {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => (phase === "open" ? setSettled(true) : setPhase("closed")), reducedMotion() ? 0 : SAFETY_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const onEnd = (e: TransitionEvent) => {
    if (e.target !== e.currentTarget || e.propertyName !== "grid-template-rows") return;
    if (phase === "open") setSettled(true);
    else if (phase === "closing") setPhase("closed");
  };

  if (phase === "closed") return null;
  const expanded = phase === "open";
  const clip = !(expanded && settled);
  return (
    <div
      ref={ref}
      onTransitionEnd={onEnd}
      inert={!expanded}
      className={cx("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none", expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0", className)}
      style={clip ? { contain: "layout paint" } : undefined}
    >
      <div className={cx("min-h-0", clip && "overflow-hidden")}>{children}</div>
    </div>
  );
}
