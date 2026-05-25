import * as React from "react";

import { cn } from "@/lib/utils";

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(
  null,
);

function useDropdownMenu() {
  const ctx = React.useContext(DropdownMenuContext);
  if (!ctx) {
    throw new Error(
      "DropdownMenu primitives must be rendered inside <DropdownMenu>",
    );
  }
  return ctx;
}

/**
 * Lightweight dropdown menu — anchored popover with click-outside,
 * Escape-to-close and basic ARIA wiring. Built in-house to avoid pulling
 * another Radix package when the only consumer is the header menu.
 */
export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef }}>
      <div className="relative inline-block">{children}</div>
    </DropdownMenuContext.Provider>
  );
}

interface DropdownMenuTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  DropdownMenuTriggerProps
>(({ onClick, ...props }, ref) => {
  const { open, setOpen, triggerRef } = useDropdownMenu();
  return (
    <button
      ref={(node) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen(!open);
      }}
      {...props}
    />
  );
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

interface DropdownMenuContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
}

export const DropdownMenuContent = React.forwardRef<
  HTMLDivElement,
  DropdownMenuContentProps
>(({ className, align = "end", children, ...props }, ref) => {
  const { open, setOpen, triggerRef } = useDropdownMenu();
  const localRef = React.useRef<HTMLDivElement>(null);
  const setRefs = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (localRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, setOpen, triggerRef]);

  if (!open) return null;

  return (
    <div
      ref={setRefs}
      role="menu"
      className={cn(
        "absolute z-50 mt-1 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});
DropdownMenuContent.displayName = "DropdownMenuContent";

interface DropdownMenuItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const DropdownMenuItem = React.forwardRef<
  HTMLButtonElement,
  DropdownMenuItemProps
>(({ className, onClick, ...props }, ref) => {
  const { setOpen } = useDropdownMenu();
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen(false);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      className={cn("my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
