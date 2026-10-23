#!/usr/bin/env bash
# AWS account-wide cost cleanup for Deploy Guard leftovers.
# Default: inventory only.
#
# Inventory:
#   AWS_PROFILE=default ./aws-deployguard-cleanup.sh
#
# Destructive cleanup:
#   AWS_PROFILE=default MODE=delete CONFIRM_ACCOUNT_ID=123456789012 \
#     DELETE_S3=0 DELETE_SECRETS=1 ./aws-deployguard-cleanup.sh
#
# Set DELETE_S3=1 only when every S3 object/version may be permanently removed.
# IAM users/roles, Route 53 domains, CloudTrail, AWS Organizations, and default
# VPC components are intentionally not deleted.

set -uo pipefail

MODE="${MODE:-report}"
DELETE_S3="${DELETE_S3:-0}"
DELETE_SECRETS="${DELETE_SECRETS:-1}"
DELETE_CLOUDFORMATION="${DELETE_CLOUDFORMATION:-1}"
CONFIRM_ACCOUNT_ID="${CONFIRM_ACCOUNT_ID:-}"

AWS=(aws --no-cli-pager)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS+=(--profile "$AWS_PROFILE")
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need aws
need jq

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
log_file="aws-deployguard-cleanup-${timestamp}.log"
exec > >(tee -a "$log_file") 2>&1

awsq() {
  "${AWS[@]}" "$@"
}

try() {
  echo "+ $*"
  "$@" || echo "WARN: command failed; continue and inspect the final inventory."
}

ACCOUNT_ID="$(awsq sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(awsq sts get-caller-identity --query Arn --output text)"

echo "AWS account : $ACCOUNT_ID"
echo "Caller      : $CALLER_ARN"
echo "Mode        : $MODE"
echo "Log         : $log_file"
echo

REGIONS="$(awsq ec2 describe-regions --all-regions \
  --query 'Regions[?OptInStatus==`opt-in-not-required` || OptInStatus==`opted-in`].RegionName' \
  --output text)"

inventory_region() {
  local r="$1"
  echo
  echo "===== REGION: $r ====="

  echo "-- CloudFormation stacks"
  awsq cloudformation describe-stacks --region "$r" \
    --query 'Stacks[].[StackName,StackStatus]' --output table 2>/dev/null || true

  echo "-- ECS clusters"
  awsq ecs list-clusters --region "$r" --query 'clusterArns[]' --output text 2>/dev/null || true

  echo "-- EKS clusters"
  awsq eks list-clusters --region "$r" --query 'clusters[]' --output text 2>/dev/null || true

  echo "-- Load balancers"
  awsq elbv2 describe-load-balancers --region "$r" \
    --query 'LoadBalancers[].[LoadBalancerName,Type,State.Code,VpcId]' --output table 2>/dev/null || true

  echo "-- NAT gateways"
  awsq ec2 describe-nat-gateways --region "$r" \
    --filter Name=state,Values=pending,available,deleting,failed \
    --query 'NatGateways[].[NatGatewayId,State,VpcId,SubnetId]' --output table 2>/dev/null || true

  echo "-- VPC endpoints"
  awsq ec2 describe-vpc-endpoints --region "$r" \
    --query 'VpcEndpoints[].[VpcEndpointId,VpcEndpointType,ServiceName,State]' --output table 2>/dev/null || true

  echo "-- Auto Scaling groups"
  awsq autoscaling describe-auto-scaling-groups --region "$r" \
    --query 'AutoScalingGroups[].[AutoScalingGroupName,DesiredCapacity,MinSize,MaxSize]' --output table 2>/dev/null || true

  echo "-- EC2 instances"
  awsq ec2 describe-instances --region "$r" \
    --filters Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,VpcId]' --output table 2>/dev/null || true

  echo "-- Elastic IPs"
  awsq ec2 describe-addresses --region "$r" \
    --query 'Addresses[].[AllocationId,PublicIp,AssociationId,NetworkInterfaceId]' --output table 2>/dev/null || true

  echo "-- EBS volumes"
  awsq ec2 describe-volumes --region "$r" \
    --query 'Volumes[].[VolumeId,State,Size,VolumeType]' --output table 2>/dev/null || true

  echo "-- RDS instances"
  awsq rds describe-db-instances --region "$r" \
    --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus,Engine,DBInstanceClass,DeletionProtection]' \
    --output table 2>/dev/null || true

  echo "-- RDS clusters"
  awsq rds describe-db-clusters --region "$r" \
    --query 'DBClusters[].[DBClusterIdentifier,Status,Engine,DeletionProtection]' \
    --output table 2>/dev/null || true

  echo "-- EFS file systems"
  awsq efs describe-file-systems --region "$r" \
    --query 'FileSystems[].[FileSystemId,LifeCycleState,SizeInBytes.Value,Encrypted]' \
    --output table 2>/dev/null || true

  echo "-- ECR repositories"
  awsq ecr describe-repositories --region "$r" \
    --query 'repositories[].repositoryName' --output text 2>/dev/null || true

  echo "-- DynamoDB tables"
  awsq dynamodb list-tables --region "$r" --query 'TableNames[]' --output text 2>/dev/null || true

  echo "-- Lambda functions"
  awsq lambda list-functions --region "$r" \
    --query 'Functions[].FunctionName' --output text 2>/dev/null || true

  echo "-- CloudWatch log groups"
  awsq logs describe-log-groups --region "$r" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null || true

  echo "-- Secrets Manager secrets"
  awsq secretsmanager list-secrets --region "$r" \
    --query 'SecretList[?DeletedDate==`null`].Name' --output text 2>/dev/null || true
}

