IMAGE_TAG ?= $(shell git rev-parse --short HEAD)
REGISTRY ?= xaa

.PHONY: install typecheck lint test test-integration images ci bootstrap shared-apply demo-apply seed verify purge-runtime demo-destroy all
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

shared-apply:
	@echo "Apply APIs, KMS, Artifact Registry, Secret Manager, and the audit dataset"
	@test -n "$(PROJECT_ID)" || { echo "PROJECT_ID is required" >&2; exit 2; }
	$(TF) -chdir=infra/envs/shared init -input=false -reconfigure -backend-config="bucket=$(PROJECT_ID)-tfstate"
	$(TF) -chdir=infra/envs/shared apply -input=false -auto-approve -var="project_id=$(PROJECT_ID)" -var="region=$(REGION)"

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

all:
	@echo "Apply shared state, build immutable images, apply and verify demo state, then seed definition data"
	$(MAKE) shared-apply PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
	$(MAKE) images REGISTRY="$(REGION)-docker.pkg.dev/$(PROJECT_ID)/xaa"
	$(MAKE) demo-apply PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)" DEMO_TFVARS="$(DEMO_TFVARS)"
	$(MAKE) seed PROJECT_ID="$(PROJECT_ID)" REGION="$(REGION)"
