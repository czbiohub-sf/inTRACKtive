/**
 * SaveVideoButton — frame-by-frame canvas recorder that exports an MP4.
 *
 * ## How recording works
 *
 * The button does NOT use the browser's screen-recording API (MediaRecorder /
 * captureStream) because that records in real time and cannot wait for slow
 * Zarr data fetches.  Instead, the recording loop lives in App.tsx and works
 * like this:
 *
 *  1. App.tsx sets curTime = 0 and creates a `recordingState` object.
 *  2. A useEffect in App.tsx watches `isLoadingPoints`: once the data for the
 *     current timepoint has fully loaded it calls
 *     `canvas.renderer.domElement.toDataURL("image/png")` inside a
 *     requestAnimationFrame callback (so the WebGL frame is guaranteed to be
 *     rendered), appends the data-URL to `capturedFrames`, and advances
 *     curTime by `frameSkip`.
 *  3. When curTime reaches numTimes the loop sets `active = false`.
 *  4. This component detects the transition to `active = false` and calls
 *     `encodeWithWebCodecs()`.
 *
 * ## Encoding
 *
 * Encoding uses the browser-native WebCodecs API (VideoEncoder) + mp4-muxer.
 * No WebAssembly / ffmpeg download required.  Supported in Chrome 94+ and
 * Safari 16.4+.  The button is hidden on Firefox (where WebCodecs are
 * unavailable or broken) and on any other browser that fails the capability
 * check.
 *
 * WebGL canvas pixels readback requires `preserveDrawingBuffer: true` on the
 * WebGLRenderer (set in PointCanvas.ts).
 */

import { ChangeEvent, useEffect, useState } from "react";
import { Button } from "@czi-sds/components";
import {
    Alert,
    Box,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    LinearProgress,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
} from "@mui/material";
import MovieIcon from "@mui/icons-material/Movie";

// ---------------------------------------------------------------------------
// Shared types (RecordingConfig is also imported by App.tsx)
// ---------------------------------------------------------------------------

/** Parameters chosen by the user before recording starts. */
export interface RecordingConfig {
    /** Frame rate of the output MP4. Independent of the data capture speed. */
    fps: number;
    /**
     * Capture every N-th timepoint.  frameSkip=1 records every frame;
     * frameSkip=10 records every 10th frame, reducing capture time and file
     * size for large datasets.
     */
    frameSkip: number;
    /**
     * Target video bitrate in Megabits per second.  Higher values preserve
     * fine dot detail (which DCT-based codecs tend to smear at low bitrates)
     * at the cost of a larger file.  100 Mbps is a good default for scientific
     * visualizations with many small bright points.
     */
    bitrateMbps: number;
    /** Output filename for the downloaded MP4. */
    filename: string;
}

/**
 * Managed by App.tsx, passed down as a prop so this component can react to
 * capture progress without owning the capture loop itself.
 */
export interface RecordingState {
    /** Whether the capture loop is currently running. */
    active: boolean;
    config: RecordingConfig;
    /** The timepoint we are currently waiting to capture. */
    targetTime: number;
    /** Accumulated PNG data-URLs, one per captured frame. */
    capturedFrames: string[];
    /**
     * True for one React render cycle immediately after curTime is dispatched.
     * Prevents capturing the previous frame's pixels during the short debounce
     * window before isLoadingPoints flips to true.
     */
    justAdvanced: boolean;
    /** Renderer CSS dimensions and point size before recording started — used to restore after recording. */
    originalSize: { width: number; height: number; pointSize: number } | null;
}

interface SaveVideoButtonProps {
    /** Total number of timepoints in the loaded dataset. */
    numTimes: number;
    /** The app's current playback FPS, used as the default output FPS. */
    playbackFPS: number;
    /** Current recording state from App.tsx, or null when not recording. */
    recordingState: RecordingState | null;
    /** Called when the user confirms settings and clicks "Start Recording". */
    onStartRecording: (config: RecordingConfig) => void;
    /** Called when the user clicks "Cancel" during capture. */
    onCancelRecording: () => void;
    /** Current data URL — used to derive the output filename. */
    dataUrl: string;
}

/** Internal UI state machine for this component. */
type ButtonState = "idle" | "dialog" | "recording" | "encoding" | "error";

// ---------------------------------------------------------------------------
// Quality presets
// ---------------------------------------------------------------------------

type VideoQuality = "low" | "medium" | "high" | "ultra";

const QUALITY_PRESETS: Record<VideoQuality, { label: string; bitrateMbps: number }> = {
    low: { label: "Low", bitrateMbps: 20 },
    medium: { label: "Medium", bitrateMbps: 50 },
    high: { label: "High", bitrateMbps: 100 },
    ultra: { label: "Ultra", bitrateMbps: 250 },
};

