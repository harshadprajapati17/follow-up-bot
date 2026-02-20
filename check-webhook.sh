#!/bin/bash

# Script to check and manage Telegram webhook

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env.local exists
if [ ! -f .env.local ]; then
    echo -e "${RED}Error: .env.local file not found${NC}"
    echo "Please create .env.local with your TELEGRAM_TOKEN"
    exit 1
fi

# Extract token
TOKEN=$(grep TELEGRAM_TOKEN .env.local | cut -d '=' -f2 | tr -d '"' | tr -d "'")

if [ -z "$TOKEN" ]; then
    echo -e "${RED}Error: TELEGRAM_TOKEN not found in .env.local${NC}"
    exit 1
fi

echo -e "${GREEN}Checking webhook configuration...${NC}\n"

# Get webhook info
echo "Current webhook info:"
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool 2>/dev/null || curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
echo -e "\n"

# Check if webhook URL is set
WEBHOOK_URL=$(curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | grep -o '"url":"[^"]*' | cut -d'"' -f4)

if [ -z "$WEBHOOK_URL" ] || [ "$WEBHOOK_URL" = "null" ]; then
    echo -e "${YELLOW}Warning: No webhook URL is set${NC}"
    echo "You need to set a webhook URL. Example:"
    echo "curl -X POST \"https://api.telegram.org/bot${TOKEN}/setWebhook?url=https://your-tunnel-url/api/telegram/webhook\""
else
    echo -e "${GREEN}Webhook URL is set to: ${WEBHOOK_URL}${NC}"
    echo ""
    echo "To test if the endpoint is reachable, try:"
    echo "curl ${WEBHOOK_URL}"
    echo ""
    echo "If you need to update the webhook URL, use:"
    echo "curl -X POST \"https://api.telegram.org/bot${TOKEN}/setWebhook?url=NEW_URL/api/telegram/webhook\""
fi

echo ""
echo "To delete the webhook (if needed):"
echo "curl -X POST \"https://api.telegram.org/bot${TOKEN}/deleteWebhook\""
