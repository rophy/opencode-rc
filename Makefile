.PHONY: help unit-test check-context ns up e2e-test down

# e2e config. The cluster must already exist; these targets never create or delete clusters.
# KUBE_CONTEXT defaults to the current kubectl context and is resolved once, then passed
# explicitly to every command.
ifeq ($(origin KUBE_CONTEXT),undefined)
KUBE_CONTEXT := $(shell kubectl config current-context 2>/dev/null)
endif
NAMESPACE    ?= opencode-rc
NS_OWNER     := opencode-rc-e2e
NS_LABEL     := app.kubernetes.io/managed-by=$(NS_OWNER)
COVER_DIR    := .cover
KUBECTL      := kubectl --context $(KUBE_CONTEXT) -n $(NAMESPACE)
KUBECTL_CLUSTER := kubectl --context $(KUBE_CONTEXT)

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

unit-test: ## Run unit tests for all packages with coverage
	@echo "=== Gateway (Go) ==="
	@cd gateway && go test -cover ./...
	@echo ""
	@echo "=== API (TypeScript) ==="
	@cd api && npx vitest run --coverage
	@echo ""
	@echo "=== CLI (TypeScript) ==="
	@cd cli && npx vitest run --coverage
	@echo ""
	@echo "=== UI (SolidJS) ==="
	@cd ui && npx vitest run --coverage
	@echo ""
	@echo "=== Chart (helm unittest) ==="
	@helm unittest charts/opencode-rc

check-context:
	@if [ -z "$(KUBE_CONTEXT)" ]; then \
		echo "ERROR: no kubectl context. Set KUBE_CONTEXT=... or run 'kubectl config use-context ...'"; \
		exit 1; \
	fi
	@if ! kubectl config get-contexts -o name | grep -qx "$(KUBE_CONTEXT)"; then \
		echo "ERROR: kubectl context '$(KUBE_CONTEXT)' does not exist"; \
		exit 1; \
	fi
	@case "$(KUBE_CONTEXT)" in kind-*) ;; *) \
		echo "ERROR: '$(KUBE_CONTEXT)' is not a kind context; the e2e images are loaded with kind and never pushed"; \
		exit 1;; \
	esac
	@echo "Context: $(KUBE_CONTEXT)  Namespace: $(NAMESPACE)"

ns: check-context ## Create the e2e namespace (labeled as ours) and the dev-machine RoleBinding
	@if ! $(KUBECTL_CLUSTER) get namespace $(NAMESPACE) >/dev/null 2>&1; then \
		$(KUBECTL_CLUSTER) create namespace $(NAMESPACE) && \
		$(KUBECTL_CLUSTER) label namespace $(NAMESPACE) $(NS_LABEL); \
	fi
	@$(KUBECTL) create rolebinding dev-machine-admin --clusterrole=admin \
		--serviceaccount=$(NAMESPACE):dev-machine --dry-run=client -o yaml | $(KUBECTL) apply -f -

up: ns ## Deploy the e2e environment into NAMESPACE on an existing cluster
	@echo "=== Building and deploying ==="
	cd e2e && skaffold run --kube-context $(KUBE_CONTEXT) -n $(NAMESPACE)
	@echo ""
	@echo "=== Waiting for services ==="
	@$(KUBECTL) wait --for=condition=Available deployment/opencode-rc-api --timeout=120s
	@$(KUBECTL) wait --for=condition=Available deployment/opencode-rc-ui --timeout=120s
	@$(KUBECTL) wait --for=condition=Available deployment/dev-machine --timeout=120s
	@echo "Waiting for tunnel establishment..."
	@for i in $$(seq 1 120); do \
		if $(KUBECTL) logs deployment/dev-machine --tail=10 2>/dev/null | grep -q 'Session.*connected\|Tunnel established'; then \
			echo "Tunnel established"; \
			break; \
		fi; \
		if [ "$$i" -eq 120 ]; then \
			echo "ERROR: tunnel not established after 240s"; \
			$(KUBECTL) logs deployment/opencode-rc-api --tail=30; \
			$(KUBECTL) logs deployment/opencode-rc-ui --tail=30; \
			$(KUBECTL) logs deployment/opencode-rc-gateway --tail=30; \
			$(KUBECTL) logs deployment/dev-machine --tail=30; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	@echo ""
	@echo "=== Cluster ready ==="