// ---------------------------------------------------------------------------
// Browser capability check
// ---------------------------------------------------------------------------

/**
 * Returns true if this browser can encode video with WebCodecs + mp4-muxer.
 *
 * Firefox is excluded explicitly even when VideoEncoder is defined, because
 * its implementation is incomplete and will fail at encode time.  The check
 * also tests an actual codec config rather than just `typeof VideoEncoder`,
 * because partial implementations may expose the API without supporting any
 * codec.
 */
async function checkWebCodecsSupported(): Promise<boolean> {
    if (navigator.userAgent.includes("Firefox")) return false;
    if (typeof VideoEncoder === "undefined") return false;
    try {
        for (const codec of ["avc1.4D0028", "avc1.42001E", "av01.0.04M.08", "vp09.00.10.08"]) {
            const result = await VideoEncoder.isConfigSupported({
                codec,
                width: 64,
                height: 64,
                bitrate: 1_000_000,
                framerate: 24,
            });
            if (result.supported) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/** Returns the label of the best codec this browser can encode, or null if none. */
async function detectBestCodecLabel(): Promise<string | null> {
    if (typeof VideoEncoder === "undefined") return null;
    const probes: { codec: string; label: string }[] = [
        { codec: "avc1.640034", label: "H.264" },
        { codec: "avc1.640033", label: "H.264" },
        { codec: "avc1.4D0028", label: "H.264" },
        { codec: "avc1.42001E", label: "H.264" },
        { codec: "av01.0.04M.08", label: "AV1 (needs macOS 13+ or VLC)" },
        { codec: "vp09.00.10.08", label: "VP9 (needs VLC)" },
    ];
    for (const { codec, label } of probes) {
        try {
            const result = await VideoEncoder.isConfigSupported({
                codec,
                width: 64,
                height: 64,
                bitrate: 1_000_000,
                framerate: 24,
            });
            if (result.supported) return label;
        } catch {
            // continue
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// MP4 encoder
// ---------------------------------------------------------------------------

/**
 * Encodes an array of PNG data-URLs into an MP4 file and triggers a browser
 * download.
 *
 * Codec selection tries H.264 variants first (best compatibility / file size),
 * then VP9 and AV1 as fallbacks.  The first codec accepted by
 * `VideoEncoder.isConfigSupported()` at the actual output resolution is used.
 *
 * H.264 requires even pixel dimensions — odd widths/heights are rounded down
 * by one pixel.
 */
async function encodeWithWebCodecs(
    frames: string[],
    outputFps: number,
    bitrateMbps: number,
    filename: string,
): Promise<void> {
    const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");

    // Convert data-URLs → ImageBitmaps in parallel
    const bitmaps: ImageBitmap[] = await Promise.all(
        frames.map((dataURL) =>
            fetch(dataURL)
                .then((r) => r.blob())
                .then((b) => createImageBitmap(b)),
        ),
    );

    // H.264 requires even dimensions; round down by 1px if needed
    const width = bitmaps[0].width % 2 === 0 ? bitmaps[0].width : bitmaps[0].width - 1;
    const height = bitmaps[0].height % 2 === 0 ? bitmaps[0].height : bitmaps[0].height - 1;

    // Codec preference order — most compatible first:
    //   H.264: universally supported by QuickTime, Windows Media Player, etc.
    //          Multiple levels are tried because 2× upscaling can exceed L4.0 (≤1920×1080).
    //          L5.1 covers 4K, L5.2 covers 8K.
    //   AV1:   supported by QuickTime on macOS 13 Ventura+; Chrome on Linux always has a SW encoder.
    //   VP9:   NOT supported by QuickTime; last resort so VLC/browsers can at least play it.
    type MuxerCodec = "avc" | "av1" | "vp9";
    const candidates: { encoderCodec: string; muxerCodec: MuxerCodec; label: string }[] = [
        { encoderCodec: "avc1.640034", muxerCodec: "avc", label: "H.264" }, // High L5.2 (8K)
        { encoderCodec: "avc1.640033", muxerCodec: "avc", label: "H.264" }, // High L5.1 (4K)
        { encoderCodec: "avc1.4D0028", muxerCodec: "avc", label: "H.264" }, // Main L4.0 (1080p)
        { encoderCodec: "avc1.42001E", muxerCodec: "avc", label: "H.264" }, // Baseline L3.0
        { encoderCodec: "av01.0.04M.08", muxerCodec: "av1", label: "AV1 (needs macOS 13+ or VLC)" },
        { encoderCodec: "vp09.00.10.08", muxerCodec: "vp9", label: "VP9 (needs VLC)" },
    ];

    const bitrateRaw = bitrateMbps * 1_000_000;

    let chosen: { encoderCodec: string; muxerCodec: MuxerCodec; label: string } | null = null;
    for (const candidate of candidates) {
        const support = await VideoEncoder.isConfigSupported({
            codec: candidate.encoderCodec,
            width,
            height,
            bitrate: bitrateRaw,
            framerate: outputFps,
        });
        if (support.supported) {
            chosen = candidate;
            break;
        }
    }
    if (!chosen) throw new Error("No supported video codec found in this browser.");

    console.log(`[SaveVideo] Using codec: ${chosen.label} (${chosen.encoderCodec})`);

    // H.264 in MP4 requires AVCC bitstream format (not Annex B).
    // Without this, mp4-muxer produces a malformed container that QuickTime rejects.
    const config: VideoEncoderConfig = {
        codec: chosen.encoderCodec,
        width,
        height,
        bitrate: bitrateRaw,
        framerate: outputFps,
    };
    if (chosen.muxerCodec === "avc") config.avc = { format: "avc" };

    // mp4-muxer accumulates the encoded data in memory
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
        target,
        video: { codec: chosen.muxerCodec, width, height },
        fastStart: "in-memory",
    });

    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta ?? undefined),
        error: (e) => {
            throw e;
        },
    });
    encoder.configure(config);

    // Each frame's timestamp and duration in microseconds
    const frameDurationUs = (1 / outputFps) * 1_000_000;

    for (let i = 0; i < bitmaps.length; i++) {
        const frame = new VideoFrame(bitmaps[i], {
            timestamp: Math.round(i * frameDurationUs),
            duration: Math.round(frameDurationUs),
        });
        // Insert a keyframe every 30 encoded frames so the video is seekable
        encoder.encode(frame, { keyFrame: i % 30 === 0 });
        frame.close();
        bitmaps[i].close();
    }

    await encoder.flush();
    muxer.finalize();

    // Trigger browser download
    const url = URL.createObjectURL(new Blob([target.buffer], { type: "video/mp4" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a short delay to ensure the download has started
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SaveVideoButton({
    numTimes,
    playbackFPS,
    recordingState,
    onStartRecording,
    onCancelRecording,
    dataUrl,
}: SaveVideoButtonProps) {
    const [buttonState, setButtonState] = useState<ButtonState>("idle");
    const [fps, setFps] = useState(playbackFPS);
    const [frameSkip, setFrameSkip] = useState(1);
    const [quality, setQuality] = useState<VideoQuality>("high");
    const [errorMessage, setErrorMessage] = useState<string>("");
    // null = still checking; false = not supported (hide button); true = show button
    const [webCodecsSupported, setWebCodecsSupported] = useState<boolean | null>(null);
    // label of the best codec available on this browser (e.g. "H.264", "AV1 (needs macOS 13+ or VLC)")
    const [availableCodecLabel, setAvailableCodecLabel] = useState<string | null>(null);

    // Run the capability check once on mount; button stays hidden (null/false) until resolved
    useEffect(() => {
        checkWebCodecsSupported().then(setWebCodecsSupported);
        detectBestCodecLabel().then(setAvailableCodecLabel);
    }, []);

    // Expose a global trigger so the CLI can start recording without going through the dialog.
    // Must live here (not App.tsx) so we can also set buttonState = "recording", which gates encoding.
    useEffect(() => {
        // eslint-disable-next-line camelcase
        (window as unknown as Record<string, unknown>).__intracktive_startRecording = (config: RecordingConfig) => {
            setButtonState("recording");
            onStartRecording(config);
        };
    }, [onStartRecording]);

    const bitrateMbps = QUALITY_PRESETS[quality].bitrateMbps;
    const activeFrameSkip = recordingState?.config.frameSkip ?? frameSkip;
    const totalFramesToCapture = numTimes > 0 ? Math.ceil(numTimes / activeFrameSkip) : 0;
    const capturedCount = recordingState?.capturedFrames.length ?? 0;
    const durationS = fps > 0 ? totalFramesToCapture / fps : 0;
    const estimatedMB = Math.round((bitrateMbps * durationS) / 8);

    // When the capture loop finishes (active flips to false), kick off encoding
    useEffect(() => {
        if (!recordingState) return;
        if (!recordingState.active && recordingState.capturedFrames.length > 0 && buttonState === "recording") {
            setButtonState("encoding");
            encodeWithWebCodecs(
                recordingState.capturedFrames,
                recordingState.config.fps,
                recordingState.config.bitrateMbps,
                recordingState.config.filename,
            )
                .then(() => {
                    setButtonState("idle");
                    onCancelRecording(); // clear captured frames from App.tsx state to free memory
                })
                .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error("[SaveVideo] Encoding failed:", err);
                    setErrorMessage(msg);
                    setButtonState("error");
                });
        }
    }, [recordingState, buttonState, onCancelRecording]);

    // When App.tsx acknowledges the start of recording, advance our UI state
    useEffect(() => {
        if (recordingState?.active && buttonState === "dialog") {
            setButtonState("recording");
        }
    }, [recordingState, buttonState]);

    const handleStart = () => {
        const zarrName =
            dataUrl
                .replace(/\/+$/, "")
                .split("/")
                .pop()
                ?.replace(/\.(zarr|zip|csv|parquet|geff)$/i, "") ?? "intracktive";
        const filename = `inTRACKtive_${zarrName}_${quality}.mp4`;
        onStartRecording({ fps, frameSkip, bitrateMbps, filename });
    };

    const handleCancel = () => {
        onCancelRecording();
        setButtonState("idle");
    };

    // Hide on unsupported browsers (Firefox, old Safari, etc.)
    if (!webCodecsSupported) return null;

    // --- Recording in progress ---
    if (buttonState === "recording") {
        return (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 200, px: 1 }}>
                <LinearProgress
                    variant="determinate"
                    value={totalFramesToCapture > 0 ? (capturedCount / totalFramesToCapture) * 100 : 0}
                    sx={{ flexGrow: 1 }}
                />
                <Typography variant="caption" sx={{ whiteSpace: "nowrap" }}>
                    {capturedCount}/{totalFramesToCapture}
                </Typography>
                <Tooltip title="Cancel recording">
                    <Button sdsStyle="square" sdsType="secondary" onClick={handleCancel}>
                        Cancel
                    </Button>
                </Tooltip>
            </Box>
        );
    }

    // --- Encoding in progress ---
    if (buttonState === "encoding") {
        return (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1 }}>
                <CircularProgress size={16} />
                <Typography variant="caption">Encoding MP4…</Typography>
            </Box>
        );
    }

    // --- Encoding error ---
    if (buttonState === "error") {
        return (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, maxWidth: 400 }}>
                <Alert severity="error" onClose={() => setButtonState("idle")} sx={{ fontSize: "0.75rem" }}>
                    Encoding failed: {errorMessage}
                </Alert>
            </Box>
        );
    }

    // --- Idle / settings dialog ---
    return (
        <>
            <Tooltip title="Save video of current view">
                <span>
                    <IconButton color="inherit" disabled={numTimes === 0} onClick={() => setButtonState("dialog")}>
                        <MovieIcon />
                    </IconButton>
                </span>
            </Tooltip>

            <Dialog open={buttonState === "dialog"} onClose={() => setButtonState("idle")}>
                <DialogTitle>Save Video</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 2, minWidth: 280 }}>
                        <TextField
                            label="Output FPS"
                            type="number"
                            variant="standard"
                            value={fps}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                setFps(Math.max(1, parseInt(e.target.value) || 1))
                            }
                            inputProps={{ min: 1, max: 120, style: { fontSize: "1.25rem" } }}
                            InputLabelProps={{ style: { fontSize: "1.25rem" } }}
                            fullWidth
                        />
                        <TextField
                            label="Capture every N-th frame (skip)"
                            type="number"
                            variant="standard"
                            value={frameSkip}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                setFrameSkip(Math.max(1, parseInt(e.target.value) || 1))
                            }
                            inputProps={{ min: 1, style: { fontSize: "1.25rem" } }}
                            InputLabelProps={{ style: { fontSize: "1.25rem" } }}
                            fullWidth
                        />
                        <Box>
                            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
                                Quality
                            </Typography>
                            <ToggleButtonGroup
                                value={quality}
                                exclusive
                                onChange={(_, v: VideoQuality | null) => v && setQuality(v)}
                                fullWidth
                                size="small"
                            >
                                {(
                                    Object.entries(QUALITY_PRESETS) as [
                                        VideoQuality,
                                        { label: string; bitrateMbps: number },
                                    ][]
                                ).map(([key, { label }]) => (
                                    <ToggleButton key={key} value={key}>
                                        {label}
                                    </ToggleButton>
                                ))}
                            </ToggleButtonGroup>
                        </Box>
                        <Typography variant="caption" color="text.secondary">
                            {totalFramesToCapture} frames → {Math.round(durationS)}s at {fps} FPS
                            {totalFramesToCapture > 0 ? ` · ≤${estimatedMB} MB` : ""}
                        </Typography>
                        {availableCodecLabel && (
                            <Typography
                                variant="caption"
                                color={availableCodecLabel.startsWith("H.264") ? "text.secondary" : "warning.main"}
                            >
                                Codec: {availableCodecLabel}
                            </Typography>
                        )}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button sdsStyle="square" sdsType="secondary" onClick={() => setButtonState("idle")}>
                        Cancel
                    </Button>
                    <Button sdsStyle="square" sdsType="primary" onClick={handleStart}>
                        Start Recording
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}
