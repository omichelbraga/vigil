"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Server,
  Shield,
  Bell,
  Radar,
  LogOut,
  Menu,
  X,
  Users,
  FileText,
  Activity,
  Plug,
  Package,
  Rocket,
} from "lucide-react";
import { useEffect, useState } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { AvatarMenu } from "@/components/avatar-menu";
import { NotificationsTray } from "@/components/notifications-tray";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Server },
  { href: "/monitors", label: "Monitors", icon: Radar },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/admin/users", label: "Admin · Users", icon: Users, adminOnly: true },
  { href: "/admin/audit", label: "Admin · Audit", icon: FileText, adminOnly: true },
  { href: "/admin/integrations", label: "Admin · Integrations", icon: Plug, adminOnly: true },
  { href: "/admin/system", label: "Admin · System", icon: Activity, adminOnly: true },
  { href: "/admin/agent-releases", label: "Admin · Agent Releases", icon: Package, adminOnly: true },
  { href: "/admin/rollouts", label: "Admin · Rollouts", icon: Rocket, adminOnly: true },
  // Legacy /settings route is still reachable for bookmarks, but intentionally
  // hidden from the sidebar — operators should use /admin/integrations instead.
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    fetch("/api/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { avatarUrl?: string | null } | null) => {
        if (!cancelled && data && typeof data.avatarUrl === "string") {
          setAvatarUrl(data.avatarUrl);
        }
      })
      .catch(() => {
        /* ignore — avatar is non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  const handleSignOut = async () => {
    await signOut();
    window.location.href = "/login";
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-gray-900 text-gray-100 transition-transform duration-200 lg:static lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between border-b border-gray-800 px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Shield className="h-7 w-7 text-emerald-400" />
            <span className="text-xl font-bold tracking-tight text-white">
              Vigil
            </span>
          </Link>
          <button
            className="lg:hidden text-gray-400 hover:text-white"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems
            .filter((item) =>
              item.adminOnly
                ? (session?.user as { role?: string } | undefined)?.role === "admin"
                : true,
            )
            .map((item) => {
            const isActive =
              pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-800/50 hover:text-white"
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User section */}
        <div className="border-t border-gray-800 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-sm font-medium text-white">
              {session?.user?.name?.[0]?.toUpperCase() ||
                session?.user?.email?.[0]?.toUpperCase() ||
                "U"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-sm font-medium text-white">
                {session?.user?.name || session?.user?.email || "User"}
              </p>
              <p className="truncate text-xs text-gray-400">
                {session?.user?.email}
              </p>
            </div>
            <button
              onClick={handleSignOut}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6 dark:border-gray-800 dark:bg-gray-900">
          <button
            className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-6 w-6" />
          </button>
          <div className="hidden lg:block">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white">
              {navItems.find(
                (item) =>
                  pathname === item.href ||
                  pathname?.startsWith(item.href + "/")
              )?.label || "Dashboard"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <NotificationsTray />
            <AvatarMenu avatarUrl={avatarUrl} />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
