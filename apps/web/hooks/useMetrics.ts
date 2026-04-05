"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface ServerMetrics {
  totalChunks: number;
  pendingChunks: number;
  confirmedChunks: number;
  failedChunks: number;
  avgUploadMs: number;
  sampleCount: number;
}

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";
const POLL_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Polls /api/metrics every 10 seconds and returns server-side
 * chunk statistics for the UI dashboard.
 */
export function useMetrics() {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(`${SERVER_URL}/api/metrics`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = (await response.json()) as ServerMetrics;
      setMetrics(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch metrics"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch immediately on mount, then poll every 10s
  useEffect(() => {
    fetchMetrics();
    intervalRef.current = setInterval(fetchMetrics, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchMetrics]);

  // Pause polling when tab is hidden, resume when visible
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        fetchMetrics();
        if (!intervalRef.current) {
          intervalRef.current = setInterval(fetchMetrics, POLL_INTERVAL_MS);
        }
      } else {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    };

    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [fetchMetrics]);

  return { metrics, loading, error, refetch: fetchMetrics };
}
