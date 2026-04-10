import { cn } from "@/lib/utils"
import { Loader2 } from "lucide-react"

interface LoadingProps {
  /** Display variant */
  variant?: "spinner" | "skeleton" | "dots"
  /** Size of the spinner */
  size?: "sm" | "md" | "lg"
  /** Optional message below the spinner */
  message?: string
  /** Whether it should fill the full screen */
  fullScreen?: boolean
  /** Additional CSS classes */
  className?: string
}

const sizeMap = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
}

export function Loading({
  variant = "spinner",
  size = "md",
  message = "Loading...",
  fullScreen = false,
  className,
}: LoadingProps) {
  const content = (
    <div className={cn("flex flex-col items-center justify-center gap-3", className)}>
      {variant === "spinner" && (
        <Loader2
          className={cn(
            sizeMap[size],
            "animate-spin text-indigo-600"
          )}
        />
      )}
      {variant === "skeleton" && (
        <div className="space-y-3 w-full max-w-md">
          <div className="h-4 bg-slate-200 rounded animate-pulse w-3/4" />
          <div className="h-4 bg-slate-200 rounded animate-pulse w-1/2" />
          <div className="h-4 bg-slate-200 rounded animate-pulse w-5/6" />
        </div>
      )}
      {variant === "dots" && (
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-indigo-600 animate-bounce [animation-delay:-0.3s]" />
          <div className="h-2.5 w-2.5 rounded-full bg-indigo-600 animate-bounce [animation-delay:-0.15s]" />
          <div className="h-2.5 w-2.5 rounded-full bg-indigo-600 animate-bounce" />
        </div>
      )}
      {message && variant !== "skeleton" && (
        <p className="text-sm text-slate-500">{message}</p>
      )}
    </div>
  )

  if (fullScreen) {
    return (
      <div className="flex items-center justify-center h-screen w-full">
        {content}
      </div>
    )
  }

  return content
}
