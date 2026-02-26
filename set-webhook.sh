#!/bin/bash

# Set Telegram webhook to point to this app's POST /api/telegram/webhook
# Requires: .env with TELEGRAM_TOKEN and TELEGRAM_WEBHOOK_BASE_URL

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -f .env ]; then
  echo -e "${RED}Error: .env not found${NC}"
  echo "Create .env with TELEGRAM_TOKEN and TELEGRAM_WEBHOOK_BASE_URL"
  exit 1
fi

TOKEN=$(grep TELEGRAM_TOKEN .env | cut -d '=' -f2 | tr -d '"' | tr -d "'" | xargs)
BASE_URL=$(grep TELEGRAM_WEBHOOK_BASE_URL .env | cut -d '=' -f2 | tr -d '"' | tr -d "'" | xargs)

if [ -z "$TOKEN" ]; then
  echo -e "${RED}Error: TELEGRAM_TOKEN not set in .env${NC}"
  exit 1
fi

if [ -z "$BASE_URL" ]; then
  echo -e "${RED}Error: TELEGRAM_WEBHOOK_BASE_URL not set in .env${NC}"
  echo "Add: TELEGRAM_WEBHOOK_BASE_URL=https://your-app-url (no trailing slash)"
  exit 1
fi

# Remove trailing slash if present
BASE_URL="${BASE_URL%/}"
WEBHOOK_URL="${BASE_URL}/api/telegram/webhook"

echo -e "${GREEN}Setting webhook to: ${WEBHOOK_URL}${NC}"
RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook?url=${WEBHOOK_URL}")
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

if echo "$RESPONSE" | grep -q '"ok":true'; then
  echo -e "\n${GREEN}Webhook set successfully.${NC} Telegram will send updates to ${WEBHOOK_URL}"
else
  echo -e "\n${RED}setWebhook failed.${NC} Check that:"
  echo "  - URL is HTTPS (Telegram requires HTTPS)"
  echo "  - Your server is reachable from the internet"
  exit 1
fi
