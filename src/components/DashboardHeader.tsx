import type React from "react";
import { cn } from "@/lib/utils";

interface DashboardHeaderProps {
    title: string;
    subtitle?: string;
    children?: React.ReactNode;
    className?: string;
}

export function DashboardHeader({
    title,
    subtitle,
    children,
    className
}: DashboardHeaderProps) {
    return (
        <div
            className={cn(
                "flex flex-col min-[768px]:flex-row min-[768px]:items-center justify-between gap-[20px] mb-[28px]",
                className
            )}
        >
            <div className="space-y-[4px]">
                <h1 className="text-[25px] font-bold tracking-tight text-foreground tracking-normal">
                    {title}
                </h1>

                {subtitle && (
                    <p className="text-muted-foreground text-[10px] min-[768px]:text-[14px] animate-in fade-in slide-in-from-left-2 duration-500">
                        {subtitle}
                    </p>
                )}
            </div>

            <div className="flex items-center gap-[20px] animate-in fade-in zoom-in-95 duration-500">
                {children}
            </div>
        </div>
    );
}