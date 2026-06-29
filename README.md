# Massar App

This is the companion application repository for the [massar-aws-infrastructure](https://github.com/aymenelk01/massar-aws-infrastructure) project.

The frontend and backend were built with **Antigravity 2.0** specifically to validate and exercise the AWS infrastructure — not as a production application in their own right. The goal was to confirm that every infrastructure component (Aurora via RDS Proxy, ElastiCache Redis, Cognito JWT auth, SQS queues, Bedrock Nova Pro, S3 presigned URLs) behaved correctly end-to-end under realistic workloads.

---

## What is in this repository

```
massar-app/
│
├── app/
│   ├── backend/        # Express.js API (Node.js 18+, ARM64 Fargate)
│   ├── static/         # Vite frontend (Student, Teacher, Admin portals)
│   └── flyway/         # SQL migration scripts
│
└── .github/
    └── workflows/
        └── deploy.yml  # Three-job CI/CD pipeline (migrations → app → static)
```

## Stack

| Layer | Technology |
|---|---|
| Backend | Express.js running on ECS Fargate (ARM64 Graviton) |
| Frontend | Vite static site synced to S3, served via CloudFront |
| Database | Aurora Serverless v2 MySQL, accessed via RDS Proxy with IAM auth |
| Cache | ElastiCache Redis 7 (look-aside) |
| Auth | Amazon Cognito (JWT validation via `aws-jwt-verify`) |
| AI | Amazon Bedrock Nova Pro (student academic guidance) |
| Async | SQS + Lambda for email notifications and PDF diploma generation |
| Migrations | Flyway, run as a one-off ECS Fargate task |

## Deployment

This application is deployed automatically by the `deploy.yml` pipeline when triggered by the infrastructure repository or manually via GitHub Actions. It requires the infrastructure from [massar-aws-infrastructure](https://github.com/aymenelk01/massar-aws-infrastructure) to be fully applied first.

See the [Deployment Guide](https://github.com/aymenelk01/massar-aws-infrastructure/blob/main/DEPLOYMENT.md) in the infrastructure repository for full setup instructions.
