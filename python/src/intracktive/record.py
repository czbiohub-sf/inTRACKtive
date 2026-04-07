import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import click

from intracktive.createHash import generate_viewer_state_hash
from intracktive.open import open_file
from intracktive.server import DEFAULT_HOST, find_available_port, serve_directory

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None  # type: ignore[assignment]

LOG = logging.getLogger(__name__)
LOG.setLevel(logging.INFO)

# Mirrors the quality presets in SaveVideoButton.tsx.
# ffmpeg CRF: lower = better quality / larger file (0 = lossless, 23 = ffmpeg default).
QUALITY_PRESETS: dict[str, int] = {
    "low":   28,
    "medium": 22,
    "high":  18,
    "ultra": 12,
}


def record_file(
    input_path: Path,
    output: Path,
    fps: int = 24,
    skip: int = 1,
    width: int = 1280,
    height: int = 720,
    quality: str = "high",
    out_dir: Path | None = None,
) -> None:
    """
    Record a video of the inTRACKtive visualization.

    Starts a local server, drives a headless browser through every timepoint
    (waiting for data to load at each frame), captures the WebGL canvas as PNG
    frames, and encodes them into an MP4 with ffmpeg.

    Parameters
    ----------
    input_path : Path
        Path to a Zarr store, CSV, Parquet, or GEFF file.
    output : Path
        Destination MP4 file.
    fps : int
        Output video frame rate.
    skip : int
        Capture every N-th timepoint (skip=1 captures all frames).
    width : int
        Headless browser viewport width in pixels.
    height : int
        Headless browser viewport height in pixels.
    quality : str
        Encoding quality preset: 'low', 'medium', 'high' (default), or 'ultra'.
        Maps to ffmpeg CRF values — lower CRF means better quality and larger files.
    out_dir : Path | None
        Directory for converted Zarr files (optional).
    """
    if quality not in QUALITY_PRESETS:
        raise click.UsageError(
            f"Invalid quality '{quality}'. Choose from: {', '.join(QUALITY_PRESETS)}."
        )
    if sync_playwright is None:
        raise click.UsageError(
            "The 'playwright' package is required for recording. "
            "Install it with: pip install 'intracktive[record]'"
        )

    if shutil.which("ffmpeg") is None:
        raise click.UsageError(
            "ffmpeg is not installed or not on PATH. "
            "Install it with your package manager (e.g. 'sudo apt install ffmpeg' or 'brew install ffmpeg')."
        )

    # Convert/validate input and get the zarr path (no browser opened)
    LOG.info("Preparing data...")
    zarr_path = open_file(input_path=input_path, no_browser=True, out_dir=out_dir)

    # Start the data server
    zarr_dir = zarr_path.parent
    frontend_path = Path(__file__).parent / "frontend"
    use_local_frontend = frontend_path.exists() and (frontend_path / "index.html").exists()

    data_port = find_available_port(8000)
    data_url = f"http://{DEFAULT_HOST}:{data_port}/{zarr_path.name}/"
    serve_directory(path=zarr_dir, host=DEFAULT_HOST, port=data_port, threaded=True)

    if use_local_frontend:
        frontend_port = find_available_port(data_port + 1)
        serve_directory(path=frontend_path, host=DEFAULT_HOST, port=frontend_port, threaded=True)
        base_url = f"http://{DEFAULT_HOST}:{frontend_port}"
    else:
        raise click.UsageError(
            "No bundled frontend found. The 'record' command requires a locally installed "
            "inTRACKtive package with the bundled frontend (run 'npm run build:python' first)."
        )

    full_url = base_url + generate_viewer_state_hash(data_url=str(data_url))
    LOG.info("App URL: %s", full_url)

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": width, "height": height})

            LOG.info("Loading app...")
            page.goto(full_url)

            # Wait for the app to initialise and the first frame to load
            page.wait_for_function(
                "window.__intracktive_loading !== undefined && !window.__intracktive_loading",
                timeout=30_000,
            )

            num_times: int = page.evaluate("window.__intracktive_numTimes")
            if not num_times:
                raise click.UsageError("Could not determine number of timepoints from the app.")

            frames_to_capture = list(range(0, num_times, skip))
            LOG.info(
                "Capturing %d frames (skip=%d, total timepoints=%d)...",
                len(frames_to_capture),
                skip,
                num_times,
            )

            canvas_locator = page.locator("canvas").first
            for i, t in enumerate(frames_to_capture):
                page.evaluate(f"window.__intracktive_setTime({t})")

                # Wait for data to load for this timepoint
                page.wait_for_function(
                    "!window.__intracktive_loading",
                    timeout=60_000,
                )

                # Small pause to let Three.js render the new frame
                time.sleep(0.05)

                frame_path = tmp_path / f"frame{i:05d}.png"
                canvas_locator.screenshot(path=str(frame_path))

                if (i + 1) % 10 == 0 or i == len(frames_to_capture) - 1:
                    LOG.info("  %d/%d frames captured", i + 1, len(frames_to_capture))

            browser.close()

        crf = QUALITY_PRESETS[quality]
        LOG.info("Encoding MP4 (quality=%s, CRF=%d)...", quality, crf)
        ffmpeg_cmd = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", str(tmp_path / "frame%05d.png"),
            "-c:v", "libx264",
            "-crf", str(crf),
            "-preset", "slow",
            "-pix_fmt", "yuv420p",
            str(output),
        ]
        subprocess.run(ffmpeg_cmd, check=True)

    LOG.info("Video saved to: %s", output)


@click.command("record")
@click.argument(
    "input_path",
    type=click.Path(exists=True, path_type=Path),
)
@click.option(
    "--output", "-o",
    type=click.Path(path_type=Path),
    default=Path("intracktive.mp4"),
    show_default=True,
    help="Output MP4 file path.",
)
@click.option(
    "--fps",
    type=int,
    default=24,
    show_default=True,
    help="Output video frame rate.",
)
@click.option(
    "--skip",
    type=int,
    default=1,
    show_default=True,
    help="Capture every N-th timepoint (useful for very long datasets).",
)
@click.option(
    "--width",
    type=int,
    default=1280,
    show_default=True,
    help="Headless browser viewport width in pixels.",
)
@click.option(
    "--height",
    type=int,
    default=720,
    show_default=True,
    help="Headless browser viewport height in pixels.",
)
@click.option(
    "--quality",
    type=click.Choice(list(QUALITY_PRESETS), case_sensitive=False),
    default="high",
    show_default=True,
    help="Encoding quality: low / medium / high / ultra (maps to ffmpeg CRF 28/22/18/12).",
)
@click.option(
    "--out_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=None,
    help="Directory for converted Zarr files (optional).",
)
def record_cli(
    input_path: Path,
    output: Path,
    fps: int,
    skip: int,
    width: int,
    height: int,
    quality: str,
    out_dir: Path | None,
) -> None:
    """
    Record an MP4 video of the inTRACKtive visualization.

    Opens the data in a headless browser, captures each timepoint after data
    has fully loaded, and encodes the frames into an MP4.

    Requires: playwright (pip install 'intracktive[record]') and ffmpeg (system install).

    Example usage:

    intracktive record /path/to/data.zarr
    intracktive record /path/to/data.zarr --fps 30 --skip 5 --output video.mp4
    intracktive record /path/to/data.csv --fps 24 --width 1920 --height 1080
    """
    record_file(
        input_path=input_path,
        output=output,
        fps=fps,
        skip=skip,
        width=width,
        height=height,
        quality=quality,
        out_dir=out_dir,
    )


if __name__ == "__main__":
    record_cli()
