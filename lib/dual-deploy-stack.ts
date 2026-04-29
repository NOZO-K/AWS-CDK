import * as path from "path";
import { Duration, Stack, StackProps, CfnOutput, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";

export interface DualDeployStackProps extends StackProps {
  /**
   * ARN du certificat ACM pour activer le listener HTTPS sur le port 443.
   * Si non fourni, le stack ne crée que le listener HTTP.
   */
  httpsCertificateArn?: string;
}

export class DualDeployStack extends Stack {
  constructor(scope: Construct, id: string, props?: DualDeployStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "AppVpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "PrivateApp",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const uploadsBucket = new s3.Bucket(this, "UploadsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc,
      description: "Allow inbound internet traffic to ALB only",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Allow HTTP from internet");
    if (props?.httpsCertificateArn) {
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Allow HTTPS from internet");
    }

    const appSg = new ec2.SecurityGroup(this, "AppSg", {
      vpc,
      description: "Allow only ALB to reach application",
      allowAllOutbound: true,
    });
    appSg.addIngressRule(albSg, ec2.Port.tcp(8000), "Allow traffic from ALB only");

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const appContainer = taskDefinition.addContainer("FastApiContainer", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, ".."), {
        platform: Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "fastapi-ecs",
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        STORAGE_BACKEND: "s3",
        S3_BUCKET: uploadsBucket.bucketName,
      },
    });
    appContainer.addPortMappings({ containerPort: 8000 });

    const fargateService = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      loadBalancerName: "stratocore-case-milo-k",
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      open: false,
    });
    listener.connections.allowDefaultPortFrom(ec2.Peer.anyIpv4(), "Internet to ALB");

    const ecsHealthCheck = {
      path: "/health",
      healthyHttpCodes: "200",
    };

    listener.addTargets("EcsTargets", {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [fargateService],
      healthCheck: ecsHealthCheck,
    });

    if (props?.httpsCertificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        "HttpsCertificate",
        props.httpsCertificateArn
      );

      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        open: false,
      });
      httpsListener.connections.allowDefaultPortFrom(
        ec2.Peer.anyIpv4(),
        "Internet to ALB HTTPS"
      );

      httpsListener.addTargets("EcsTargetsHttps", {
        port: 8000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [fargateService],
        healthCheck: ecsHealthCheck,
      });
    }

    uploadsBucket.grantReadWrite(taskDefinition.taskRole);

    const serverlessApiFn = new PythonFunction(this, "ServerlessFastApiFunction", {
      entry: path.join(__dirname, "..", "app"),
      index: "lambda_handler.py",
      handler: "handler",
      runtime: lambda.Runtime.PYTHON_3_11,
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        STORAGE_BACKEND: "s3",
        S3_BUCKET: uploadsBucket.bucketName,
      },
    });
    uploadsBucket.grantReadWrite(serverlessApiFn);

    const httpApi = new apigwv2.HttpApi(this, "ServerlessHttpApi", {
      defaultIntegration: new HttpLambdaIntegration("FastApiLambdaIntegration", serverlessApiFn),
      createDefaultStage: true,
    });

    new CfnOutput(this, "AlbUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "Public URL (HTTP) for ECS/Fargate deployment behind ALB",
    });

    if (props?.httpsCertificateArn) {
      new CfnOutput(this, "AlbUrlHttps", {
        value: `https://${alb.loadBalancerDnsName}`,
        description: "Public URL (HTTPS) for ECS/Fargate deployment behind ALB",
      });
    }

    new CfnOutput(this, "ServerlessApiUrl", {
      value: httpApi.apiEndpoint,
      description: "Public URL for serverless API (API Gateway + Lambda)",
    });

    new CfnOutput(this, "UploadsBucketName", {
      value: uploadsBucket.bucketName,
      description: "S3 bucket used as persistent storage for uploaded files",
    });
  }
}