# Coverage is collected from the Go gateway only; api is a Bun server covered by its vitest unit tests.
e2e-test: ## Run e2e tests (vitest + playwright + coverage)
	@echo "=== Running vitest e2e tests ==="
	@DEV_POD=$$($(KUBECTL) get pod -l app=dev-machine -o jsonpath='{.items[0].metadata.name}'); \
	TEST_EXIT=0; \
	$(KUBECTL) exec "$$DEV_POD" -- sh -c \
		"cd /e2e && NAMESPACE=$(NAMESPACE) API_URL=http://opencode-rc-api:8080 UI_URL=http://opencode-rc-ui:8080 GATEWAY_URL=http://opencode-rc-gateway:9090 OIDC_URL=http://opencode-rc-oidc-mock:8080 npx vitest run" || TEST_EXIT=$$?; \
	echo ""; \
	echo "=== Running playwright e2e tests ==="; \
	$(KUBECTL) exec "$$DEV_POD" -- sh -c \
		"cd /e2e && UI_URL=http://opencode-rc-ui:8080 npx playwright test --config playwright.config.ts" || TEST_EXIT=$$?; \
	if [ "$$TEST_EXIT" -ne 0 ]; then \
		echo ""; \
		echo "=== Logs on failure ==="; \
		$(KUBECTL) logs deployment/opencode-rc-api --tail=50 || true; \
		$(KUBECTL) logs deployment/opencode-rc-ui --tail=50 || true; \
		$(KUBECTL) logs deployment/opencode-rc-gateway --tail=50 || true; \
		$(KUBECTL) logs deployment/dev-machine --tail=50 || true; \
	fi; \
	echo ""; \
	echo "=== Collecting coverage ==="; \
	rm -rf $(COVER_DIR); \
	mkdir -p $(COVER_DIR)/raw; \
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
	if [ ! -d $(COVER_DIR)/raw/gateway ]; then \
		echo "WARNING: No coverage data collected"; \
		exit $$TEST_EXIT; \
	fi; \
	go tool covdata merge -i="$(COVER_DIR)/raw/gateway" -o="$(COVER_DIR)/merged"; \
	cd gateway && go tool covdata textfmt -i="../$(COVER_DIR)/merged" -o="../$(COVER_DIR)/coverage.out"; \
	go tool cover -func="../$(COVER_DIR)/coverage.out" | tail -1; \
	go tool cover -html="../$(COVER_DIR)/coverage.out" -o="../$(COVER_DIR)/coverage.html"; \
	echo ""; \
	echo "Coverage report: $(COVER_DIR)/coverage.html"; \
	echo "Coverage data:   $(COVER_DIR)/coverage.out"; \
	exit $$TEST_EXIT

# Deletes the namespace only if `make ns` created it; otherwise removes just what skaffold deployed.
down: check-context ## Tear down the e2e environment (never the cluster)
	@if ! $(KUBECTL_CLUSTER) get namespace $(NAMESPACE) >/dev/null 2>&1; then \
		echo "Namespace $(NAMESPACE) does not exist"; \
	elif [ "$$($(KUBECTL_CLUSTER) get namespace $(NAMESPACE) -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')" = "$(NS_OWNER)" ]; then \
		echo "Deleting namespace $(NAMESPACE)"; \
		$(KUBECTL_CLUSTER) delete namespace $(NAMESPACE) --wait; \
	else \
		echo "Namespace $(NAMESPACE) was not created by 'make ns'; removing only what skaffold deployed"; \
		cd e2e && skaffold delete --kube-context $(KUBE_CONTEXT) -n $(NAMESPACE); \
		$(KUBECTL) delete rolebinding dev-machine-admin --ignore-not-found; \
	fi
