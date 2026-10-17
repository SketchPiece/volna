#!/usr/bin/env python3
"""Read only the Zorava diagnostic stages from the connected development iPhone."""
import argparse
import datetime
import pathlib
import plistlib
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--device", default="C0F30EBA-D1A4-5E0A-B584-717CF73152AB")
parser.add_argument("--since", type=float, default=0, help="Only stages after this Unix timestamp")
parser.add_argument("--host-only", action="store_true", help="Skip extension preferences if unavailable on this device")
args = parser.parse_args()
bundle = "com.example.apple-samplecode.callkit-speakerbox-sample4KSA86792T"

with tempfile.TemporaryDirectory(prefix="zorava-probes-") as directory:
    targets = [("APP", bundle)]
    if not args.host_only:
        targets.append(("SIRI EXTENSION", bundle + ".IntentsExtension"))
    for label, identifier in targets:
        destination = pathlib.Path(directory) / (identifier + ".plist")
        print(f"\n{label}")
        try:
            result = subprocess.run([
                "xcrun", "devicectl", "device", "copy", "from", "--device", args.device,
                "--timeout", "15", "--domain-type", "appDataContainer", "--domain-identifier", identifier,
                "--source", f"Library/Preferences/{identifier}.plist", "--destination", str(destination)
            ], capture_output=True, text=True, timeout=25)
        except subprocess.TimeoutExpired:
            print("Timed out reading preferences; use the live Console capture or unlock the device before retrying.")
            continue
        if result.returncode or not destination.exists():
            print("Diagnostic preferences unavailable; this alone does not prove the extension was not invoked.")
            continue
        data = plistlib.loads(destination.read_bytes())
        for key in ("speakerboxSiriPermission", "speakerboxMicPermission", "zoravaLastStage"):
            if key in data:
                print(f"{key}: {data[key]}")
        count = 0
        for entry in data.get("speakerboxSiriProbe", []):
            timestamp, _, stage = entry.partition(" ")
            if "tone-1 " not in stage:
                continue
            try:
                timestamp = float(timestamp)
            except ValueError:
                continue
            if timestamp < args.since:
                continue
            time = datetime.datetime.fromtimestamp(timestamp).astimezone().isoformat(timespec="seconds")
            print(time, stage)
            count += 1
        if not count:
            print("No tone-1 stages in the selected interval.")
