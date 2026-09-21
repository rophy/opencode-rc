.PHONY: help unit-test up e2e-test down

# e2e config
E2E_CLUSTER := opencode-rc-e2e
E2E_NS      := default
COVER_DIR   := .cover
KUBECTL     := kubectl --context kind-$(E2E_CLUSTER) -n $(E2E_NS)

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

unit-test: ## Run unit tests for all packages with coverage
	@echo "=== Gateway (Go) ==="
	@cd gateway && go test -cover ./...
	@echo ""
	@echo "=== Web (TypeScript) ==="
	@cd web && npx vitest run --coverage
	@echo ""
	@echo "=== CLI (TypeScript) ==="
	@cd cli && npx vitest run --coverage
	@echo ""
	@echo "=== UI (SolidJS) ==="
	@cd ui && npx vitest run --coverage

up: ## Create kind cluster and deploy e2e environment
	@echo "=== Creating kind cluster ==="
	@if kind get clusters 2>/dev/null | grep -q "^$(E2E_CLUSTER)$$"; then \
		echo "Cluster $(E2E_CLUSTER) already exists"; \
		kubectl config use-context "kind-$(E2E_CLUSTER)"; \
	else \
		kind create cluster --config e2e/kind-config.yaml; \
	fi
	@echo ""
	@echo "=== Building and deploying ==="
	cd e2e && skaffold run -n $(E2E_NS)
	@echo ""
	@echo "=== Waiting for services ==="
	@$(KUBECTL) wait --for=condition=Available deployment/opencode-rc-web --timeout=120s
	@$(KUBECTL) wait --for=condition=Available deployment/dev-machine --timeout=120s
	@DEV_POD=$$($(KUBECTL) get pod -l app=dev-machine -o jsonpath='{.items[0].metadata.name}'); \
	echo "Waiting for tunnel..."; \
	for i in $$(seq 1 60); do \
		if $(KUBECTL) exec "$$DEV_POD" -- curl -sf http://opencode-rc-web:8080/healthz >/dev/null 2>&1; then \
			echo "Web server reachable from dev-machine"; \
			break; \
		fi; \
		if [ "$$i" -eq 60 ]; then \
			echo "ERROR: web server not reachable after 60 attempts"; \
			$(KUBECTL) logs deployment/opencode-rc-web --tail=30; \
			$(KUBECTL) logs deployment/dev-machine --tail=30; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	@echo ""
	@echo "=== Cluster ready ==="

e2e-test: ## Run e2e tests (vitest + playwright + coverage)
	@echo "=== Running vitest e2e tests ==="
	@DEV_POD=$$($(KUBECTL) get pod -l app=dev-machine -o jsonpath='{.items[0].metadata.name}'); \
	TEST_EXIT=0; \
	$(KUBECTL) exec "$$DEV_POD" -- sh -c \
		"cd /e2e && WEB_URL=http://opencode-rc-web:8080 GATEWAY_URL=http://opencode-rc-gateway:9090 OIDC_URL=http://opencode-rc-oidc-mock:8080 npx vitest run" || TEST_EXIT=$$?; \
	echo ""; \
	echo "=== Running playwright e2e tests ==="; \
	$(KUBECTL) exec "$$DEV_POD" -- sh -c \
		"cd /e2e && WEB_URL=http://opencode-rc-web:8080 npx playwright test --config playwright.config.ts" || TEST_EXIT=$$?; \
	if [ "$$TEST_EXIT" -ne 0 ]; then \
		echo ""; \
		echo "=== Logs on failure ==="; \
		$(KUBECTL) logs deployment/opencode-rc-web --tail=50 || true; \
		$(KUBECTL) logs deployment/opencode-rc-gateway --tail=50 || true; \
		$(KUBECTL) logs deployment/dev-machine --tail=50 || true; \
	fi; \
	echo ""; \
	echo "=== Collecting coverage ==="; \
	rm -rf $(COVER_DIR); \
	mkdir -p $(COVER_DIR)/raw; \
	$(KUBECTL) exec "$$DEV_POD" -- \
		curl -sf http://opencode-rc-web:8080/debug/coverage > $(COVER_DIR)/raw/web.tar; \
	if [ -s $(COVER_DIR)/raw/web.tar ]; then \
		mkdir -p $(COVER_DIR)/raw/web; \
		tar xf $(COVER_DIR)/raw/web.tar -C $(COVER_DIR)/raw/web; \
		echo "Web coverage collected"; \
	else \
		echo "WARNING: No web coverage"; \
	fi; \
	$(KUBECTL) exec "$$DEV_POD" -- \
		curl -sf http://opencode-rc-gateway:9090/debug/coverage > $(COVER_DIR)/raw/gateway.tar; \
	if [ -s $(COVER_DIR)/raw/gateway.tar ]; then \
		mkdir -p $(COVER_DIR)/raw/gateway; \
		tar xf $(COVER_DIR)/raw/gateway.tar -C $(COVER_DIR)/raw/gateway; \
		echo "Gateway coverage collected"; \
	else \
		echo "WARNING: No gateway coverage"; \
	fi; \
	echo ""; \
	echo "=== Generating coverage report ==="; \
	mkdir -p $(COVER_DIR)/merged; \
	go tool covdata merge -i="$(COVER_DIR)/raw/web","$(COVER_DIR)/raw/gateway" -o="$(COVER_DIR)/merged"; \
	cd gateway && go tool covdata textfmt -i="../$(COVER_DIR)/merged" -o="../$(COVER_DIR)/coverage.out"; \
	go tool cover -func="../$(COVER_DIR)/coverage.out" | tail -1; \
	go tool cover -html="../$(COVER_DIR)/coverage.out" -o="../$(COVER_DIR)/coverage.html"; \
	echo ""; \
	echo "Coverage report: $(COVER_DIR)/coverage.html"; \
	echo "Coverage data:   $(COVER_DIR)/coverage.out"; \
	exit $$TEST_EXIT

down: ## Tear down e2e kind cluster
	cd e2e && skaffold delete -n $(E2E_NS) 2>/dev/null || true
	kind delete cluster --name $(E2E_CLUSTER) 2>/dev/null || true
