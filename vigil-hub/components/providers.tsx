"use client";

import { ReactNode, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { getQueryClient } from "@/lib/query-client";
import { ToastProvider } from "@/components/ui/toast-provider";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { CommandPalette } from "@/components/command-palette";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps): React.ReactElement {
  const [queryClient] = useState(() => getQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <ToastProvider>
          <ConfirmProvider>
            {children}
            <CommandPalette />
            <Toaster
              position="bottom-right"
              richColors
              closeButton
              theme="system"
            />
          </ConfirmProvider>
        </ToastProvider>
        {process.env.NODE_ENV === "development" ? (
          <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
        ) : null}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
