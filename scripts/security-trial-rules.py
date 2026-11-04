import json
from pathlib import Path
import sys
from ruamel.yaml import YAML

target = Path(sys.argv[1])
pins = json.loads((Path(__file__).resolve().parents[1] / "security/trial-pins.json").read_text())
upstream = next((target / "rules").glob("semgrep-semgrep-rules-*"))
yaml = YAML(typ="safe")
rules = []
for directory in ["javascript", "typescript", "yaml/github-actions"]:
    for path in sorted(p for p in (upstream / directory).rglob("*") if p.suffix in {".yaml", ".yml"}):
        if ".test." in path.name:
            continue
        document = yaml.load(path.read_text())
        for rule in document.get("rules", []) if isinstance(document, dict) else []:
            rule["id"] = path.relative_to(upstream).with_suffix("").as_posix().replace("/", ".") + "." + rule["id"]
            rules.append(rule)
if len(rules) != 228 or len({r["id"] for r in rules}) != len(rules):
    raise SystemExit("unexpected pinned rule inventory")
(target / "rules.json").write_text(json.dumps({"rules": rules}, indent=2) + "\n")
(target / "rule-provenance.json").write_text(json.dumps({"commit": pins["rulesCommit"], "count": len(rules), "archiveSha256": pins["rulesSha256"]}, indent=2) + "\n")