echo "Creating AWS-side inventory..."
for region in $REGIONS; do
  inventory_region "$region"
done

echo
echo "===== GLOBAL S3 BUCKETS ====="
awsq s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null || true

if [[ "$MODE" != "delete" ]]; then
  echo
  echo "Inventory only. No resources were deleted."
  echo "Review: $log_file"
  echo "To delete, rerun with MODE=delete and CONFIRM_ACCOUNT_ID=$ACCOUNT_ID"
  exit 0
fi

if [[ "$CONFIRM_ACCOUNT_ID" != "$ACCOUNT_ID" ]]; then
  echo "Refusing deletion: CONFIRM_ACCOUNT_ID must exactly equal $ACCOUNT_ID" >&2
  exit 2
fi

echo
echo "DESTRUCTIVE MODE CONFIRMED FOR ACCOUNT $ACCOUNT_ID"
echo

delete_cloudformation() {
  local r="$1" stack
  [[ "$DELETE_CLOUDFORMATION" == "1" ]] || return 0
  for stack in $(awsq cloudformation describe-stacks --region "$r" \
      --query 'Stacks[].StackName' --output text 2>/dev/null || true); do
    try awsq cloudformation delete-stack --region "$r" --stack-name "$stack"
    try awsq cloudformation wait stack-delete-complete --region "$r" --stack-name "$stack"
  done
}

delete_eks() {
  local r="$1" cluster nodegroup profile
  for cluster in $(awsq eks list-clusters --region "$r" --query 'clusters[]' --output text 2>/dev/null || true); do
    for nodegroup in $(awsq eks list-nodegroups --region "$r" --cluster-name "$cluster" \
        --query 'nodegroups[]' --output text 2>/dev/null || true); do
      try awsq eks delete-nodegroup --region "$r" --cluster-name "$cluster" --nodegroup-name "$nodegroup"
    done
    for profile in $(awsq eks list-fargate-profiles --region "$r" --cluster-name "$cluster" \
        --query 'fargateProfileNames[]' --output text 2>/dev/null || true); do
      try awsq eks delete-fargate-profile --region "$r" --cluster-name "$cluster" --fargate-profile-name "$profile"
    done
    try awsq eks delete-cluster --region "$r" --name "$cluster"
  done
}

