import { QueryClient } from "@tanstack/react-query";

let clientSingleton: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (!clientSingleton) {
    clientSingleton = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          gcTime: 5 * 60_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
        mutations: {
          retry: 0,
        },
      },
    });
  }
  return clientSingleton;
}
