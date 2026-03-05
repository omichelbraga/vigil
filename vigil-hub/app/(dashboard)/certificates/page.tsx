"use client";

import { useEffect, useState, useMemo } from "react";
import { Plus, Shield, Activity, Download } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

interface CertRecord {
  id: string;
  domain: string;
  port?: number;
  issuer?: string;
  expiry_date?: string;
  days_remaining?: number;
  status?: string;
  source?: string;
}

export default function CertificatesPage() {
  const [certs, setCerts] = useState<CertRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDomain, setFormDomain] = useState("");
  const [formPort, setFormPort] = useState("443");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const formatDate = (d?: string) => {
    if (!d || !mounted) return "—";
    return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this certificate monitor?")) return;
    await fetch(`/api/certs/${id}`, { method: "DELETE" });
    fetchCerts();
  };

  const handleCheckNow = async () => {
    setChecking(true);
    await fetch("/api/certs/check", { method: "POST" });
    await fetchCerts();
    setChecking(false);
  };

  const fetchCerts = async () => {
    try {
      const res = await fetch("/api/certs");
      const data = await res.json();
      setCerts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch certs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCerts();
  }, []);

  const handleAdd = async () => {
    if (!formDomain.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/certs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: formDomain.trim(),
          port: parseInt(formPort, 10) || 443,
        }),
      });
      if (res.ok) {
        setDialogOpen(false);
        setFormDomain("");
        setFormPort("443");
        fetchCerts();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to add domain");
      }
    } catch {
      alert("Failed to add domain");
    } finally {
      setCreating(false);
    }
  };

  function statusColor(daysRemaining?: number) {
    if (daysRemaining === undefined || daysRemaining === null)
      return {
        badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
        label: "Unknown",
      };
    if (daysRemaining <= 7)
      return {
        badge: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
        label: "Critical",
      };
    if (daysRemaining <= 30)
      return {
        badge:
          "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
        label: "Warning",
      };
    return {
      badge:
        "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
      label: "OK",
    };
  }

  const standardCerts = certs.filter((c) => c.source !== "azure_kv");
  const azureCerts = certs.filter((c) => c.source === "azure_kv");

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Activity className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-nowrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Certificates
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Track SSL/TLS certificate expiration across your domains
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCheckNow}
            disabled={checking}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800 transition-colors"
          >
            {checking ? "Checking..." : "🔄 Check Now"}
          </button>
          <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Trigger asChild>
            <button className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors">
              <Plus className="h-4 w-4" />
              Add Domain
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
              <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white">
                Add Domain
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Monitor the SSL certificate for a domain.
              </Dialog.Description>

              <div className="mt-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Domain
                  </label>
                  <input
                    type="text"
                    value={formDomain}
                    onChange={(e) => setFormDomain(e.target.value)}
                    placeholder="e.g. example.com"
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Port
                  </label>
                  <input
                    type="number"
                    value={formPort}
                    onChange={(e) => setFormPort(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <Dialog.Close asChild>
                  <button className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  onClick={handleAdd}
                  disabled={creating || !formDomain.trim()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {creating ? "Adding..." : "Add Domain"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        </div>
      </div>

      {/* Certificates Table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        {standardCerts.length > 0 ? (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Domain
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Port
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Expiry Date
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Days Remaining
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                  Issuer
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {standardCerts.map((cert) => {
                const st = statusColor(cert.days_remaining);
                return (
                  <tr
                    key={cert.id}
                    className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                      {cert.domain}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {cert.port || 443}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {formatDate(cert.expiry_date)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "font-medium",
                          cert.days_remaining !== undefined &&
                            cert.days_remaining <= 7
                            ? "text-red-600 dark:text-red-400"
                            : cert.days_remaining !== undefined &&
                              cert.days_remaining <= 30
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-green-600 dark:text-green-400"
                        )}
                      >
                        {cert.days_remaining !== undefined
                          ? `${cert.days_remaining} days`
                          : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          st.badge
                        )}
                      >
                        {st.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400">
                      {cert.issuer || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDelete(cert.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="p-12 text-center">
            <Shield className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" />
            <h3 className="mt-4 text-sm font-medium text-gray-900 dark:text-white">
              No certificates tracked
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Add a domain to start monitoring its SSL certificate.
            </p>
          </div>
        )}
      </div>

      {/* Azure Key Vault Certificates */}
      {azureCerts.length > 0 && (
        <div>
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Azure Key Vault Certificates
          </h2>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Name
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Expiry Date
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Days Remaining
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                {azureCerts.map((cert) => {
                  const st = statusColor(cert.days_remaining);
                  return (
                    <tr
                      key={cert.id}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
                        {cert.domain}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {formatDate(cert.expiry_date)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "font-medium",
                            cert.days_remaining !== undefined &&
                              cert.days_remaining <= 7
                              ? "text-red-600 dark:text-red-400"
                              : cert.days_remaining !== undefined &&
                                cert.days_remaining <= 30
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-green-600 dark:text-green-400"
                          )}
                        >
                          {cert.days_remaining !== undefined
                            ? `${cert.days_remaining} days`
                            : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            st.badge
                          )}
                        >
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
