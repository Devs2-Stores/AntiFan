import subprocess
import time
import os
import sys

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
if not os.path.exists(CHROME_PATH):
    CHROME_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

def capture_url(url, output_path, width=1440, height=900, delay=3):
    """
    Captures screenshot of a URL at exact viewport dimensions using headless Chrome.
    """
    cmd = [
        CHROME_PATH,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        f"--window-size={width},{height}",
        f"--virtual-time-budget={int(delay * 1000)}",
        f"--screenshot={output_path}",
        url
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if os.path.exists(output_path):
        print(f"Captured {output_path} ({width}x{height})")
        return True
    else:
        print(f"Failed to capture {output_path}: {res.stderr}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python capture_screenshot.py <url> <output_path> [width] [height] [delay]")
        sys.exit(1)
    url = sys.argv[1]
    output = sys.argv[2]
    w = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
    h = int(sys.argv[4]) if len(sys.argv) > 4 else 900
    d = float(sys.argv[5]) if len(sys.argv) > 5 else 3.0
    capture_url(url, output, w, h, d)
