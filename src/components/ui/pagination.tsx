import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface PaginationInfo {
    page: number;
    pageSize: number;
    totalRecords: number;
    totalPages: number;
}

export interface PaginationProps {
    pagination: PaginationInfo;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
    pageSizeOptions?: number[];
    itemLabel?: string;
    className?: string;
}

export function Pagination({
    pagination,
    onPageChange,
    onPageSizeChange,
    pageSizeOptions = [3, 5, 10, 25, 50],
    itemLabel = "items",
    className,
}: PaginationProps) {
    const { page, pageSize, totalRecords, totalPages } = pagination;

    const from = totalRecords === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, totalRecords);

    const canGoPrev = page > 1;
    const canGoNext = page < totalPages;

    // Helper to generate page numbers
    const getPageNumbers = () => {
        const pages: (number | string)[] = [];
        const maxVisible = 5;

        if (totalPages <= 7) {
            for (let i = 1; i <= totalPages; i++) pages.push(i);
        } else {
            // Always show first page
            pages.push(1);

            if (page <= 3) {
                // Near start
                pages.push(2, 3, 4, "...");
                pages.push(totalPages);
            } else if (page >= totalPages - 2) {
                // Near end
                pages.push("...");
                pages.push(totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
            } else {
                // Middle
                pages.push("...");
                pages.push(page - 1, page, page + 1, "...");
                pages.push(totalPages);
            }
        }
        return pages;
    };

    return (
        <div
            className={cn(
                "flex flex-col lg:flex-row items-center justify-between gap-4 px-5 py-3 border border-border/50 bg-white/80 backdrop-blur-sm rounded-xl shadow-sm transition-all hover:shadow-md",
                className
            )}
        >
            {/* Left: Page Size Selector */}
            <div className="flex items-center gap-2 order-3 lg:order-1">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Rows</span>
                <Select
                    value={String(pageSize)}
                    onValueChange={(val) => onPageSizeChange(Number(val))}
                >
                    <SelectTrigger className="h-8 w-[65px] bg-white border-slate-200 text-xs font-bold rounded-lg hover:border-primary/30 transition-all focus:ring-1 focus:ring-primary/10">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="top" align="start">
                        {pageSizeOptions.map((opt) => (
                            <SelectItem key={opt} value={String(opt)}>
                                {opt}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Center: Navigation Numbers */}
            <div className="flex items-center gap-1 sm:gap-2 order-1 lg:order-2">
                <Button
                    variant="ghost"
                    onClick={() => onPageChange(page - 1)}
                    disabled={!canGoPrev}
                    className="h-8 px-2 sm:px-3 text-slate-500 hover:text-primary hover:bg-primary/5 font-bold transition-all group"
                >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1 group-hover:-translate-x-0.5" />
                    <span className="hidden sm:inline text-xs">Previous</span>
                </Button>

                <div className="flex items-center gap-1">
                    {getPageNumbers().map((p, idx) => {
                        if (p === "...") {
                            return (
                                <span key={`ellipsis-${idx}`} className="px-1 text-slate-400 text-xs">
                                    ...
                                </span>
                            );
                        }

                        const isActive = p === page;
                        return (
                            <button
                                key={`page-${p}`}
                                onClick={() => onPageChange(p as number)}
                                className={cn(
                                    "h-8 w-8 flex items-center justify-center rounded-full text-xs font-bold transition-all duration-200",
                                    isActive
                                        ? "bg-primary text-white shadow-md shadow-primary/20"
                                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                )}
                            >
                                {p}
                            </button>
                        );
                    })}
                </div>

                <Button
                    variant="ghost"
                    onClick={() => onPageChange(page + 1)}
                    disabled={!canGoNext}
                    className="h-8 px-2 sm:px-3 text-slate-500 hover:text-primary hover:bg-primary/5 font-bold transition-all group"
                >
                    <span className="hidden sm:inline text-xs">Next</span>
                    <ChevronRight className="h-3.5 w-3.5 ml-1 group-hover:translate-x-0.5" />
                </Button>
            </div>

            {/* Right: Info Text */}
            <div className="order-2 lg:order-3">
                <p className="text-xs font-medium text-slate-400 text-center lg:text-right">
                    Showing <span className="text-slate-700 font-bold">{from}</span> to{" "}
                    <span className="text-slate-700 font-bold">{to}</span> of{" "}
                    <span className="text-slate-900 font-black tracking-tight">{totalRecords}</span> {itemLabel}
                </p>
            </div>
        </div>
    );
}
