#!/bin/bash

set -e
export AWS_PAGER=""


USER_POOL_ID="eu-south-1_3QYn6cnDA"
REGION="eu-south-1"
GROUP_NAME="admins"
echo "enter a username"
read -r USERNAME

echo "Enter password for user ${USERNAME}:"
read -s PASSWORD

echo "Starting AWS Cognito user provisioning..."

echo "Creating group: ${GROUP_NAME}..."

aws cognito-idp create-group \
  --group-name "${GROUP_NAME}" \
  --user-pool-id "${USER_POOL_ID}" \
  --region "${REGION}" || echo "Group ${GROUP_NAME} already exists. Skipping group creation."

echo "Creating user: ${USERNAME}..."
aws cognito-idp admin-create-user \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --message-action SUPPRESS \
  --region "${REGION}" || echo "User ${USERNAME} already exists. Skipping user creation."

echo "Setting permanent password for user: ${USERNAME}..."
aws cognito-idp admin-set-user-password \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --password "${PASSWORD}" \
  --permanent \
  --region "${REGION}"

echo "Adding user ${USERNAME} to group ${GROUP_NAME}..."
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "${USER_POOL_ID}" \
  --username "${USERNAME}" \
  --group-name "${GROUP_NAME}" \
  --region "${REGION}"

echo "AWS Cognito user provisioning completed successfully."