delete_ecs() {
  local r="$1" cluster service task
  for cluster in $(awsq ecs list-clusters --region "$r" --query 'clusterArns[]' --output text 2>/dev/null || true); do
    for service in $(awsq ecs list-services --region "$r" --cluster "$cluster" \
        --query 'serviceArns[]' --output text 2>/dev/null || true); do
      try awsq ecs delete-service --region "$r" --cluster "$cluster" --service "$service" --force
    done
    for task in $(awsq ecs list-tasks --region "$r" --cluster "$cluster" \
        --desired-status RUNNING --query 'taskArns[]' --output text 2>/dev/null || true); do
      try awsq ecs stop-task --region "$r" --cluster "$cluster" --task "$task" \
        --reason "Account-wide cost cleanup"
    done
    try awsq ecs delete-cluster --region "$r" --cluster "$cluster"
  done
}

delete_autoscaling_and_ec2() {
  local r="$1" asg ids
  for asg in $(awsq autoscaling describe-auto-scaling-groups --region "$r" \
      --query 'AutoScalingGroups[].AutoScalingGroupName' --output text 2>/dev/null || true); do
    try awsq autoscaling update-auto-scaling-group --region "$r" \
      --auto-scaling-group-name "$asg" --min-size 0 --max-size 0 --desired-capacity 0
    try awsq autoscaling delete-auto-scaling-group --region "$r" \
      --auto-scaling-group-name "$asg" --force-delete
  done

  ids="$(awsq ec2 describe-instances --region "$r" \
    --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)"
  if [[ -n "$ids" && "$ids" != "None" ]]; then
    try awsq ec2 terminate-instances --region "$r" --instance-ids $ids
  fi
}

delete_load_balancers() {
  local r="$1" arn name tg
  for arn in $(awsq elbv2 describe-load-balancers --region "$r" \
      --query 'LoadBalancers[].LoadBalancerArn' --output text 2>/dev/null || true); do
    try awsq elbv2 modify-load-balancer-attributes --region "$r" \
      --load-balancer-arn "$arn" \
      --attributes Key=deletion_protection.enabled,Value=false
    try awsq elbv2 delete-load-balancer --region "$r" --load-balancer-arn "$arn"
  done

  for name in $(awsq elb describe-load-balancers --region "$r" \
      --query 'LoadBalancerDescriptions[].LoadBalancerName' --output text 2>/dev/null || true); do
    try awsq elb delete-load-balancer --region "$r" --load-balancer-name "$name"
  done

  for tg in $(awsq elbv2 describe-target-groups --region "$r" \
      --query 'TargetGroups[].TargetGroupArn' --output text 2>/dev/null || true); do
    try awsq elbv2 delete-target-group --region "$r" --target-group-arn "$tg"
  done
}

delete_network_costs() {
  local r="$1" nat endpoint alloc ids
  for nat in $(awsq ec2 describe-nat-gateways --region "$r" \
      --filter Name=state,Values=pending,available,failed \
      --query 'NatGateways[].NatGatewayId' --output text 2>/dev/null || true); do
    try awsq ec2 delete-nat-gateway --region "$r" --nat-gateway-id "$nat"
  done

  ids="$(awsq ec2 describe-vpc-endpoints --region "$r" \
    --query 'VpcEndpoints[].VpcEndpointId' --output text 2>/dev/null || true)"
  if [[ -n "$ids" && "$ids" != "None" ]]; then
    try awsq ec2 delete-vpc-endpoints --region "$r" --vpc-endpoint-ids $ids
  fi

  for alloc in $(awsq ec2 describe-addresses --region "$r" \
      --query 'Addresses[?AssociationId==`null`].AllocationId' --output text 2>/dev/null || true); do
    try awsq ec2 release-address --region "$r" --allocation-id "$alloc"
  done
}

