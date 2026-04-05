"use client";

import { useState, useEffect, useCallback } from "react";
import { nanoid } from "nanoid";
import { useRecorder } from "@/hooks/useRecorder";
import { useReconciler } from "@/hooks/useReconciler";
import { useMetrics } from "@/hooks/useMetrics";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Mic,
  MicOff,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Database,
  Cloud,
  ChevronRight,
  BarChart3,
  Clock,
  AlertTriangle,
} from "lucide-react";

// ── Pipeline Stepper ──────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { label: "Record", icon: Mic, description: "Capture audio" },
  { label: "OPFS", icon: HardDrive, description: "Local persist" },
  { label: "Bucket", icon: Cloud, description: "S3/MinIO upload" },
  { label: "DB Ack", icon: Database, description: "Acknowledge" },
];

function PipelineStepper({ activeStep }: { activeStep: number }) {
  return (
    <div className="flex items-center justify-between w-full">
      {PIPELINE_STEPS.map((step, i) => {
        const Icon = step.icon;
        const isActive = i === activeStep;
        const isCompleted = i < activeStep;

        return (
          <div key={step.label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-2">
              <div
                className={`
                  relative flex h-12 w-12 items-center justify-center rounded-xl border-2 transition-all duration-500
                  ${
                    isActive
                      ? "border-primary bg-primary/10 text-primary shadow-lg shadow-primary/25 scale-110"
                      : isCompleted
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-500"
                        : "border-muted-foreground/20 bg-muted/30 text-muted-foreground/40"
                  }
                `}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <Icon className="h-5 w-5" />
                )}
                {isActive && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-primary animate-ping" />
                )}
              </div>
              <div className="text-center">
                <p
                  className={`text-xs font-semibold ${
                    isActive
                      ? "text-primary"
                      : isCompleted
                        ? "text-emerald-500"
                        : "text-muted-foreground/50"
                  }`}
                >
                  {step.label}
                </p>
                <p className="text-[10px] text-muted-foreground/50">
                  {step.description}
                </p>
              </div>
            </div>
            {i < PIPELINE_STEPS.length - 1 && (
              <div className="flex-1 flex items-center justify-center px-2 -mt-6">
                <div
                  className={`h-0.5 w-full rounded transition-all duration-500 ${
                    isCompleted
                      ? "bg-emerald-500"
                      : "bg-muted-foreground/10"
                  }`}
                />
                <ChevronRight
                  className={`h-3 w-3 -ml-1 shrink-0 ${
                    isCompleted
                      ? "text-emerald-500"
                      : "text-muted-foreground/20"
                  }`}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function Home() {
  const [recordingId, setRecordingId] = useState("");
  const [online, setOnline] = useState(true);
  const [supportsRecording, setSupportsRecording] = useState(true);

  const { start, stop, recording, chunkCount, error, status } = useRecorder();
  const {
    resynced,
    expired,
    failed,
    reconciling,
    lastChecked,
    runReconcile,
  } = useReconciler(recordingId);
  const { metrics, loading: metricsLoading } = useMetrics();

  // Generate recordingId on mount
  useEffect(() => {
    setRecordingId(nanoid(12));
    setOnline(navigator.onLine);
    setSupportsRecording(
      typeof MediaRecorder !== "undefined" &&
        typeof navigator.mediaDevices !== "undefined"
    );
  }, []);

  // Track online/offline
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      stop();
    } else {
      start(recordingId);
    }
  }, [recording, stop, start, recordingId]);

  // Determine pipeline active step
  const getActiveStep = () => {
    if (!recording && chunkCount === 0) return -1; // inactive
    if (recording && status.includes("recording")) return 0;
    if (status.includes("uploading") || status.includes("saved to OPFS"))
      return 1;
    if (status.includes("uploaded")) return 3;
    if (recording) return 0;
    return 3;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-2xl px-4 py-12 space-y-6">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              Recording Pipeline
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Reliable audio chunking with OPFS persistence
            </p>
          </div>
          <Badge
            variant={online ? "success" : "destructive"}
            className="gap-1.5 px-3 py-1"
          >
            {online ? (
              <Wifi className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            {online ? "Online" : "Offline"}
          </Badge>
        </div>

        {/* ── Pipeline Status ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pipeline Status</CardTitle>
            <CardDescription>
              Data flow: Record → OPFS → Bucket → DB Ack
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PipelineStepper activeStep={getActiveStep()} />
          </CardContent>
        </Card>

        {/* ── Recording Card ───────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Audio Recorder</CardTitle>
                <CardDescription className="mt-1">
                  ID:{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                    {recordingId || "..."}
                  </code>
                </CardDescription>
              </div>
              <Badge variant="secondary" className="gap-1 tabular-nums">
                {chunkCount} chunk{chunkCount !== 1 ? "s" : ""}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Button
                id="toggle-recording"
                onClick={handleToggleRecording}
                disabled={!supportsRecording}
                variant={recording ? "destructive" : "default"}
                size="lg"
                className="gap-2 min-w-[160px]"
              >
                {recording ? (
                  <>
                    <MicOff className="h-4 w-4" />
                    Stop Recording
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4" />
                    Start Recording
                  </>
                )}
              </Button>
              {recording && (
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                  </span>
                  <span className="text-sm text-muted-foreground">Live</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium">Status:</span>
              <span className="capitalize">{status}</span>
            </div>

            {!supportsRecording && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Not supported</AlertTitle>
                <AlertDescription>
                  Your browser does not support MediaRecorder. Try Chrome or
                  Firefox.
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* ── Reconciliation Card ──────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Reconciliation</CardTitle>
                <CardDescription>
                  Automatically re-uploads failed chunks
                </CardDescription>
              </div>
              <div className="flex gap-1.5">
                <Badge variant="outline" className="tabular-nums">
                  {resynced} resynced
                </Badge>
                {expired > 0 && (
                  <Badge variant="warning" className="tabular-nums gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {expired} expired
                  </Badge>
                )}
                {failed > 0 && (
                  <Badge variant="destructive" className="tabular-nums">
                    {failed} failed
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Last checked</span>
                <p className="font-medium mt-0.5">
                  {lastChecked
                    ? lastChecked.toLocaleTimeString()
                    : "Not yet"}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Chunks resynced</span>
                <p className="font-medium mt-0.5">{resynced}</p>
              </div>
            </div>

            <Button
              id="run-reconciliation"
              onClick={runReconcile}
              disabled={reconciling}
              variant="outline"
              className="gap-2"
            >
              <RefreshCw
                className={`h-4 w-4 ${reconciling ? "animate-spin" : ""}`}
              />
              {reconciling ? "Reconciling..." : "Run Reconciliation"}
            </Button>
          </CardContent>
        </Card>

        {/* ── Server Metrics Card ──────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  Server Metrics
                </CardTitle>
                <CardDescription>
                  Live statistics from the backend (polled every 10s)
                </CardDescription>
              </div>
              {!metricsLoading && metrics && (
                <Badge
                  variant={
                    metrics.pendingChunks > 0 ? "warning" : "success"
                  }
                  className="tabular-nums"
                >
                  {metrics.pendingChunks > 0
                    ? `${metrics.pendingChunks} pending`
                    : "All synced"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <p className="text-sm text-muted-foreground animate-pulse">
                Loading metrics...
              </p>
            ) : metrics ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="text-2xl font-bold tabular-nums">
                    {metrics.totalChunks}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Confirmed</p>
                  <p className="text-2xl font-bold tabular-nums text-emerald-500">
                    {metrics.confirmedChunks}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Pending</p>
                  <p className="text-2xl font-bold tabular-nums text-amber-500">
                    {metrics.pendingChunks}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Avg Upload
                  </p>
                  <p className="text-2xl font-bold tabular-nums">
                    {metrics.avgUploadMs}
                    <span className="text-sm font-normal text-muted-foreground ml-0.5">
                      ms
                    </span>
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Could not reach server
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <p className="text-center text-xs text-muted-foreground/50 pt-4">
          Recording Pipeline • OPFS + S3/MinIO + PostgreSQL
        </p>
      </div>
    </div>
  );
}
