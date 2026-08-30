"use client";

import { useRef } from "react";

// Thin vertical drag handle that resizes the adjacent pane. Uses pointer
// capture so the drag keeps working even when the cursor leaves the handle.
// Authored by Araza.
export function ResizeHandle({ onDrag }: { onDrag: (dx: number) => void }) {
  const lastX = useRef(0);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group relative z-10 w-1.5 flex-none cursor-col-resize touch-none select-none bg-transparent hover:bg-brand-green/10 active:bg-brand-green/20"
      onPointerDown={(e) => {
        e.preventDefault();
        lastX.current = e.clientX;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.buttons) return;
        onDrag(e.clientX - lastX.current);
        lastX.current = e.clientX;
      }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-300 transition-colors group-hover:bg-brand-green" />
    </div>
  );
}
