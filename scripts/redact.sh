#!/bin/bash

# Set the AUTH_KEY variable to an empty string by default
AUTH_KEY=""
# Set the API_URL variable
API_URL=""

# Check if the AUTH_KEY is set
if [ -z "$AUTH_KEY" ]; then
  echo "Error: AUTH_KEY is not set."
  echo "Please set the AUTH_KEY variable in the script with your authorization key."
  exit 1
fi

# Check if the API_URL is set
if [ -z "$API_URL" ]; then
  echo "Error: API_URL is not set."
  echo "Please set the API_URL variable in the script with the correct URL."
  exit 1
fi

# Check if the declarationId parameter is provided
if [ -z "$1" ]; then
  echo "Error: declarationId parameter is required."
  echo "Usage: $0 <declarationId>"
  exit 1
fi

# Set the declarationId from the first parameter
declarationId=$1

# Run the curl command in the background
echo "\nWorking...\n"
curl --request POST \
  --url "$API_URL" \
  --header "Authorization: Bearer $AUTH_KEY" \
  --header 'Content-Type: application/json' \
  --data "{
    \"declarationId\": \"$declarationId\",
    \"isRedacted\": true
  }"

echo "\n-------------\nDone."
