import json
import logging
from pathlib import Path
from urllib.parse import urlparse

import click
from intracktive.server import DEFAULT_HOST, find_available_port, serve_directory

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None  # type: ignore[assignment]

LOG = logging.getLogger(__name__)
LOG.setLevel(logging.INFO)

# WebCodecs bitrate presets (Mbps) — mirrors QUALITY_PRESETS in SaveVideoButton.tsx.
QUALITY_PRESETS: dict[str, int] = {
    "low": 20,
    "medium": 50,
    "high": 100,
    "ultra": 250,
}


def record_url(
    url: str,
    output: Path,
    fps: int = 24,
    skip: int = 1,
    width: int = 1280,
    height: int = 720,
    quality: str = "high",
) -> None:
    """
    Record a video of an inTRACKtive viewer URL.

    Parameters
    ----------
    url : str
        Full inTRACKtive URL including viewerState hash.
    output : Path
        Destination MP4 file.
    fps : int
        Output video frame rate.
    skip : int
        Capture every N-th timepoint (skip=1 captures all frames).
    width : int
        Browser viewport width in pixels.
    height : int
        Browser viewport height in pixels.
    quality : str
        Encoding quality preset: 'low', 'medium', 'high' (default), or 'ultra'.
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

    # Extract the viewerState fragment from the URL and serve it via the local
    # bundled frontend to avoid auth prompts on hosted deployments.
    fragment = urlparse(url).fragment
    frontend_path = Path(__file__).parent / "frontend"
    if not (frontend_path.exists() and (frontend_path / "index.html").exists()):
        raise click.UsageError(
            "No bundled frontend found. Run 'npm run build:python' first."
        )
    port = find_available_port(8000)
    serve_directory(path=frontend_path, host=DEFAULT_HOST, port=port, threaded=True)
    local_url = f"http://{DEFAULT_HOST}:{port}/#{fragment}"
    LOG.info("App URL: %s", local_url)

    bitrate_mbps = QUALITY_PRESETS[quality]

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=False)
        except Exception as exc:
            if "Executable doesn't exist" in str(exc):
                raise click.UsageError(
                    "Playwright browser not found. Run: playwright install chromium"
                ) from exc
            raise
        page = browser.new_page(viewport={"width": width, "height": height})

        LOG.info("Loading app (this may take a moment for large datasets)...")
        page.goto(local_url)

        LOG.info("Waiting for first frame to load...")
        page.wait_for_function(
            "window.__intracktive_loading !== undefined && !window.__intracktive_loading",
            timeout=60_000,
        )

        num_times: int = page.evaluate("window.__intracktive_numTimes")
        if not num_times:
            raise click.UsageError(
                "Could not determine number of timepoints from the app."
            )

        LOG.info(
            "Starting recording (%d timepoints, quality=%s)...",
            num_times,
            quality,
        )
        # Wait until SaveVideoButton has registered __intracktive_startRecording on the window.
        page.wait_for_function(
            "typeof window.__intracktive_startRecording === 'function'",
            timeout=30_000,
        )
        # Give Three.js a moment to render the first frame before capturing.
        page.wait_for_timeout(500)
        # Allow up to 3 s per frame, minimum 2 minutes.
        timeout_ms = max(120_000, num_times * 3_000)
        with page.expect_download(timeout=timeout_ms) as download_info:
            page.evaluate(
                f"""window.__intracktive_startRecording({{
                    fps: {fps},
                    frameSkip: {skip},
                    bitrateMbps: {bitrate_mbps},
                    filename: {json.dumps(output.name)},
                }})"""
            )
        download = download_info.value
        LOG.info("Encoding complete, saving video...")
        download.save_as(str(output))

        browser.close()

    LOG.info("Video saved to: %s", output)


@click.command("record")
@click.argument("url")
@click.option(
    "--output",
    "-o",
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
    help="Capture every N-th timepoint.",
)
@click.option(
    "--width",
    type=int,
    default=1280,
    show_default=True,
    help="Browser viewport width in pixels.",
)
@click.option(
    "--height",
    type=int,
    default=720,
    show_default=True,
    help="Browser viewport height in pixels.",
)
@click.option(
    "--quality",
    type=click.Choice(list(QUALITY_PRESETS), case_sensitive=False),
    default="high",
    show_default=True,
    help="Encoding quality: low / medium / high / ultra.",
)
def record_cli(
    url: str,
    output: Path,
    fps: int,
    skip: int,
    width: int,
    height: int,
    quality: str,
) -> None:
    """
    Record an MP4 video of an inTRACKtive viewer URL.

    URL should be a full inTRACKtive URL including the viewerState hash,
    e.g. https://intracktive.sf.czbiohub.org/#viewerState=...

    Requires: pip install 'intracktive[record]' && playwright install chromium

    Example usage:

    intracktive record "https://intracktive.sf.czbiohub.org/#viewerState=..."
    intracktive record "https://..." --fps 30 --output video.mp4
    intracktive record "https://..." --skip 5 --quality ultra
    """
    record_url(
        url=url,
        output=output,
        fps=fps,
        skip=skip,
        width=width,
        height=height,
        quality=quality,
    )


if __name__ == "__main__":
    record_cli()
