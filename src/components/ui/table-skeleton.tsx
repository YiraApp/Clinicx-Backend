import { motion } from "framer-motion";
import { Skeleton } from "@/components/ui/skeleton";

interface TableSkeletonProps {
    rows?: number;
    cols?: number;
    hasImage?: boolean;
}

export function TableSkeleton({ rows = 5, cols = 7, hasImage = true }: TableSkeletonProps) {
    return (
        <>
            {Array.from({ length: rows }).map((_, i) => (
                <motion.tr
                    key={`skeleton-${i}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2, delay: i * 0.05 }}
                    className="hover:bg-transparent"
                >
                    <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                            {hasImage && <Skeleton className="h-10 w-10 rounded-lg shrink-0" />}
                            <div className="min-w-0 space-y-1.5">
                                <Skeleton className="h-4 w-32" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                        </div>
                    </td>
                    <td className="px-6 py-5">
                        <Skeleton className="h-5 w-16 rounded-full" />
                    </td>
                    <td className="px-6 py-5">
                        <div className="space-y-1.5">
                            <Skeleton className="h-3.5 w-32" />
                            <Skeleton className="h-3.5 w-28" />
                            <Skeleton className="h-3.5 w-24" />
                        </div>
                    </td>
                    <td className="px-6 py-5 text-center">
                        <div className="inline-flex flex-col items-center gap-1.5">
                            <Skeleton className="h-4 w-8" />
                            <Skeleton className="h-3 w-14" />
                        </div>
                    </td>
                    <td className="px-6 py-5 text-center">
                        <div className="inline-flex flex-col items-center gap-1.5">
                            <Skeleton className="h-4 w-8" />
                            <Skeleton className="h-3 w-14" />
                        </div>
                    </td>
                    <td className="px-6 py-5">
                        <Skeleton className="h-6 w-16 rounded-full" />
                    </td>
                    <td className="px-6 py-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                            <Skeleton className="h-8 w-8 rounded-lg" />
                            <Skeleton className="h-8 w-8 rounded-lg" />
                            <Skeleton className="h-8 w-8 rounded-lg" />
                        </div>
                    </td>
                </motion.tr>
            ))}
        </>
    );
}
