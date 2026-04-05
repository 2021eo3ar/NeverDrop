"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { reconcile, type ReconcileResult, type ReconcileChunkResult } from "../lib/reconcile";

export function useReconciler(recordingId: string) {
  const [resynced, setResynced] = useState(0);
  const [expired, setExpired] = useState(0);
  const [failed, setFailed] = useState(0);
  const [reconciling, setReconciling] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [lastLog, setLastLog] = useState<ReconcileChunkResult[]>([]);
  const recordingIdRef = useRef(recordingId);

  // Keep ref in sync
  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  const runReconcile = useCallback(async () => {
    // The reconcile() function has its own concurrency guard,
    // but we also guard here to prevent redundant state updates
    if (reconciling) return;

    try {
      setReconciling(true);
      const result: ReconcileResult = await reconcile(recordingIdRef.current);
      setResynced((prev) => prev + result.resynced);
      setExpired((prev) => prev + result.expired);
      setFailed((prev) => prev + result.failed);
      setLastLog(result.log);
      setLastChecked(new Date());
    } catch {
      // Reconciliation failed — will retry on next trigger
    } finally {
      setReconciling(false);
    }
  }, [reconciling]);

  // Run reconcile once on mount
  useEffect(() => {
    runReconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to "online" event → run reconcile again
  useEffect(() => {
    const handler = () => {
      runReconcile();
    };

    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [runReconcile]);

  // Listen to "visibilitychange" → reconcile when tab becomes visible
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        runReconcile();
      }
    };

    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [runReconcile]);

  return {
    resynced,
    expired,
    failed,
    reconciling,
    lastChecked,
    lastLog,
    runReconcile,
  };
}
