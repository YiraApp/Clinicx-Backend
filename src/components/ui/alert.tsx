import * as React from "react"
import { cn } from "@/lib/utils"

export const Alert: React.FC<React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" | "success" }> = ({
  className = "",
  variant = "default",
  ...props
}) => (
  <div
    role="alert"
    className={cn(
      "relative w-full rounded-lg border p-4 [&>svg~div]:translate-y-[-3px] [&>svg~div]:pl-7 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
      variant === "destructive"
        ? "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive"
        : variant === "success"
          ? "border-emerald-500/20 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/40 dark:border-emerald-500/30 dark:text-emerald-200 [&>svg]:text-emerald-600 dark:[&>svg]:text-emerald-400"
          : "bg-background text-foreground",
      className
    )}
    {...props}
  />
)

export const AlertDescription: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = "", ...props }) => (
  <div className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
)
