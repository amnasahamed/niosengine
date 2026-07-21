#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
FAIL=0

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAIL=1; }

echo "Verifying niostech project..."
echo ""

# Required files
for f in \
  docker-compose.yml \
  .env.example \
  deploy.sh \
  README.md \
  n8n/whatsapp-crm-workflow.json \
  whatsapp-bridge/package.json \
  whatsapp-bridge/package-lock.json \
  whatsapp-bridge/Dockerfile \
  whatsapp-bridge/index.js; do
  if [[ -f "$f" ]]; then pass "$f exists"; else fail "Missing $f"; fi
done

# Secrets must not be committed
if [[ -f .env ]]; then
  fail ".env exists locally — ensure it is NOT committed (should be gitignored)"
else
  pass ".env not in repo"
fi

if [[ -d whatsapp-bridge/node_modules ]]; then
  fail "whatsapp-bridge/node_modules present — must not be committed"
else
  pass "node_modules not present"
fi

# JSON validity
if python3 -c "import json; json.load(open('n8n/whatsapp-crm-workflow.json'))" 2>/dev/null; then
  pass "n8n workflow JSON is valid"
else
  fail "n8n workflow JSON is invalid"
fi

# Workflow structure checks
python3 <<'PY' || FAIL=1
import json, sys
with open("n8n/whatsapp-crm-workflow.json") as f:
    wf = json.load(f)
names = {n["name"] for n in wf["nodes"]}
required = {
    "WhatsApp Webhook", "Normalize Message", "Valid Message?", "Save to Data Table",
    "Get Chat History", "Build AI Prompt", "GPT-4o Extract", "Map to CRM Fields",
    "Read CRM Sheet", "Merge With Existing Lead", "Upsert CRM Lead"
}
missing = required - names
if missing:
    print(f"✗ Workflow missing nodes: {missing}")
    sys.exit(1)
read = next(n for n in wf["nodes"] if n["name"] == "Read CRM Sheet")
if read["parameters"].get("operation") != "read":
    print("✗ Read CRM Sheet must have operation=read")
    sys.exit(1)
upsert = next(n for n in wf["nodes"] if n["name"] == "Upsert CRM Lead")
if upsert["parameters"].get("operation") != "appendOrUpdate":
    print("✗ Upsert CRM Lead must use appendOrUpdate")
    sys.exit(1)
if "Phone" not in upsert["parameters"]["columns"].get("matchingColumns", []):
    print("✗ Upsert must match on Phone column")
    sys.exit(1)
print("✓ Workflow nodes and operations look correct")
PY

# Webhook path alignment
WEBHOOK_PATH=$(python3 -c "import json; wf=json.load(open('n8n/whatsapp-crm-workflow.json')); print(next(n['parameters']['path'] for n in wf['nodes'] if n['name']=='WhatsApp Webhook'))")
if grep -q "webhook/${WEBHOOK_PATH}" .env.example; then
  pass "Webhook path matches .env.example (${WEBHOOK_PATH})"
else
  fail "Webhook path mismatch between workflow and .env.example"
fi

# docker-compose health + depends_on
if grep -q "condition: service_healthy" docker-compose.yml && grep -q "healthcheck:" docker-compose.yml; then
  pass "Docker startup order configured (n8n healthcheck)"
else
  fail "Docker missing healthcheck or depends_on condition"
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}All checks passed — safe to push to GitHub.${NC}"
  exit 0
else
  echo -e "${RED}Some checks failed — fix before pushing.${NC}"
  exit 1
fi
