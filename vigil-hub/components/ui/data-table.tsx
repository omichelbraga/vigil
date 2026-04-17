"use client";

import { useState, useMemo, ReactNode } from "react";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Search,
  Inbox,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  isLoading?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  pageSize?: number;
  pageSizeOptions?: number[];
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  className?: string;
  /** Optional global filter function; defaults to string-includes across all cells. */
  globalFilterFn?: (row: TData, filter: string) => boolean;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export function DataTable<TData>({
  columns,
  data,
  isLoading = false,
  searchable = false,
  searchPlaceholder = "Search...",
  pageSize: initialPageSize = 25,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  emptyTitle = "No results",
  emptyDescription,
  emptyAction,
  className,
  globalFilterFn,
}: DataTableProps<TData>): React.ReactElement {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [globalFilter, setGlobalFilter] = useState<string>("");
  const [showColumnMenu, setShowColumnMenu] = useState(false);

  const safeData = useMemo(() => data ?? [], [data]);

  const table = useReactTable<TData>({
    data: safeData,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      globalFilter,
    },
    initialState: {
      pagination: {
        pageSize: initialPageSize,
        pageIndex: 0,
      },
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: (value: unknown) =>
      setGlobalFilter(typeof value === "string" ? value : ""),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: globalFilterFn
      ? (row, _columnId, filterValue: unknown) => {
          if (typeof filterValue !== "string" || filterValue.length === 0) {
            return true;
          }
          return globalFilterFn(row.original, filterValue);
        }
      : (row, _columnId, filterValue: unknown) => {
          if (typeof filterValue !== "string" || filterValue.length === 0) {
            return true;
          }
          const needle = filterValue.toLowerCase();
          return row.getAllCells().some((cell) => {
            const value = cell.getValue();
            if (value == null) return false;
            return String(value).toLowerCase().includes(needle);
          });
        },
  });

  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const hasRows = table.getRowModel().rows.length > 0;
  const pageSize = table.getState().pagination.pageSize;
  const pageIndex = table.getState().pagination.pageIndex;
  const totalFiltered = table.getFilteredRowModel().rows.length;
  const pageStart = totalFiltered === 0 ? 0 : pageIndex * pageSize + 1;
  const pageEnd = Math.min((pageIndex + 1) * pageSize, totalFiltered);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
          {searchable ? (
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder}
                className={cn(
                  "h-9 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm text-gray-900",
                  "placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                  "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                )}
              />
            </div>
          ) : (
            <div />
          )}

          <div className="relative">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowColumnMenu((v) => !v)}
            >
              <Columns3 />
              Columns
            </Button>
            {showColumnMenu ? (
              <div
                role="menu"
                className={cn(
                  "absolute right-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-2 shadow-lg",
                  "dark:border-gray-800 dark:bg-gray-900"
                )}
              >
                {table
                  .getAllLeafColumns()
                  .filter((c) => c.getCanHide())
                  .map((column) => (
                    <label
                      key={column.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm",
                        "text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-emerald-600"
                        checked={column.getIsVisible()}
                        onChange={(e) =>
                          column.toggleVisibility(e.target.checked)
                        }
                      />
                      <span className="capitalize">
                        {String(column.columnDef.header ?? column.id)}
                      </span>
                    </label>
                  ))}
              </div>
            ) : null}
          </div>
        </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-950/40">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sortState = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          "px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400",
                          canSort && "cursor-pointer select-none"
                        )}
                        onClick={
                          canSort
                            ? header.column.getToggleSortingHandler()
                            : undefined
                        }
                      >
                        {header.isPlaceholder ? null : (
                          <span className="inline-flex items-center gap-1">
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                            {canSort ? (
                              sortState === "asc" ? (
                                <ChevronUp className="h-3.5 w-3.5" />
                              ) : sortState === "desc" ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                              )
                            ) : null}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: Math.min(pageSize, 6) }).map((_, i) => (
                  <tr
                    key={`sk-${i}`}
                    className="border-t border-gray-100 dark:border-gray-800"
                  >
                    {Array.from({ length: visibleColumnCount || 3 }).map(
                      (__, j) => (
                        <td key={j} className="px-4 py-3">
                          <Skeleton className="h-4 w-full max-w-[160px]" />
                        </td>
                      )
                    )}
                  </tr>
                ))
              ) : hasRows ? (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(
                      "border-t border-gray-100 transition-colors hover:bg-gray-50/60",
                      "dark:border-gray-800 dark:hover:bg-gray-800/40"
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        className="px-4 py-3 text-gray-700 dark:text-gray-200"
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={visibleColumnCount || 1}
                    className="px-4 py-8"
                  >
                    <EmptyState
                      icon={Inbox}
                      title={emptyTitle}
                      description={emptyDescription}
                      action={emptyAction}
                      className="border-0 bg-transparent dark:bg-transparent p-0 py-6"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
              className={cn(
                "h-8 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-700",
                "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              )}
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <span>
              {pageStart}-{pageEnd} of {totalFiltered}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
                aria-label="Previous page"
                className="h-7 w-7"
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
                aria-label="Next page"
                className="h-7 w-7"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
