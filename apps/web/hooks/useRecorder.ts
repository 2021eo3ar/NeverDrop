"use client";

import { useState, useRef, useCallback } from "react";
import { uploadChunk } from "../lib/upload";

export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [chunkCount, setChunkCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const indexRef = useRef(0);

  const start = useCallback(async (recordingId: string) => {
    try {
      setError(null);
      setChunkCount(0);
      indexRef.current = 0;
      setStatus("requesting microphone...");

      // 1. Get audio stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      streamRef.current = stream;

      // 2. Create MediaRecorder
      const recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      recorderRef.current = recorder;

      // 3. Handle data available
      recorder.ondataavailable = async (event) => {
        if (event.data.size === 0) return;

        const chunkIndex = indexRef.current++;
        const chunkId = `${recordingId}-${chunkIndex}`;

        setStatus(`uploading chunk ${chunkIndex}...`);

        try {
          await uploadChunk(chunkId, recordingId, event.data);
          setChunkCount((prev) => prev + 1);
          setStatus(`chunk ${chunkIndex} uploaded`);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Upload failed";
          setError(message);
          setStatus(`chunk ${chunkIndex} failed — saved to OPFS`);
        }
      };

      recorder.onerror = () => {
        setError("MediaRecorder error");
        setStatus("error");
      };

      // 4. Start recording with 5-second intervals
      recorder.start(5000);
      setRecording(true);
      setStatus("recording...");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start recording";
      setError(message);
      setStatus("error");
    }
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    recorderRef.current = null;
    streamRef.current = null;
    setRecording(false);
    setStatus("stopped");
  }, []);

  return { start, stop, recording, chunkCount, error, status };
}
