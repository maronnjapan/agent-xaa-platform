IMAGE_TAG ?= $(shell git rev-parse --short HEAD)
REGISTRY ?= xaa

.PHONY: install typecheck lint test test-integration images ci bootstrap state-bucket adopt-kms shared-apply ensure-secrets demo-apply seed verify purge-runtime demo-destroy destroy-all all
install:
	pnpm install --frozen-lockfile
typecheck:
	pnpm typecheck
lint:
	pnpm lint
test:
	pnpm test:unit
test-integration:
	pnpm test:integration
images:
	REGISTRY=$(REGISTRY) IMAGE_TAG=$(IMAGE_TAG) DRY_RUN=$(DRY_RUN) bash scripts/build-images.sh
image-%:
	docker build --build-arg APP=$* -t $(REGISTRY)/$*:$(IMAGE_TAG) .
	docker push $(REGISTRY)/$*:$(IMAGE_TAG)
ci: typecheck lint test test-integration

# --- infra targets (T-IAC) ---
TF ?= mise exec terraform@1.9.8 -- terraform
PROJECT_ID ?=
REGION ?= asia-northeast1
DEMO_TFVARS ?= infra/tfvars/demo.tfvars

bootstrap:
	@echo "Create the versioned Terraform state bucket in the one existing GCP project"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	$(TF) -chdir=infra/bootstrap init -input=false
	$(TF) -chdir=infra/bootstrap apply -input=false -auto-approve -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)"

# bootstrap keeps its state on the machine that ran it, so an unattended deploy cannot
# tell an existing bucket from a missing one by looking at state. It asks GCP instead,
# which also lets a deploy follow a destroy-all without a manual step in between.
state-bucket:
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	@if gcloud storage buckets describe "gs://$(PROJECT_ID)-tfstate" >/dev/null 2>&1; then \
		echo "gs://$(PROJECT_ID)-tfstate already exists"; \
	else \
		$(MAKE) bootstrap PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"; \
	fi

adopt-kms:
	@echo "Import the KMS rings and keys the project already holds, which GCP will not let apply recreate"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" TF="$(TF)" bash scripts/adopt-existing-kms.sh

shared-apply:
	@echo "Apply APIs, KMS, Artifact Registry, Secret Manager, and the audit dataset"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	$(TF) -chdir=infra/envs/shared init -input=false -reconfigure -backend-config="bucket=$(PROJECT_ID)-tfstate"
	$(TF) -chdir=infra/envs/shared apply -input=false -auto-approve -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)"

ensure-secrets:
	@echo "Give every Secret Manager container Cloud Run mounts a version, without printing one"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	PROJECT_ID="$(PROJECT_ID)" bash scripts/ensure-secret-versions.sh

demo-apply:
	@echo "Apply the demo services, jobs, IAM, Firestore, Pub/Sub, and Scheduler, then verify IAM reachability"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	@test -f "$(DEMO_TFVARS)" || { echo "Create $(DEMO_TFVARS) from infra/tfvars/demo.tfvars.example" >&2; exit 2; }
	$(TF) -chdir=infra/envs/demo init -input=false -reconfigure -backend-config="bucket=$(PROJECT_ID)-tfstate"
	$(TF) -chdir=infra/envs/demo apply -input=false -auto-approve -var-file="../../../$(DEMO_TFVARS)" -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)" -var="image_tag=$(IMAGE_TAG)"
	$(MAKE) verify PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"

seed:
	@echo "Publish the aggregate JWKS first, then replace seed-owned Firestore definition data"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	gcloud run jobs execute jwks-publish --project="$(PROJECT_ID)" --region="$(REGION)" --wait
	gcloud run jobs execute seed --project="$(PROJECT_ID)" --region="$(REGION)" --wait

verify:
	@echo "Measure allowed and denied Cloud Run edges, forbidden roles, and the invoker matrix"
	PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" bash infra/tests/verify-all.sh

purge-runtime:
	@echo "Delete runtime-owned Dedicated OP services, jobs, service accounts, and key versions"
	PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" bash scripts/purge-runtime-resources.sh

demo-destroy:
	@echo "Purge runtime-owned resources before destroying the Terraform-managed demo state"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	$(MAKE) purge-runtime PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
	$(TF) -chdir=infra/envs/demo destroy -input=false -auto-approve -var-file="../../../$(DEMO_TFVARS)" -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)" -var="image_tag=$(IMAGE_TAG)"

DELETE_STATE_BUCKET ?= 1
# Irreversible, and off by default: see the comment in scripts/destroy-all-resources.sh.
DESTROY_KMS_KEY_VERSIONS ?= 0

destroy-all:
	@echo "Delete every resource this repository creates in the project and leave only the project"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" TF="$(TF)" DEMO_TFVARS="$(DEMO_TFVARS)" \
	IMAGE_TAG="$(IMAGE_TAG)" DELETE_STATE_BUCKET="$(DELETE_STATE_BUCKET)" \
	DESTROY_KMS_KEY_VERSIONS="$(DESTROY_KMS_KEY_VERSIONS)" bash scripts/destroy-all-resources.sh

# The same sequence the deploy workflow runs, so a merge to main and a local run of this
# do the same thing. state-bucket, adopt-kms, and ensure-secrets are no-ops on a project
# that already has all three; they are what makes a run after destroy-all work.
all:
	@echo "Apply shared state, build immutable images, apply and verify demo state, then seed definition data"
	$(MAKE) state-bucket PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
	$(MAKE) adopt-kms PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
	$(MAKE) shared-apply PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
	$(MAKE) ensure-secrets PROJECT_ID="$(PROJECT_ID)"
	$(MAKE) images REGISTRY="$(REGION)-docker.pkg.dev/$(PROJECT_ID)/xaa"
	$(MAKE) demo-apply PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" DEMO_TFVARS="$(DEMO_TFVARS)"
	$(MAKE) seed PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
