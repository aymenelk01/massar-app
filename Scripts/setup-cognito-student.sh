#!/bin/bash

set -e
export AWS_PAGER=""


USER_POOL_ID="eu-south-1_bWMNQmJaV" # Replace with your User Pool ID
REGION="eu-south-1"

echo "enter username"   
read -r USERNAME

echo "Enter password for user ${USERNAME}:"
read -s PASSWORD



aws cognito-idp admin-create-user \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --message-action SUPPRESS \
  --region "${REGION}"


aws cognito-idp admin-set-user-password \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --password "${PASSWORD}" \
  --permanent \
  --region "${REGION}"