delete_rds() {
  local r="$1" db cluster
  for db in $(awsq rds describe-db-instances --region "$r" \
      --query 'DBInstances[?DBInstanceStatus!=`deleting`].DBInstanceIdentifier' \
      --output text 2>/dev/null || true); do
    try awsq rds modify-db-instance --region "$r" \
      --db-instance-identifier "$db" --no-deletion-protection --apply-immediately
    try awsq rds delete-db-instance --region "$r" \
      --db-instance-identifier "$db" --skip-final-snapshot --delete-automated-backups
  done

  for cluster in $(awsq rds describe-db-clusters --region "$r" \
      --query 'DBClusters[?Status!=`deleting`].DBClusterIdentifier' \
      --output text 2>/dev/null || true); do
    try awsq rds modify-db-cluster --region "$r" \
      --db-cluster-identifier "$cluster" --no-deletion-protection --apply-immediately
    try awsq rds delete-db-cluster --region "$r" \
      --db-cluster-identifier "$cluster" --skip-final-snapshot
  done
}

delete_efs() {
  local r="$1" fs ap mt
  for fs in $(awsq efs describe-file-systems --region "$r" \
      --query 'FileSystems[].FileSystemId' --output text 2>/dev/null || true); do
    for ap in $(awsq efs describe-access-points --region "$r" --file-system-id "$fs" \
        --query 'AccessPoints[].AccessPointId' --output text 2>/dev/null || true); do
      try awsq efs delete-access-point --region "$r" --access-point-id "$ap"
    done
    for mt in $(awsq efs describe-mount-targets --region "$r" --file-system-id "$fs" \
        --query 'MountTargets[].MountTargetId' --output text 2>/dev/null || true); do
      try awsq efs delete-mount-target --region "$r" --mount-target-id "$mt"
    done
    try awsq efs delete-file-system --region "$r" --file-system-id "$fs"
  done
}

delete_ecr_dynamodb_lambda_logs() {
  local r="$1" repo table fn lg queue
  for repo in $(awsq ecr describe-repositories --region "$r" \
      --query 'repositories[].repositoryName' --output text 2>/dev/null || true); do
    try awsq ecr delete-repository --region "$r" --repository-name "$repo" --force
  done

  for table in $(awsq dynamodb list-tables --region "$r" \
      --query 'TableNames[]' --output text 2>/dev/null || true); do
    try awsq dynamodb delete-table --region "$r" --table-name "$table"
  done

  for fn in $(awsq lambda list-functions --region "$r" \
      --query 'Functions[].FunctionName' --output text 2>/dev/null || true); do
    try awsq lambda delete-function --region "$r" --function-name "$fn"
  done

  while IFS= read -r lg; do
    [[ -z "$lg" ]] && continue
    try awsq logs delete-log-group --region "$r" --log-group-name "$lg"
  done < <(awsq logs describe-log-groups --region "$r" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null | tr '\t' '\n')

  for queue in $(awsq sqs list-queues --region "$r" \
      --query 'QueueUrls[]' --output text 2>/dev/null || true); do
    try awsq sqs delete-queue --region "$r" --queue-url "$queue"
  done
}

delete_storage_leftovers() {
  local r="$1" image snapshot volume alloc
  for image in $(awsq ec2 describe-images --region "$r" --owners self \
      --query 'Images[].ImageId' --output text 2>/dev/null || true); do
    try awsq ec2 deregister-image --region "$r" --image-id "$image"
  done

  for snapshot in $(awsq ec2 describe-snapshots --region "$r" --owner-ids self \
      --query 'Snapshots[].SnapshotId' --output text 2>/dev/null || true); do
    try awsq ec2 delete-snapshot --region "$r" --snapshot-id "$snapshot"
  done

  for volume in $(awsq ec2 describe-volumes --region "$r" \
      --filters Name=status,Values=available \
      --query 'Volumes[].VolumeId' --output text 2>/dev/null || true); do
    try awsq ec2 delete-volume --region "$r" --volume-id "$volume"
  done

  for alloc in $(awsq ec2 describe-addresses --region "$r" \
      --query 'Addresses[?AssociationId==`null`].AllocationId' --output text 2>/dev/null || true); do
    try awsq ec2 release-address --region "$r" --allocation-id "$alloc"
  done
}

