#!/bin/bash

echo "Checking for uncommitted changes..."
if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "-----------------"
  echo "--->>> ABORTING: Uncommitted changes detected. Please commit or stash your changes before deploying. <<<---"
  exit 1
fi

echo "Fetching latest changes from origin..."
if ! git fetch origin; then
  echo "-----------------"
  echo "--->>> ABORTING: Failed to fetch latest changes from origin. <<<---"
  exit 1
fi

echo "Checking for differences with origin/main..."
if ! git diff --quiet origin/main; then
  echo "-----------------"
  read -p "Local changes differ from origin/main. Do you want to push your changes? (y/n) " -r PUSH_CHANGES
  if [ "$PUSH_CHANGES" = "y" ]; then
    if ! git push origin main; then
      echo "-----------------"
      echo "--->>> ABORTING: Failed to push changes to origin/main. <<<---"
      exit 1
    fi
  fi
fi

echo "-----------------"
read -p "Deploy to CommonsDB prod (stage cdb-b2b-api-prod)? (y/n) " -r DEPLOY_TO_PROD
if [ "$DEPLOY_TO_PROD" = "y" ]; then
  if ! sst deploy --stage cdb-b2b-api-prod; then
    echo "-----------------"
    echo "--->>> ABORTING: Deployment to prod failed. <<<---"
    exit 1
  fi
fi
