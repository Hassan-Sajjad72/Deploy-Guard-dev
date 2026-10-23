# DeployGuard

**Cloud-Native Repository Scanning & Deployment Orchestration Platform**

---

## Quick Start (Local)

```bash
cd deployguard
nano backend/.env                        # add DB, JWT, GitHub OAuth, AWS keys
bash scripts/deploy-local.sh            # builds and starts everything
```

| Service      | URL                            |
|--------------|-------------------------------|
| Frontend     | http://localhost:3000          |
| Backend API  | http://localhost:3001          |
| Swagger Docs | http://localhost:3001/api/docs |
| Prometheus   | http://localhost:9090          |

---

## Prerequisites

### Node.js >= 18
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Docker
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

### Terraform >= 1.5
```bash
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install -y terraform
```

### AWS CLI v2
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip awscliv2.zip && sudo ./aws/install
aws configure    # enter Access Key, Secret, Region, Output format
```

---

## Configure .env

Edit `backend/.env` – the required fields:

| Variable              | Description                         |
|-----------------------|-------------------------------------|
| `DB_PASSWORD`         | PostgreSQL password                 |
| `JWT_SECRET`          | Random string >= 32 chars           |
| `GITHUB_CLIENT_ID`    | GitHub OAuth App Client ID          |
| `GITHUB_CLIENT_SECRET`| GitHub OAuth App Secret             |
| `AWS_ACCESS_KEY_ID`   | AWS Access Key                      |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Key                    |

**GitHub OAuth App**: https://github.com/settings/developers → New OAuth App  
Callback URL: `http://localhost:3001/api/v1/auth/github/callback`

---

## Deployment Modes

| Mode       | Description                                       |
|------------|---------------------------------------------------|
| `single`   | Single stateless container + ALB + auto-scaling   |
| `multi`    | Multiple services with internal networking        |
| `database` | Containerized DB with EFS persistent storage      |

---

## AWS Deployment (Terraform)

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars          # set your values

terraform init
terraform plan
terraform apply

terraform output               # view ALB URL, ECR repo, etc.
terraform destroy              # tear everything down
```

### GitHub Actions CI/CD

Add repository secrets (`Settings → Secrets → Actions`):

| Secret                  | Value                          |
|-------------------------|-------------------------------|
| `AWS_ACCESS_KEY_ID`     | Your AWS Access Key            |
| `AWS_SECRET_ACCESS_KEY` | Your AWS Secret Key            |
| `AWS_REGION`            | `us-east-1`                    |
| `ECR_REGISTRY`          | `123...dkr.ecr.us-east-1...`   |
| `ECS_CLUSTER`           | `deployguard-cluster`          |

---

## Troubleshooting

**Services won't start:**
```bash
docker compose logs backend
docker compose logs postgres
docker compose restart backend
```

**Terraform state lock:**
```bash
terraform force-unlock <LOCK_ID>
```

**ECR auth fails:**
```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    $(aws sts get-caller-identity --query Account --output text).dkr.ecr.us-east-1.amazonaws.com
```

**ECS task not starting:**
```bash
aws ecs describe-tasks --cluster deployguard-cluster \
  --tasks $(aws ecs list-tasks --cluster deployguard-cluster --query 'taskArns[0]' --output text)
```

---

## License

MIT © DeployGuard
