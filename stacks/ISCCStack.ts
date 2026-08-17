import { StackContext, Service } from "sst/constructs";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
export async function IsccStack({ stack }: StackContext) {
  const service_isccDocker = new Service(stack, "isccDocker", {
    port: 8000,
    cdk: {
      container: {
        // Cast: two aws-cdk-lib versions resolve in this workspace (root
        // 2.124 vs SST-bundled), which only differ nominally for this type.
        image: ContainerImage.fromRegistry("ghcr.io/iscc/iscc-web:main") as any,
        cpu: 256,
        memoryLimitMiB: 512,
      },
    },
  });
  service_isccDocker.cdk?.cluster?.autoscalingGroup?.scaleOnIncomingBytes("IncomingBytesScaling", {
    targetBytesPerSecond: 1000,
  });
  service_isccDocker.cdk?.cluster?.autoscalingGroup?.scaleOnCpuUtilization("CpuScaling", {
    targetUtilizationPercent: 50,
  });

  stack.addOutputs({
    hostedISccDocker: service_isccDocker.cdk?.applicationLoadBalancer?.loadBalancerDnsName,
  });
}
