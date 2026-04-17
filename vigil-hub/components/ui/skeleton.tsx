import { CSSProperties } from "react";
import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ className, style }: SkeletonProps): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      style={style}
      className={cn(
        "animate-pulse rounded-md bg-gray-200/70 dark:bg-gray-800/70",
        className
      )}
    />
  );
}
