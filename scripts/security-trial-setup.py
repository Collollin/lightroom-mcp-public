#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

os.umask(0o077)
root = Path(__file__).resolve().parents[1]
pins = json.loads((root / "security/trial-pins.json").read_text())
target = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / ".cache/lightroom-mcp-security").resolve()
if target == root or root in target.parents:
    raise SystemExit("setup target must be outside the checkout")
target.mkdir(parents=True, exist_ok=True, mode=0o700)
machine = {"aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine(), platform.machine())
system = platform.system().lower()
asset = f"{system}_{machine}"
if asset not in pins["osvAssets"]:
    raise SystemExit("supported hosts are macOS arm64 and Linux amd64")


def download(url, path, checksum):
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
        with urllib.request.urlopen(url) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != checksum:
            raise RuntimeError("download checksum mismatch")
        path.write_bytes(data)


phase = "osv-download"
try:
    osv = target / "osv-scanner"
    download(f"https://github.com/google/osv-scanner/releases/download/v{pins['osv']}/osv-scanner_{asset}", osv, pins["osvAssets"][asset])
    osv.chmod(0o700)
    phase = "trufflehog-download"
    archive = target / "trufflehog.tar.gz"
    download(f"https://github.com/trufflesecurity/trufflehog/releases/download/v{pins['trufflehog']}/trufflehog_{pins['trufflehog']}_{asset}.tar.gz", archive, pins["trufflehogAssets"][asset])
    phase = "trufflehog-extraction"
    with tarfile.open(archive) as bundle:
        member = next(m for m in bundle.getmembers() if m.name == "trufflehog" and m.isfile())
        (target / "trufflehog").write_bytes(bundle.extractfile(member).read())
    (target / "trufflehog").chmod(0o700)
    python = target / "semgrep-venv/bin/python"
    with tempfile.TemporaryFile() as log:
        phase = "semgrep-environment"
        subprocess.run([str(Path(sys.executable).resolve()), "-m", "venv", str(target / "semgrep-venv")], stdout=log, stderr=log, check=True)
        phase = "semgrep-installation"
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", f"semgrep=={pins['semgrep']}"], stdout=log, stderr=log, check=True)
    phase = "rules-download"
    rules_archive = target / "semgrep-rules.tar.gz"
    download(f"https://api.github.com/repos/semgrep/semgrep-rules/tarball/{pins['rulesCommit']}", rules_archive, pins["rulesSha256"])
    rules_dir = target / "rules"
    rules_dir.mkdir(exist_ok=True)
    phase = "rules-extraction"
    with tarfile.open(rules_archive) as bundle:
        bundle.extractall(rules_dir, filter="data")
    phase = "rules-composition"
    with tempfile.TemporaryFile() as log:
        subprocess.run([str(python), str(root / "scripts/security-trial-rules.py"), str(target)], stdout=log, stderr=log, check=True)
except Exception:
    raise SystemExit(f"security trial setup failed during {phase}; no scanner output published") from None
print("security trial setup complete")
