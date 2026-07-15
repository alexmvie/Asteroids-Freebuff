#!/usr/bin/env python3
"""
Downloads a video from a given URL using the yt-dlp library.
"""
import sys
from pathlib import Path

try:
    import yt_dlp
except ImportError:
    print("Error: 'yt-dlp' library not found.", file=sys.stderr)
    print("Please install it by running: pip install yt-dlp", file=sys.stderr)
    sys.exit(1)


def download_video(url, output_dir="."):
    """
    Downloads a video from a URL to a specified directory.

    Args:
        url (str): The URL of the video to download.
        output_dir (str): The directory to save the video in.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    ydl_opts = {
        'outtmpl': str(output_path / '%(title)s [%(id)s].%(ext)s'),
        'format': 'bestvideo+bestaudio/best',
        'merge_output_format': 'mp4',
        'noplaylist': True,
    }

    print(f"Downloading video from: {url}")
    print(f"Saving to: {output_path.resolve()}")

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        print("\nDownload finished successfully!")
    except Exception as e:
        print(f"\nAn error occurred: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    video_url = "https://vk.com/video827003806_456239088"
    download_video(video_url, output_dir="mark13/downloads")