import { ConfigService } from "@nestjs/config";
import { resolve } from "path";

export type InfrastructureConfig = {
  awsRegion: string;
  terraformBin: string;
  terraformWorkingBaseDir: string;
  terraformNetworkTemplateDir: string;
  terraformAutoApprove: boolean;
  terraformApplyEnabled: boolean;
  defaultVpcCidr: string;
  publicSubnetCidrs: string[];
  privateSubnetCidrs: string[];
  singleNatGateway: boolean;
  cloudMapNamespace: string;
  enableHttps: boolean;
  defaultAppPort: number;
};

export function getInfrastructureConfig(config: ConfigService): InfrastructureConfig {
  return {
    awsRegion: config.get<string>("AWS_REGION", "us-east-1"),
    terraformBin: config.get<string>("TERRAFORM_BIN", "terraform"),
    terraformWorkingBaseDir: resolve(
      process.cwd(),
      config.get<string>("TERRAFORM_WORKING_BASE_DIR", "./.deployguard/terraform-workspaces")
    ),
    terraformNetworkTemplateDir: resolve(
      process.cwd(),
      config.get<string>("TERRAFORM_NETWORK_TEMPLATE_DIR", "terraform/base-network")
    ),
    terraformAutoApprove: config.get<string>("TERRAFORM_AUTO_APPROVE", "true") === "true",
    terraformApplyEnabled: config.get<string>("TERRAFORM_APPLY_ENABLED", "false") === "true",
    defaultVpcCidr: config.get<string>("DEPLOYGUARD_DEFAULT_VPC_CIDR", "10.0.0.0/16"),
    publicSubnetCidrs: splitCsv(
      config.get<string>("DEPLOYGUARD_PUBLIC_SUBNET_CIDRS", "10.0.1.0/24,10.0.2.0/24")
    ),
    privateSubnetCidrs: splitCsv(
      config.get<string>("DEPLOYGUARD_PRIVATE_SUBNET_CIDRS", "10.0.101.0/24,10.0.102.0/24")
    ),
    singleNatGateway: config.get<string>("DEPLOYGUARD_SINGLE_NAT_GATEWAY", "true") !== "false",
    cloudMapNamespace: config.get<string>("DEPLOYGUARD_CLOUDMAP_NAMESPACE", "deployguard.local"),
    enableHttps: config.get<string>("DEPLOYGUARD_ENABLE_HTTPS", "false") === "true",
    defaultAppPort: Number(config.get<string>("DEPLOYGUARD_DEFAULT_APP_PORT", "3000")),
  };
}

function splitCsv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
