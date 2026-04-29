#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DualDeployStack } from "../lib/dual-deploy-stack";
import { CiCdPipelineStack } from "../lib/cicd-pipeline-stack";

const app = new cdk.App();

const account =
  process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID ?? app.node.tryGetContext("account");
const region =
  process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? app.node.tryGetContext("region");

const httpsCertificateArn =
  process.env.HTTPS_CERTIFICATE_ARN ?? app.node.tryGetContext("httpsCertificateArn");

const enablePipeline =
  (process.env.ENABLE_PIPELINE_STACK ?? app.node.tryGetContext("enablePipeline") ?? "false") === "true";

new DualDeployStack(app, "FastApiDualDeployStack", {
  env: {
    account,
    region,
  },
  httpsCertificateArn: httpsCertificateArn || undefined,
});

if (enablePipeline) {
  const githubConnectionArn = process.env.GITHUB_CONNECTION_ARN ?? app.node.tryGetContext("githubConnectionArn");
  const githubOwner = process.env.GITHUB_OWNER ?? app.node.tryGetContext("githubOwner");
  const githubRepo = process.env.GITHUB_REPO ?? app.node.tryGetContext("githubRepo");
  const githubBranch = process.env.GITHUB_BRANCH ?? app.node.tryGetContext("githubBranch") ?? "main";

  if (!githubConnectionArn || !githubOwner || !githubRepo) {
    throw new Error(
      "ENABLE_PIPELINE_STACK=true exige GITHUB_CONNECTION_ARN, GITHUB_OWNER, et GITHUB_REPO (ou leurs équivalents en context CDK)."
    );
  }

  new CiCdPipelineStack(app, "FastApiCicdStack", {
    env: { account, region },
    githubConnectionArn,
    githubOwner,
    githubRepo,
    githubBranch,
    appStackName: "FastApiDualDeployStack",
    httpsCertificateArn: httpsCertificateArn || undefined,
  });
}
