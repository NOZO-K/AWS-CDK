# FastAPI Dual Deployment with AWS CDK (TypeScript)

## Architecture Diagram

Text diagram of the resources created by the CDK stacks:

```
                       (optional) ACM Certificate
                              (443)
          +--------------------------------------+
          |            Internet-facing ALB       |
          |  Listener 80  -> ECS/Fargate :8000   |
          |  Listener 443 -> ECS/Fargate :8000   |
          +-------------------+------------------+
                              |
                              | (SG: ALB -> ECS)
                              v
                   +------------------------+
                   |   ECS Fargate Service  |
                   |   (private subnets)    |
                   +-----------+------------+
                               |
                               | (IAM: read/write)
                               v
                        +----------------+
                        |      S3        |
                        | uploads bucket |
                        +----------------+

   Serverless entrypoint:
   +---------------------------+
   |    API Gateway HTTP API   |
   |    -> Lambda (FastAPI)    |
   +-------------+-------------+
                 |
                 | (IAM: read/write)
                 v
          +----- S3 -----+
```

## What this deploys

### Containerized target (ECS Fargate)
- A VPC with subnet segmentation:
  - Public subnets for the ALB
  - Private subnets for ECS tasks
- An internet-facing Application Load Balancer (ALB)
- An ECS Fargate service running in private subnets
- Security groups enforce: `Internet -> ALB -> ECS`
- ECS tasks are not directly reachable from the internet (`assignPublicIp: false`)

### Serverless target (API Gateway + Lambda)
- A Lambda function running the FastAPI app (packaged via the AWS Lambda Python alpha)
- An API Gateway HTTP API routing public requests to the Lambda integration

### Persistence
- A shared S3 bucket used by both ECS and Lambda to persist uploaded files (`/upload`, `/files`, delete)

## API endpoints

- `GET /health`
- `GET /upload` (UI page)
- `POST /upload`
- `GET /files`
- `DELETE /files/{filename}`

## Design Decisions

### 1) Storage choice (why S3?)
The application serves both:
- a containerized API (ECS/Fargate)
- a serverless API (Lambda + API Gateway)

Both compute environments must read/write the same uploaded files. S3 was chosen because it:
- provides durable, shared object storage across ECS and Lambda
- supports scalable file storage without managing file servers
- is accessed via standard IAM permissions (no VPC-only constraints)
- works well with the app patterns used here (object put/list/delete)

Alternatives considered:
- EFS: would require mounting into ECS and Lambda (Lambda needs special configuration) and adds operational overhead.
- DynamoDB: not a good fit for binary/object payloads; you'd still need a separate object store.
- Local disk / ephemeral storage: would break persistence for both ECS redeployments and Lambda cold starts.

### 2) How permissions are handled
Permissions are enforced at three layers:

#### Network access (ALB -> ECS)
- The ALB security group allows inbound `80` and (optionally) `443` from the internet.
- The ECS task security group allows inbound traffic only from the ALB security group on `8000`.
- ECS tasks run without public IPs, so they remain unreachable directly from the internet.

#### Application/data access (IAM -> S3)
- The S3 bucket grants read/write permissions to:
  - the ECS task role
  - the Lambda execution role
- This ensures both compute paths use the same bucket with least required capabilities for the app to function (read, write, list, delete).

#### CI/CD deployment access (CodeBuild role)
- The CodeBuild project runs `cdk deploy` to update the infrastructure.
- The CDK stack attaches an IAM policy to the CodeBuild role so it can deploy the app.
- For a production hardening pass, you should reduce the IAM scope from wildcard actions/resources to the smallest set required by your deployment.

### 3) Serverless architecture: choice + alternatives
Final routing/trigger choice:
- **API Gateway HTTP API** (API Gateway v2) as the public routing layer
- **AWS Lambda** as the serverless compute executing the FastAPI handler

Why this choice:
- HTTP API is lightweight and cost-effective for straightforward HTTP routing.
- API Gateway v2 + Lambda is a standard, managed integration with minimal operational overhead.
- It provides a simple public endpoint that matches the app's REST-style endpoints (`/health`, `/upload`, etc.).

