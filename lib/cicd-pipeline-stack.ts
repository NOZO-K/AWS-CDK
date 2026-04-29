import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

export interface CiCdPipelineStackProps extends StackProps {
  githubConnectionArn: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch?: string;

  /**
   * Nom (id CDK) de la stack applicative à déployer.
   * Utilisé dans la commande `cdk deploy`.
   */
  appStackName: string;

  httpsCertificateArn?: string;
}

export class CiCdPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: CiCdPipelineStackProps) {
    super(scope, id, props);

    const sourceOutput = new codepipeline.Artifact();

    const buildProject = new codebuild.PipelineProject(this, "BuildAndDeployProject", {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // nécessaire pour docker build (CDK + bundling lambda)
        environmentVariables: {
          APP_STACK_NAME: { value: props.appStackName },
          // Empêche de re-créer la stack pipeline pendant le `cdk deploy`.
          ENABLE_PIPELINE_STACK: { value: "false" },
          HTTPS_CERTIFICATE_ARN: { value: props.httpsCertificateArn ?? "" },
        },
      },
      timeout: Duration.minutes(30),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": {
              nodejs: 20,
            },
            commands: ["node --version", "npm ci"],
          },
          build: {
            commands: [
              'echo "CDK Deployment..."',
              "npx cdk deploy ${APP_STACK_NAME} --require-approval never",
            ],
          },
        },
        artifacts: {
          files: ["**/*"],
        },
      }),
    });

    // Pour un lab/démo : on autorise large. En prod, on restreindrait au nécessaire.
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["*"],
        resources: ["*"],
      })
    );

    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: "fastapi-cicd",
      restartExecutionOnUpdate: true,
    });

    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.CodeStarConnectionsSourceAction({
          actionName: "GitHub_Source",
          owner: props.githubOwner,
          repo: props.githubRepo,
          branch: props.githubBranch ?? "main",
          connectionArn: props.githubConnectionArn,
          output: sourceOutput,
          triggerOnPush: true,
        }),
      ],
    });

    pipeline.addStage({
      stageName: "BuildAndDeploy",
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: "Build_Deploy",
          project: buildProject,
          input: sourceOutput,
        }),
      ],
    });
  }
}

