"use client";

import { useState, useEffect } from "react";

interface Release {
  id: string;
  os: string;
  arch: string;
  version: string;
  sha256: string;
  filename: string;
  isActive: boolean;
  createdAt: string;
}

export default function UpdatesPage() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    // In production this would fetch from /api/update/releases
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Agent Updates
        </h1>
        <button
          disabled={uploading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Upload Binary
        </button>
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">Version</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">OS</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">Arch</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">SHA256</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">Active</th>
              <th className="px-4 py-3 text-left font-medium text-zinc-600 dark:text-zinc-400">Uploaded</th>
              <th className="px-4 py-3 text-right font-medium text-zinc-600 dark:text-zinc-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {releases.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-zinc-400">
                  No agent binaries uploaded yet. Upload a binary to enable auto-updates.
                </td>
              </tr>
            ) : (
              releases.map((r) => (
                <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800/50">
                  <td className="px-4 py-3 font-mono text-zinc-900 dark:text-zinc-100">{r.version}</td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.os}</td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.arch}</td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500">{r.sha256.slice(0, 16)}...</td>
                  <td className="px-4 py-3">
                    {r.isActive ? (
                      <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">Active</span>
                    ) : (
                      <span className="text-xs text-zinc-400">Inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    {!r.isActive && (
                      <button className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400">
                        Set Active
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
