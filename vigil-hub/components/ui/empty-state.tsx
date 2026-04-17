import { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center",
        "dark:border-gray-800 dark:bg-gray-900",
        className
      )}
    >
      {Icon ? (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          <Icon className="h-6 w-6" />
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-gray-500 dark:text-gray-400">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