Alternatives explored:
- API Gateway REST API:
  - More feature-rich, but typically higher complexity and cost for the same basic routing use case.
- Lambda Function URL:
  - Simpler to set up, but less integrated with enterprise API management features (custom domains, advanced auth patterns, etc.).
- ALB -> Lambda target group:
  - Possible, but this would introduce an additional load balancer path and network complexity compared to API Gateway for HTTP APIs.
- Event-driven triggers (SQS/SNS/EventBridge):
  - Not a match here because the requirements are synchronous HTTP request/response routing.

### 4) HTTPS (ALB listener on 443 with ACM)
By default the ALB exposes HTTP on port `80`.
If you provide an ACM certificate ARN to the app stack, it also creates:
- an ALB HTTPS listener on port `443` forwarding to the ECS service.

## Continuous Deployment (CodePipeline + CodeBuild)

The project can optionally deploy a CI/CD pipeline by creating an additional stack:
- `FastApiCicdStack`

Pipeline behavior:
- Detects changes in a GitHub repository via **CodeStar Connections**
- Builds and deploys automatically by running `cdk deploy` from CodeBuild
- Updates ECS/Fargate and Lambda as defined in the CDK application

Important notes:
- This pipeline uses `npx cdk deploy` during the CodeBuild step, so any Docker-based asset building (ECS image build + Lambda bundling) happens as part of the pipeline execution.

### Required environment variables (to enable the pipeline stack)
```bash
export ENABLE_PIPELINE_STACK=true
export GITHUB_CONNECTION_ARN="arn:aws:codestar-connections:us-east-1:123456789012:connection/...."
export GITHUB_OWNER="mon-org"
export GITHUB_REPO="mon-repo"
export GITHUB_BRANCH="main" # optional (default: main)
```

## HTTPS configuration (ACM)

The ECS/Fargate ALB exposes:
- HTTP listener on `80`
- HTTPS listener on `443` (only when `HTTPS_CERTIFICATE_ARN` is provided)

Set:
```bash
export HTTPS_CERTIFICATE_ARN="arn:aws:acm:us-east-1:123456789012:certificate/...."
```

Then deploy again:
```bash
npx cdk deploy --all
```

If a certificate is provided, you will also get an output `AlbUrlHttps`.

## Runbook: Deploy from Scratch

### Prerequisites
- An AWS account with permissions to create resources
- AWS credentials configured locally (e.g., `aws configure`)
- Node.js (>= 18)
- Docker running locally (needed for Docker-based asset builds during `cdk deploy`)

### 1) Install dependencies
```bash
npm install
```

### 2) Bootstrap the CDK environment (once per account/region)
```bash
npx cdk bootstrap
```

### 3) Configure optional HTTPS
- Create/choose a valid ACM certificate in the same region as the ALB
- Export:
```bash
export HTTPS_CERTIFICATE_ARN="arn:aws:acm:us-east-1:123456789012:certificate/...."
```

### 4) Deploy the application stack
```bash
npx cdk deploy FastApiDualDeployStack
```

Check outputs:
- `AlbUrl` (HTTP ALB endpoint for ECS/Fargate)
- `AlbUrlHttps` (only if `HTTPS_CERTIFICATE_ARN` was provided)
- `ServerlessApiUrl` (API Gateway endpoint)
- `UploadsBucketName`

### 5) (Optional) Enable Continuous Deployment (pipeline)
1. Create a **CodeStar Connection** to GitHub in the AWS console.
2. Export the required environment variables:
```bash
export ENABLE_PIPELINE_STACK=true
export GITHUB_CONNECTION_ARN="arn:aws:codestar-connections:us-east-1:123456789012:connection/...."
export GITHUB_OWNER="mon-org"
export GITHUB_REPO="mon-repo"
export GITHUB_BRANCH="main"
```
3. Deploy the full app:
```bash
npx cdk deploy --all
```

### Local testing (optional)
The existing `docker-compose.yml` is available for local container testing only.