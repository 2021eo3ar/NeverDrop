import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = "http://localhost:3000";
const RECORDING_ID = __ENV.RECORDING_ID || `recording-loadtest-${Date.now()}`;

export const options = {
  scenarios: {
    // Happy path: normal uploads at high rate
    constant_load: {
      executor: "constant-arrival-rate",
      rate: 500,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 500,
      maxVUs: 1000,
      exec: "happyPath",
    },
    // Error path: 5% malformed payloads to verify graceful handling
    malformed_requests: {
      executor: "constant-arrival-rate",
      rate: 250,         // ~5% of 5000
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 50,
      maxVUs: 100,
      exec: "malformedPath",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1000"],
  },
};

// ── Happy path: valid upload ─────────────────────────────────────────────

export function happyPath() {
  const payload = JSON.stringify({
    chunkId: `chunk-${RECORDING_ID}-${__VU}-${__ITER}`,
    recordingId: RECORDING_ID,
    data: "x".repeat(1024),
  });

  const params = {
    headers: { "Content-Type": "application/json" },
  };

  const res = http.post(`${BASE_URL}/api/chunks/upload`, payload, params);

  check(res, {
    "upload status is 200": (r) => r.status === 200,
    "upload response has ok=true": (r) => {
      try {
        return JSON.parse(r.body).ok === true;
      } catch {
        return false;
      }
    },
  });
}

// ── Malformed path: test error handling ───────────────────────────────────

export function malformedPath() {
  const malformed = [
    // Missing chunkId
    JSON.stringify({ recordingId: "test", data: "abc" }),
    // Missing data
    JSON.stringify({ chunkId: "c1", recordingId: "test" }),
    // Empty body
    "{}",
    // Invalid JSON
    "not json at all",
    // Empty string fields
    JSON.stringify({ chunkId: "", recordingId: "", data: "" }),
  ];

  const payload = malformed[__ITER % malformed.length];
  const params = {
    headers: { "Content-Type": "application/json" },
  };

  const res = http.post(`${BASE_URL}/api/chunks/upload`, payload, params);

  check(res, {
    "malformed returns 400": (r) => r.status === 400,
  });
}

// ── Post-test validation ─────────────────────────────────────────────────
// After all iterations, verify DB vs bucket consistency.

export function handleSummary(data) {
  // Call the verify endpoint
  const verifyRes = http.get(
    `${BASE_URL}/api/recordings/${RECORDING_ID}/verify`
  );

  const body = JSON.parse(verifyRes.body);
  const verifyResult = body.consistent
    ? `CONSISTENT: ${body.totalChunks} chunks verified`
    : `INCONSISTENT: ${body.confirmed}/${body.totalChunks} chunks confirmed, ${body.pending} pending, ${body.missingFromBucket} missing from bucket`;

  if (body.totalChunks === 0) {
    return {
      stdout: `\n\n=== POST-TEST VERIFICATION FAILED ===\nRecording: ${RECORDING_ID}\nResult: No chunks found in DB. This means uploads never reached the DB.\n\n`,
    };
  }

  return {
    stdout: `\n\n=== POST-TEST VERIFICATION ===\nRecording: ${RECORDING_ID}\nResult: ${verifyResult}\n\n`,
  };
}

// ── Teardown: clean up test data ─────────────────────────────────────────
// Note: This logs the recording ID for manual cleanup since deleting
// from S3/DB requires admin access. In production you'd call a cleanup API.

export function teardown() {
  console.log(`[teardown] Test recording ID: ${RECORDING_ID}`);
  console.log(`[teardown] To clean up, delete recording ${RECORDING_ID} from DB and S3.`);

  // Verify final state
  const metricsRes = http.get(`${BASE_URL}/api/metrics`);
  try {
    const metrics = JSON.parse(metricsRes.body);
    console.log(`[teardown] Final metrics: ${JSON.stringify(metrics)}`);
  } catch {
    console.log(`[teardown] Could not fetch final metrics`);
  }
}
