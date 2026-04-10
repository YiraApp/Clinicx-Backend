import * as React from "react"
import { useState, useRef, useEffect, createContext, useContext } from "react"
import { cn } from "@/lib/utils"

interface SelectContextType {
  value: string;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  children: React.ReactNode;
}

const SelectContext = createContext<SelectContextType | null>(null)

export const Select: React.FC<{
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
}> = ({ value, onValueChange, children }) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <SelectContext.Provider value={{ value, onValueChange, open, setOpen, children }}>
      <div className="relative" ref={containerRef}>
        {children}
      </div>
    </SelectContext.Provider>
  )
}

export const SelectTrigger: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => {
  const context = useContext(SelectContext)
  if (!context) return null
  const { open, setOpen } = context

  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={cn(
        "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
    >
      {children}
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={cn("h-4 w-4 opacity-50 transition-transform", open && "rotate-180")}><path d="m6 9 6 6 6-6" /></svg>
    </button>
  )
}


export const SelectContent: React.FC<{
  children: React.ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}> = ({ children, side = "bottom", align = "start" }) => {
  const context = useContext(SelectContext)
  if (!context || !context.open) return null

  const positionClasses = side === "top"
    ? "bottom-full mb-1"
    : "top-full mt-1";

  const alignClasses = align === "center"
    ? "left-1/2 -translate-x-1/2"
    : align === "end"
      ? "right-0"
      : "left-0";

  return (
    <div className={cn(
      "absolute z-50 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-80",
      positionClasses,
      alignClasses,
      side === "top" ? "slide-in-from-bottom-1" : "slide-in-from-top-1"
    )}>
      <div className="p-1">
        {children}
      </div>
    </div>
  )
}

export const SelectItem: React.FC<{
  value: string;
  children: React.ReactNode;
}> = ({ value, children }) => {
  const context = useContext(SelectContext)
  if (!context) return null
  const { value: selectedValue, onValueChange, setOpen } = context
  const isSelected = String(selectedValue) === String(value)

  return (
    <div
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none hover:bg-accent hover:text-accent-foreground transition-colors",
        isSelected && "bg-accent/50 text-indigo-600 font-medium"
      )}
      onClick={(e) => {
        e.stopPropagation();
        onValueChange(value);
        setOpen(false);
      }}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        {isSelected && (
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><path d="M20 6 9 17l-5-5" /></svg>
        )}
      </span>
      <div className="flex items-center gap-2">
        {children}
      </div>
    </div>
  )
}

export const SelectValue: React.FC<{
  placeholder?: string;
}> = ({ placeholder }) => {
  const context = useContext(SelectContext)
  if (!context) return null
  const { value, children } = context

  // Look for the SelectItem that matches the current value
  let selectedContent: React.ReactNode = null

  // helper to recursive search for SelectItem among children
  const findSelectedItem = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, (child) => {
      if (selectedContent !== null) return
      if (!React.isValidElement(child)) return

      const element = child as React.ReactElement<any>

      // Check if this is the SelectItem we're looking for
      // We use String() comparison to be safe against number/string mismatches
      if (element.type === SelectItem && String(element.props.value) === String(value)) {
        selectedContent = element.props.children
        return
      }

      // If it has children, recurse (especially important for SelectContent)
      if (element.props && element.props.children) {
        findSelectedItem(element.props.children)
      }
    })
  }

  if (value !== undefined && value !== null) {
    findSelectedItem(children)
  }

  return (
    <span className={cn("truncate block w-full text-left", !value && "text-muted-foreground")}>
      {selectedContent || placeholder}
    </span>
  )
}