delete_secrets() {
  local r="$1" arn
  [[ "$DELETE_SECRETS" == "1" ]] || return 0
  for arn in $(awsq secretsmanager list-secrets --region "$r" \
      --query 'SecretList[?DeletedDate==`null`].ARN' --output text 2>/dev/null || true); do
    try awsq secretsmanager delete-secret --region "$r" \
      --secret-id "$arn" --force-delete-without-recovery
  done
}

bucket_region() {
  local b="$1" loc
  loc="$(awsq s3api get-bucket-location --bucket "$b" \
    --query LocationConstraint --output text 2>/dev/null || true)"
  case "$loc" in
    None|null|"") echo "us-east-1" ;;
    EU) echo "eu-west-1" ;;
    *) echo "$loc" ;;
  esac
}

delete_bucket_all_versions() {
  local b="$1" br="$2" data payload count uploads key upload_id

  echo "Deleting every object/version from s3://$b in $br"

  while true; do
    data="$(awsq s3api list-object-versions --region "$br" --bucket "$b" \
      --max-items 1000 --output json 2>/dev/null || true)"
    [[ -z "$data" ]] && break
    payload="$(jq -c \
      '{Objects: ([.Versions[]?, .DeleteMarkers[]?] | map({Key:.Key,VersionId:.VersionId})), Quiet:true}' \
      <<<"$data")"
    count="$(jq '.Objects | length' <<<"$payload")"
    [[ "$count" -eq 0 ]] && break
    if ! awsq s3api delete-objects --region "$br" --bucket "$b" --delete "$payload" >/dev/null; then
      echo "WARN: could not delete all versions from $b; Object Lock or permissions may block deletion."
      break
    fi
  done

  uploads="$(awsq s3api list-multipart-uploads --region "$br" --bucket "$b" \
    --output json 2>/dev/null || true)"
  if [[ -n "$uploads" ]]; then
    while IFS=$'\t' read -r key upload_id; do
      [[ -z "$key" || -z "$upload_id" ]] && continue
      try awsq s3api abort-multipart-upload --region "$br" --bucket "$b" \
        --key "$key" --upload-id "$upload_id"
    done < <(jq -r '.Uploads[]? | [.Key,.UploadId] | @tsv' <<<"$uploads")
  fi

  try awsq s3api delete-bucket --region "$br" --bucket "$b"
}

delete_s3() {
  local b br
  [[ "$DELETE_S3" == "1" ]] || {
    echo "Skipping S3 deletion because DELETE_S3=$DELETE_S3"
    return 0
  }

  for b in $(awsq s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null || true); do
    br="$(bucket_region "$b")"
    delete_bucket_all_versions "$b" "$br"
  done
}

for region in $REGIONS; do
  echo
  echo "===== DELETING REGION: $region ====="
  delete_cloudformation "$region"
  delete_eks "$region"
  delete_ecs "$region"
  delete_autoscaling_and_ec2 "$region"
  delete_load_balancers "$region"
  delete_network_costs "$region"
  delete_rds "$region"
  delete_efs "$region"
  delete_ecr_dynamodb_lambda_logs "$region"
  delete_storage_leftovers "$region"
  delete_secrets "$region"
done

delete_s3

echo
echo "===== FINAL INVENTORY ====="
for region in $REGIONS; do
  inventory_region "$region"
done

echo
echo "Cleanup commands completed. Review failures in: $log_file"
echo "Rerunning the same command is safe for resources still transitioning or blocked by dependencies."
