#!/usr/bin/env python3
"""Configure an installed Debug build over an already trusted device connection."""
import argparse
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--device", required=True, help="Identifier from xcrun devicectl list devices")
parser.add_argument("--url", required=True, help="HTTPS core URL, or http to the Mac on the same Wi-Fi")
args = parser.parse_args()
url = urlsplit(args.url)


def local_network(host: str) -> bool:
    """Mirrors ConnectionSettings.isLocalNetworkHost in the app."""
    host = host.lower()
    if host in ("localhost", "127.0.0.1", "::1") or host.endswith(".local"):
        return True
    try:
        a, b, _, _ = (int(p) for p in host.split("."))
    except ValueError:
        return False
    return a == 10 or (a, b) == (192, 168) or (a, b) == (169, 254) or (a == 172 and 16 <= b <= 31)


allowed = url.scheme == "https" or (url.scheme == "http" and url.hostname and local_network(url.hostname))
if not allowed or not url.hostname or url.username or url.password or url.query or url.fragment:
    parser.error("Use HTTPS (or http to the Mac on the local network) without credentials, query or fragment.")

root = Path(__file__).resolve().parent.parent
config = root.parent / "core" / ".env.device"
token = next((line.split("=", 1)[1].strip() for line in config.read_text().splitlines()
              if line.startswith("BRIDGE_TOKEN=")), "")
if not token:
    parser.error("Set BRIDGE_TOKEN in core/.env.device first.")

environment = os.environ.copy()
environment["DEVICECTL_CHILD_CALL_ASSISTANT_BRIDGE_URL"] = args.url
environment["DEVICECTL_CHILD_CALL_ASSISTANT_BRIDGE_TOKEN"] = token
# Pass the token via the environment, never CLI arguments, source files or logs.
result = subprocess.run([
    "xcrun", "devicectl", "device", "process", "launch", "--quiet",
    "--device", args.device, "--terminate-existing", "dev.prototype.callassistant"
], env=environment, capture_output=True, text=True)
if result.returncode:
    raise SystemExit("Device launch failed. Unlock the iPhone and check its connection in Xcode.")
print("App launched with connection settings. Verify connectivity in the app's Settings.")
